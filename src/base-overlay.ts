import { setIcon, setTooltip } from 'obsidian'
import { getStroke } from 'perfect-freehand'
import { TrailEngine } from './trail-engine'
import { LASER_SWATCHES, resolveLaserColor, swatchNameOf } from './palette'
import type { TrailSessionOptions, TrailStroke } from './trail-engine'
import type { LaserHostContext } from './host'
import type { MdLaserPlugin } from './main'
import type { TrailPoint } from './types'

/** Input easing for perfect-freehand's stroke start (no shaping). */
const LINEAR = (t: number): number => t

/**
 * How aggressively perfect-freehand simplifies raw input into its outline.
 * 0.32 sits between raw input (0) and smooth tracking (0.5); the laser's
 * trails are quick flicks, so they need smoothing without much lag.
 */
const STREAMLINE = 0.32

/** Invalidate every cached outline once the whole cache grows past this. */
const CACHE_LIMIT = 400

interface OutlineStamp {
	stamp: string
	path: Path2D
}

/** Which trail the pointer is currently feeding. */
interface FeedState {
	sessionId: number
	strokeId: number
}

/**
 * Shared laser overlay machinery, one instance per editor surface (a
 * CodeMirror editor in source mode/Live Preview, or a markdown leaf's reading
 * view - reading mode has no CodeMirror, hence the separate host context).
 *
 * With the tool on, pointer drags feed a transient trail: strokes enqueue
 * points, the engine commits at tick cadence, and once a session stops every
 * stroke drains oldest-first with a grouped ease-in fade. Nothing is ever
 * written to the note; strokes live only in this overlay's engine and canvas.
 *
 * Geometry: the canvas covers the host's viewport box, while trail points are
 * recorded in the content element's coordinate space (which scrolls with the
 * text). Each frame is drawn translated by the content's current offset, so
 * trails stay glued to the text while scrolling and the canvas always sits
 * under the pointer.
 *
 * The tool layer and `TrailEngine` implement the behavior analyzed in
 * TLDRAW_ANALYSIS.md independently; no tldraw source is part of this repo.
 */
export abstract class BaseLaserOverlay {
	private layer: HTMLDivElement | null = null
	private canvas: HTMLCanvasElement | null = null
	private ctx: CanvasRenderingContext2D | null = null
	private tag: HTMLElement | null = null

	private engine: TrailEngine | null = null
	private feed: FeedState | null = null
	private stamps = new Map<number, OutlineStamp>()

	private raf: number | null = null
	private lastTickAt: number | null = null
	private savedEditable: string | null = null
	private disposers: Array<() => void> = []
	private dpr = 1
	private viewWidth = 0
	private viewHeight = 0
	private attached = false
	private currentFileKey = ''
	/** Last rendered snapshot; redrawn on scroll/resize. */
	private lastSnapshot: TrailStroke[] = []
	private resizeObserver: ResizeObserver | null = null
	/** Edge tab shown when the corner panel is hidden; null until attached. */
	private panelTab: HTMLButtonElement | null = null
	/** Corner-panel visibility (transient; resets when the tool exits). */
	private panelHidden = false

	constructor(
		private readonly plugin: MdLaserPlugin,
		private readonly cx: LaserHostContext
	) {
		this.tryAttach()
	}

	/** External nudge (CM ViewUpdate, layout changes): retry attach, resync. */
	refresh() {
		if (!this.attached) {
			this.tryAttach()
			return
		}
		this.syncFile()
		this.syncSize()
	}

	destroy() {
		this.stopLoop()
		this.dropTrail(true)
		this.engine?.clearAll()
		for (const dispose of this.disposers) dispose()
		this.disposers = []
		this.unlockEditor()
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
		this.cx.host().classList.remove('mdh-host', 'mdh-mode-active')
		this.layer?.remove()
		this.tag?.remove()
		this.panelTab?.remove()
		this.layer = null
		this.canvas = null
		this.tag = null
		this.panelTab = null
		this.panelHidden = false
		this.stamps.clear()
	}

	// ---------------------------------------------------------------- attach

	private tryAttach() {
		if (this.attached) return
		if (!this.cx.ready()) return

		this.engine = new TrailEngine(
			this.plugin.settings.fadeMs,
			(strokes) => this.paint(strokes),
			{
				schedule: (handler, timeout) => window.setTimeout(handler, timeout),
				cancel: (handle) => window.clearTimeout(handle),
			}
		)

		// Canvas layer + tag are positioned against the host viewport; the
		// positioning context comes from the host class, not inline styles.
		const host = this.cx.host()
		host.classList.add('mdh-host')
		const layer = host.createDiv({ cls: 'mdh-layer' })
		const canvas = layer.createEl('canvas', { cls: 'mdh-canvas' })
		const tag = host.createDiv({ cls: 'mdh-tag' })
		const header = tag.createDiv({ cls: 'mdh-tag-header' })
		setIcon(header, 'crosshair')
		const hideButton = header.createEl('button', { cls: 'mdh-hide' })
		hideButton.type = 'button'
		setTooltip(hideButton, 'Hide toolbar')
		setIcon(hideButton, 'chevron-right')
		hideButton.addEventListener('click', () => this.setPanelHidden(true))
		this.applyTagPosition(tag)
		this.buildSwatches(tag)
		tag.createSpan({ cls: 'mdh-tag-hint', text: 'Esc to exit' })

		// Edge tab that slides the corner panel back in after hiding.
		const tab = host.createEl('button', { cls: 'mdh-panel-tab' })
		tab.type = 'button'
		setTooltip(tab, 'Show toolbar')
		setIcon(tab, 'chevron-left')
		tab.addEventListener('click', () => this.setPanelHidden(false))
		this.panelTab = tab

		this.layer = layer
		this.canvas = canvas
		this.ctx = canvas.getContext('2d')
		this.tag = tag
		this.attached = true

		// Redraw on scroll (document-anchored trail) and on any host resize;
		// the observer also sizes the canvas reliably at attach time.
		this.resizeObserver = new ResizeObserver(() => this.renderLast())
		this.resizeObserver.observe(layer)
		// scroll does not bubble, but a capture listener on the host still
		// receives scrolls from any scrolling descendant.
		const scroll = () => this.renderLast()
		host.addEventListener('scroll', scroll, { capture: true, passive: true })
		this.disposers.push(() => host.removeEventListener('scroll', scroll, { capture: true }))

		// The overlaid canvas sits outside the scroll container, so while the
		// tool is on native wheel events would dead-end (no scrollable
		// ancestor). Forward them to the content's scroller; see onWheel. The
		// listeners live on the hit-testable overlays only, so editors keep
		// compositor scrolling whenever the tool is off.
		const onWheel = (e: WheelEvent) => this.onWheel(e)
		canvas.addEventListener('wheel', onWheel, { passive: false })
		tag.addEventListener('wheel', onWheel, { passive: false })
		this.disposers.push(() => {
			canvas.removeEventListener('wheel', onWheel)
			tag.removeEventListener('wheel', onWheel)
		})

		this.registerListeners()
		this.syncSize()
	}

	private isDark(): boolean {
		return this.cx.host().ownerDocument.body.classList.contains('theme-dark')
	}

	/**
	 * The floating toolbar: a row of tldraw-palette swatches inside the state
	 * pill (between the icon and the exit hint). The pill itself stays
	 * click-transparent so canvas strokes are never blocked; buttons
	 * re-enable pointer events individually in styles.css.
	 */
	private buildSwatches(tag: HTMLElement) {
		const row = tag.createDiv({ cls: 'mdh-swatches' })
		const doc = tag.ownerDocument
		for (const entry of LASER_SWATCHES) {
			const button = row.createEl('button', { cls: 'mdh-swatch' })
			button.type = 'button'
			setTooltip(button, entry.label)
			button.dataset.laserColor = entry.name
			// Both theme values are provided as CSS variables; styles.css picks
			// by body theme class, so chips re-tint live on theme changes.
			button.setCssProps({
				'--laser-swatch-light': entry.light,
				'--laser-swatch-dark': entry.dark,
			})
			button.addEventListener('click', () => {
				const isDark = doc.body.classList.contains('theme-dark')
				void this.plugin.updateSettings({ color: resolveLaserColor(entry.light, isDark) })
			})
		}
	}

	/** Highlight the current color's swatch and tint the pill icon with the ink. */
	private syncSwatches() {
		const tag = this.tag
		if (!tag) return
		// The pill's dock also follows the settings live.
		this.applyTagPosition(tag)
		tag.setCssProps({ '--laser-ink': resolveLaserColor(this.plugin.settings.color, this.isDark()) })
		const current = swatchNameOf(this.plugin.settings.color)
		for (const chip of Array.from(tag.querySelectorAll<HTMLElement>('.mdh-swatch'))) {
			chip.classList.toggle('is-current', chip.dataset.laserColor === current)
		}
	}

	private applyTagPosition(tag: HTMLElement) {
		const right = this.plugin.settings.toolbarPosition === 'top-right'
		tag.classList.toggle('mdh-tag-right', right)
		// Leaving the corner dock also restores the (hidden) panel state.
		if (!right) this.setPanelHidden(false)
	}

	/**
	 * Slide the corner panel off-screen (or pull it back via the edge tab).
	 * Center-docked pills never hide, and the tab only appears for the corner
	 * dock while the tool is on.
	 */
	private setPanelHidden(hidden: boolean) {
		this.panelHidden = hidden
		this.tag?.classList.toggle('mdh-hidden', hidden)
		this.panelTab?.classList.toggle(
			'mdh-show',
			hidden && this.plugin.settings.toolbarPosition === 'top-right'
		)
	}

	private registerListeners() {
		const canvas = this.canvas
		if (!canvas) return

		const down = (e: PointerEvent) => this.onPointerDown(e)
		const move = (e: PointerEvent) => this.onPointerMove(e)
		const up = (e: PointerEvent) => this.onPointerUp(e)
		const lost = () => this.dropTrail(false)

		canvas.addEventListener('pointerdown', down)
		canvas.addEventListener('pointermove', move)
		canvas.addEventListener('pointerup', up)
		canvas.addEventListener('lostpointercapture', lost)

		const unState = this.plugin.state.subscribe(() => this.syncMode())
		const unSettings = this.plugin.onSettingsChanged(() => this.syncSwatches())

		this.disposers.push(
			() => {
				canvas.removeEventListener('pointerdown', down)
				canvas.removeEventListener('pointermove', move)
				canvas.removeEventListener('pointerup', up)
				canvas.removeEventListener('lostpointercapture', lost)
			},
			unState,
			unSettings
		)

		this.registerKeys()
		this.syncMode()
	}

	/**
	 * Key handling lives on the document in the capture phase: while the laser
	 * owns the pointer, editor focus is gone (the canvas took the press, or the
	 * toggle came from the ribbon), so a listener on the editor DOM would never
	 * see Esc/K. Guards keep it from touching unrelated keys or open modals.
	 */
	private registerKeys() {
		const doc = this.cx.host().ownerDocument
		const keydown = (e: KeyboardEvent) => this.onKeyDown(e, doc)
		doc.addEventListener('keydown', keydown, true)
		this.disposers.push(() => doc.removeEventListener('keydown', keydown, true))
	}

	private onKeyDown(e: KeyboardEvent, doc: Document) {
		if (e.isComposing) return

		if (this.plugin.state.active) {
			// Esc/k ends the tool and also drops the in-flight stroke, so a
			// canceled drag never leaves a trail behind.
			if (e.key !== 'Escape' && e.key !== 'k' && e.key !== 'K') return
			// While a modal (settings, quick switcher) is open, Esc belongs to it.
			if (doc.querySelector('.modal-container')) return
			e.preventDefault()
			e.stopPropagation()
			this.dropTrail(false)
			this.plugin.state.exit()
			return
		}

		if (!this.plugin.settings.usePlainKToggle || e.repeat) return
		if (e.key !== 'k' && e.key !== 'K') return
		if (!this.cx.inScope(e.target)) return
		e.preventDefault()
		e.stopPropagation()
		this.plugin.state.set('laser')
	}

	// -------------------------------------------------------------- geometry

	private syncSize() {
		const canvas = this.canvas
		const layer = this.layer
		if (!canvas || !layer) return
		const w = layer.clientWidth
		const h = layer.clientHeight
		this.dpr = window.devicePixelRatio || 1
		const bw = Math.round(w * this.dpr)
		const bh = Math.round(h * this.dpr)
		if (
			w !== this.viewWidth ||
			h !== this.viewHeight ||
			canvas.width !== bw ||
			canvas.height !== bh
		) {
			this.viewWidth = w
			this.viewHeight = h
			canvas.width = bw
			canvas.height = bh
			canvas.style.width = `${w}px`
			canvas.style.height = `${h}px`
		}
	}

	private pointFromEvent(e: PointerEvent): TrailPoint {
		const rect = this.cx.content().getBoundingClientRect()
		return { x: e.clientX - rect.left, y: e.clientY - rect.top, z: 0.5 }
	}

	/**
	 * Wheel forwarding while the tool is on: translate deltas the way the
	 * browser's default wheel action would onto the content's scroll
	 * container. Trails stay glued to the text because scrolling triggers the
	 * capture scroll listener above.
	 */
	private onWheel(e: WheelEvent) {
		if (!this.plugin.state.active) return
		// Let pinch / app-level zoom stay native.
		if (e.ctrlKey) return
		if (e.deltaY === 0 && e.deltaX === 0) return
		const scroller = this.findScroller()
		if (!scroller) return
		e.preventDefault()
		const scale =
			e.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? scroller.clientHeight
				: e.deltaMode === WheelEvent.DOM_DELTA_LINE
					? this.linePx(scroller)
					: 1
		scroller.scrollTop += e.deltaY * scale
		scroller.scrollLeft += e.deltaX * scale
	}

	/**
	 * The scroll container of the content element: the first ancestor (from
	 * content up to the host) that actually overflows and is CSS-scrollable.
	 * `.cm-scroller` for editors, `.markdown-preview-view` for reading view.
	 */
	private findScroller(): HTMLElement | null {
		const host = this.cx.host()
		let el: HTMLElement | null = this.cx.content()
		while (el && host.contains(el)) {
			const overflowY = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY
			if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
				return el
			}
			el = el.parentElement
		}
		return null
	}

	private linePx(scroller: HTMLElement): number {
		const doc = scroller.ownerDocument
		if (!doc.defaultView) return 16
		const px = parseFloat(doc.defaultView.getComputedStyle(scroller).lineHeight)
		return Number.isFinite(px) ? px : 16
	}

	// ------------------------------------------------------------- lifecycle

	private syncMode() {
		if (!this.layer) return
		const active = this.plugin.state.active
		this.layer.classList.toggle('is-active', active)
		this.tag?.classList.toggle('is-open', active)
		// Refreshing here re-resolves the ink + highlight for the current
		// theme whenever the tool is opened (no theme observer needed).
		this.syncSwatches()
		const host = this.cx.host()
		host.classList.toggle('mdh-mode-active', active)
		if (active) {
			this.lockEditor()
			this.startLoop()
		} else {
			this.unlockEditor()
			// Tool release does not clear already-draining trails: they finish
			// dissolving like they would with the tool still on.
			this.dropTrail(true)
			// The corner panel also re-opens for the next session.
			this.setPanelHidden(false)
		}
	}

	private lockEditor() {
		const content = this.cx.content()
		if (content.getAttribute('contenteditable') === 'false') return
		// Tri-state: empty string stands for "attribute was absent" so the exact
		// prior value (true / plaintext-only on some platforms) is restored.
		this.savedEditable = content.getAttribute('contenteditable') ?? ''
		content.setAttribute('contenteditable', 'false')
	}

	private unlockEditor() {
		if (this.savedEditable === null) return
		const content = this.cx.content()
		if (this.savedEditable === '') content.removeAttribute('contenteditable')
		else content.setAttribute('contenteditable', this.savedEditable)
		this.savedEditable = null
	}

	private syncFile() {
		const path = this.cx.fileKey()
		if (path !== this.currentFileKey) {
			this.currentFileKey = path
			// A trail belongs to the file it was drawn over: switching files
			// drops what is on screen (fades included).
			this.engine?.clearAll()
		}
	}

	// --------------------------------------------------------------- trail tool

	/**
	 * One pointer drag = one trail stroke. Sessions outlive strokes: strokes
	 * pressed within the session's hold time share it, so after the pointer
	 * settles the whole run drains together. A session whose idle timer
	 * already fired (or whose hold lapsed between presses) is replaced.
	 */
	private openTrail(): FeedState | null {
		const engine = this.engine
		if (!engine) return null
		const live = this.feed && engine.isLive(this.feed.sessionId) ? this.feed.sessionId : null

		const options: TrailSessionOptions = {
			idleMs: this.plugin.settings.delayMs,
			// The hold window between strokes and the drain length are the same
			// knob on purpose: stopping = the hold timer firing.
			fadeMs: this.plugin.settings.fadeMs,
		}
		const sessionId = live ?? engine.startSession(options)
		const stroke = engine.addStroke(sessionId, {
			color: resolveLaserColor(this.plugin.settings.color, this.isDark()),
			opacity: this.plugin.settings.opacity,
			size: this.plugin.settings.width,
			taper: false,
		})
		return { sessionId, strokeId: stroke.id }
	}

	/**
	 * Feed pointer input into the open trail. If the session's hold expired
	 * while the pointer was still down, start a new session whose stroke
	 * continues seamlessly; the expired session drains on its own.
	 */
	private feedPoint(point: TrailPoint) {
		const engine = this.engine
		if (!engine || !this.feed) return
		if (!engine.isLive(this.feed.sessionId)) {
			this.feed = this.openTrail()
		}
		if (!this.feed) return
		engine.queuePoint(this.feed.sessionId, this.feed.strokeId, point.x, point.y)
	}

	/** Pointer released: the trail stays on screen until the hold elapses. */
	private releaseTrail() {
		if (!this.engine || !this.feed) return
		this.engine.finishStroke(this.feed.strokeId)
		this.feed = null
	}

	/**
	 * Stop feeding the pointer. keepHeld: true lets finished trails drain on
	 * their own; false dismisses the session outright (tool exit / drag lost).
	 */
	private dropTrail(keepHeld: boolean) {
		if (!this.engine || !this.feed) return
		if (!keepHeld && this.engine.isLive(this.feed.sessionId)) {
			this.engine.dismissSession(this.feed.sessionId)
		}
		this.feed = null
	}

	// ------------------------------------------------------------ frame loop

	private startLoop() {
		if (this.raf !== null || !this.engine) return
		this.lastTickAt = null
		this.raf = window.requestAnimationFrame(this.onFrame)
	}

	private stopLoop() {
		if (this.raf !== null) {
			window.cancelAnimationFrame(this.raf)
			this.raf = null
		}
		this.lastTickAt = null
	}

	private onFrame = (now: number) => {
		if (this.plugin.state.active && this.engine && this.feed) {
			this.engine.extendSession(this.feed.sessionId)
		}
		if (!this.engine) return

		const elapsed = this.lastTickAt === null ? 0 : Math.min(64, now - this.lastTickAt)
		this.lastTickAt = now

		this.engine.advance(elapsed)

		const done = !this.plugin.state.active && this.engine.isQuiet()
		if (done) {
			this.raf = null
			this.lastTickAt = null
			this.paint([])
			return
		}
		this.raf = window.requestAnimationFrame(this.onFrame)
	}

	// ------------------------------------------------------------- rendering

	/**
	 * Paint the engine's latest snapshot. Points live in content space; each
	 * frame is translated by the content element's current offset (see the
	 * class comment). Outlines are cached per stroke until (points count, last
	 * point, size, taper, phase) changes - trail evolution only touches the
	 * newest stroke, so repeated frames mostly reuse their Path2D.
	 */
	private paint(snapshots: TrailStroke[]) {
		this.lastSnapshot = snapshots
		const canvas = this.canvas
		const layer = this.layer
		const ctx = this.ctx
		if (!canvas || !layer || !ctx) return
		// Clear in device space, then draw in content space: points were
		// recorded relative to the content element (which scrolls with the
		// text), so each frame is translated by its current offset.
		const contentRect = this.cx.content().getBoundingClientRect()
		const layerRect = layer.getBoundingClientRect()
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
		ctx.clearRect(0, 0, this.viewWidth, this.viewHeight)
		ctx.translate(contentRect.left - layerRect.left, contentRect.top - layerRect.top)

		for (const stroke of snapshots) {
			const count = stroke.points.length
			if (!count) continue

			const tip = stroke.points[count - 1]
			if (!tip) continue

			const stamp = `${stroke.phase}|${stroke.size}|${stroke.taper ? 1 : 0}|${count}|${tip.x}|${tip.y}`
			let path = this.stamps.get(stroke.id)
			if (!path) {
				path = { stamp: '', path: new Path2D() }
				this.stamps.set(stroke.id, path)
			}
			if (path.stamp !== stamp) {
				path.path = this.buildOutline(stroke, tip)
				path.stamp = stamp
				if (this.stamps.size > CACHE_LIMIT) this.stamps.clear()
			}

			ctx.globalAlpha = stroke.opacity
			ctx.fillStyle = stroke.color
			ctx.fill(path.path)
		}
		ctx.globalAlpha = 1
	}

	/** perfect-freehand outline of a stroke, or a filled dot when it is tiny. */
	private buildOutline(stroke: TrailStroke, tip: TrailPoint): Path2D {
		const outline = getStroke(
			stroke.points.map((p) => ({ x: p.x, y: p.y, pressure: p.z })),
			{
				// zoom is 1 on the notes page: editor-space px == screen px
				size: stroke.size,
				start: { taper: stroke.taper, easing: LINEAR },
				last: stroke.phase !== 'drawing',
				simulatePressure: false,
				streamline: STREAMLINE,
			}
		)

		const path = new Path2D()
		// Sparse outlines from a tap: draw the tip as a dot instead.
		if (outline.length < 4) {
			path.arc(tip.x, tip.y, Math.max(0.5, stroke.size / 2), 0, Math.PI * 2)
			return path
		}
		path.moveTo(outline[0]![0], outline[0]![1])
		for (let i = 1; i < outline.length; i++) {
			const anchor = outline[i] as [number, number]
			const next = outline[(i + 1) % outline.length] as [number, number]
			path.quadraticCurveTo(
				anchor[0],
				anchor[1],
				(anchor[0] + next[0]) / 2,
				(anchor[1] + next[1]) / 2
			)
		}
		return path
	}

	/** Repaint the last snapshot at the current scroll/size (scroll, resize). */
	private renderLast() {
		this.syncSize()
		this.paint(this.lastSnapshot)
	}

	// ------------------------------------------------------------ interaction

	private onPointerDown(e: PointerEvent) {
		if (!this.plugin.state.active || !this.canvas) return
		e.preventDefault()
		this.canvas.setPointerCapture(e.pointerId)

		this.feed = this.openTrail()
		if (!this.feed) return
		// The first point lands without waiting for a move event.
		this.feedPoint(this.pointFromEvent(e))
		this.startLoop()
	}

	private onPointerMove(e: PointerEvent) {
		if (!this.feed) return
		e.preventDefault()
		const events =
			typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
		const raws = events.length ? events : ([e] as PointerEvent[])
		for (const raw of raws) {
			this.feedPoint(this.pointFromEvent(raw))
		}
	}

	private onPointerUp(e: PointerEvent) {
		if (!this.feed) return
		if (this.plugin.state.active) e.preventDefault()
		this.releaseTrail()
		// The tool stays engaged; the next press trails again immediately.
	}
}
