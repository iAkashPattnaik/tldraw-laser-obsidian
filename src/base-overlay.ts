import { setIcon, setTooltip } from 'obsidian'
import { getStroke } from 'perfect-freehand'
import { ScribbleManager, ScribbleSessionOptions } from './scribble'
import { LASER_SWATCHES, resolveLaserColor, swatchNameOf } from './palette'
import type { LaserHostContext } from './host'
import type { MdLaserPlugin } from './main'
import type { LaserScribble, ScribblePoint } from './types'

/** tldraw's EASINGS.linear. */
const LINEAR = (t: number): number => t

// Port of tldraw's ScribbleOverlayUtil options + render pipeline (see
// overlays/ScribbleOverlayUtil.ts): streamline 0.32, per-scribble Path2D cache,
// dot fallback for tiny strokes.
const STREAMLINE = 0.32
const CACHE_SIZE = 500

interface ScribbleCacheEntry {
	len: number
	lastX: number
	lastY: number
	size: number
	taper: boolean
	state: string
	path: Path2D
}

interface LaseringState {
	sessionId: string
	scribbleId: string
}

/**
 * Shared laser overlay machinery, one instance per editor surface (a
 * CodeMirror editor in source mode/Live Preview, or a markdown leaf's reading
 * view - reading mode has no CodeMirror, hence the separate host context).
 *
 * Structure follows tldraw's laser feature end-to-end: a `ScribbleManager`
 * (ported manager) holds sessions; pointer drags speak the LaserTool protocol
 * (startScribble -> addPointToSession per move -> complete on release); a
 * single rAF loop drives tick() and canvas rendering like the app's overlay.
 * Trails hold for laserDelayMs after the last activity, then fade as one
 * grouped sequence over laserFadeoutMs. Nothing persists.
 *
 * Geometry: the canvas covers the host's viewport box, while trail points are
 * recorded in the content element's coordinate space (which scrolls with the
 * text). Each frame is drawn translated by the content's current offset, so
 * trails stay glued to the text while scrolling and the canvas always sits
 * under the pointer.
 */
export abstract class BaseLaserOverlay {
	private layer: HTMLDivElement | null = null
	private canvas: HTMLCanvasElement | null = null
	private ctx: CanvasRenderingContext2D | null = null
	private tag: HTMLElement | null = null

	private manager: ScribbleManager | null = null
	private lasering: LaseringState | null = null
	private pathCache = new Map<string, ScribbleCacheEntry>()

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
	private lastScribbles: LaserScribble[] = []
	private resizeObserver: ResizeObserver | null = null

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
		this.cancelLasering(true)
		this.manager?.reset()
		for (const dispose of this.disposers) dispose()
		this.disposers = []
		this.unlockEditor()
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
		this.cx.host().classList.remove('mdh-host', 'mdh-mode-active')
		this.layer?.remove()
		this.tag?.remove()
		this.layer = null
		this.canvas = null
		this.tag = null
		this.pathCache.clear()
	}

	// ---------------------------------------------------------------- attach

	private tryAttach() {
		if (this.attached) return
		if (!this.cx.ready()) return

		this.manager = new ScribbleManager(
			this.plugin.settings.fadeMs,
			(scribbles) => this.render(scribbles),
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
		setIcon(tag, 'crosshair')
		this.buildSwatches(tag)
		tag.createSpan({ text: 'Esc to exit' })

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
		tag.setCssProps({ '--laser-ink': resolveLaserColor(this.plugin.settings.color, this.isDark()) })
		const current = swatchNameOf(this.plugin.settings.color)
		for (const chip of Array.from(tag.querySelectorAll<HTMLElement>('.mdh-swatch'))) {
			chip.classList.toggle('is-current', chip.dataset.laserColor === current)
		}
	}

	private registerListeners() {
		const canvas = this.canvas
		if (!canvas) return

		const down = (e: PointerEvent) => this.onPointerDown(e)
		const move = (e: PointerEvent) => this.onPointerMove(e)
		const up = (e: PointerEvent) => this.onPointerUp(e)
		const lost = () => this.cancelLasering(false)

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
			// LaserTool.onCancel semantics; exiting the tool releases typing.
			if (e.key !== 'Escape' && e.key !== 'k' && e.key !== 'K') return
			// While a modal (settings, quick switcher) is open, Esc belongs to it.
			if (doc.querySelector('.modal-container')) return
			e.preventDefault()
			e.stopPropagation()
			this.cancelLasering(false)
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

	private pointFromEvent(e: PointerEvent): ScribblePoint {
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
			// Tool release does not clear already-fading trails (matches tldraw
			// switching away from the laser while scribbles dissolve).
			this.cancelLasering(true)
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
			// A laser trail belongs to the file it was drawn over - clearing
			// stale trails on file change mirrors tldraw's page-change rule.
			this.manager?.reset()
		}
	}

	// ------------------------------------------------------------ tldraw tool

	/**
	 * LaserTool.getSessionId: reuse an active session, else start a new one
	 * with tldraw's laser options (no self-consume, grouped ease-in fade).
	 */
	private getSessionId(): string {
		if (!this.manager) return ''
		if (this.lasering && this.manager.isSessionActive(this.lasering.sessionId)) {
			return this.lasering.sessionId
		}
		const options: ScribbleSessionOptions = {
			selfConsume: false,
			idleTimeoutMs: this.plugin.settings.delayMs,
			fadeMode: 'grouped',
			fadeEasing: 'ease-in',
			fadeDurationMs: this.plugin.settings.fadeMs,
		}
		return this.manager.startSession(options)
	}

	/**
	 * LaserTool.startScribble: sketch token in the requested style - tldraw
	 * laser scribbles use the theme's `laser` color (pure red) by default,
	 * 0.7 opacity, size 4 px, taper off. Palette names resolve to the host
	 * document's current theme value at stroke time.
	 */
	private startScribble(): { sessionId: string; scribbleId: string } | null {
		const manager = this.manager
		if (!manager) return null
		const sessionId = this.getSessionId()
		const scribble = manager.addScribbleToSession(sessionId, {
			color: resolveLaserColor(this.plugin.settings.color, this.isDark()),
			opacity: this.plugin.settings.opacity,
			size: this.plugin.settings.width,
			taper: false,
		})
		return { sessionId, scribbleId: scribble.id }
	}

	/**
	 * Lasering.pushPointToScribble: keep feeding the current scribble, and open
	 * a fresh session if the old one timed out mid-stroke (upstream #10125).
	 */
	private pushPointToScribble(point: ScribblePoint) {
		if (!this.manager || !this.lasering) return
		if (!this.manager.isSessionActive(this.lasering.sessionId)) {
			const next = this.startScribble()
			if (!next) return
			this.lasering = next
		}
		this.manager.addPointToSession(
			this.lasering.sessionId,
			this.lasering.scribbleId,
			point.x,
			point.y
		)
	}

	/** Lasering.complete: mark the scribble done; the session fades on idle. */
	private completeLasering() {
		if (!this.manager || !this.lasering) return
		if (this.manager.isSessionActive(this.lasering.sessionId)) {
			this.manager.complete(this.lasering.scribbleId)
		}
		this.lasering = null
	}

	/** Cancel the in-flight stroke. keepFading: true keeps the trail, false dismisses. */
	private cancelLasering(keepFading: boolean) {
		if (!this.manager || !this.lasering) return
		if (!keepFading && this.manager.isSessionActive(this.lasering.sessionId)) {
			this.manager.clearSession(this.lasering.sessionId)
		}
		this.lasering = null
	}

	// ------------------------------------------------------------ frame loop

	private startLoop() {
		if (this.raf !== null || !this.manager) return
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
		if (this.plugin.state.active && this.manager && this.lasering) this.manager.extendSession(this.lasering.sessionId)
		if (!this.manager) return

		const elapsed = this.lastTickAt === null ? 0 : Math.min(64, now - this.lastTickAt)
		this.lastTickAt = now

		this.manager.tick(elapsed)

		const done = !this.plugin.state.active && !this.manager.hasLiveSessions()
		if (done) {
			this.raf = null
			this.lastTickAt = null
			this.render([])
			return
		}
		this.raf = window.requestAnimationFrame(this.onFrame)
	}

	// ------------------------------------------------------------ rendering

	/** ScribbleOverlayUtil.render port (canvas fill instead of overlay ctx). */
	private render(scribbles: LaserScribble[]) {
		this.lastScribbles = scribbles
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

		for (const scribble of scribbles) {
			const ptsLen = scribble.points.length
			if (!ptsLen) continue

			const last = scribble.points[ptsLen - 1]
			if (!last) continue
			let path: Path2D
			const cached = this.pathCache.get(scribble.id)
			if (
				cached &&
				cached.len === ptsLen &&
				cached.lastX === last.x &&
				cached.lastY === last.y &&
				cached.size === scribble.size &&
				cached.taper === scribble.taper &&
				cached.state === scribble.state
			) {
				path = cached.path
			} else {
				const outline = getStroke(this.toVecPairs(scribble.points), {
					// zoom is 1 in the notes page: editor-space px == screen px
					size: scribble.size,
					start: { taper: scribble.taper, easing: LINEAR },
					last: scribble.state === 'complete' || scribble.state === 'stopping',
					simulatePressure: false,
					streamline: STREAMLINE,
				})

				let d: string
				if (outline.length < 4) {
					const r = scribble.size / 2
					d = `M ${last.x - r},${last.y} a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 ${-r * 2},0`
				} else {
					d = getSvgPathFromOutline(outline)
				}

				path = new Path2D(d)
				this.pathCache.set(scribble.id, {
					len: ptsLen,
					lastX: last.x,
					lastY: last.y,
					size: scribble.size,
					taper: scribble.taper,
					state: scribble.state,
					path,
				})
				if (this.pathCache.size > CACHE_SIZE) this.pathCache.clear()
			}

			ctx.globalAlpha = scribble.opacity
			ctx.fillStyle = scribble.color
			ctx.fill(path)
		}
		ctx.globalAlpha = 1
	}

	private toVecPairs(points: ScribblePoint[]): Array<{ x: number; y: number; pressure?: number }> {
		return points.map((p) => ({ x: p.x, y: p.y, pressure: p.z }))
	}

	/** Redraw the last snapshot at the current scroll/size (scroll, resize). */
	private renderLast() {
		this.syncSize()
		this.render(this.lastScribbles)
	}

	// ------------------------------------------------------------- interaction

	private onPointerDown(e: PointerEvent) {
		if (!this.plugin.state.active || !this.canvas) return
		e.preventDefault()
		this.canvas.setPointerCapture(e.pointerId)

		const started = this.startScribble()
		if (!started) return
		this.lasering = started
		// Lasering.onEnter pushes the first point right away.
		this.pushPointToScribble(this.pointFromEvent(e))
		this.startLoop()
	}

	private onPointerMove(e: PointerEvent) {
		if (!this.lasering) return
		e.preventDefault()
		const events =
			typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
		const raws = events.length ? events : ([e] as PointerEvent[])
		for (const raw of raws) {
			this.pushPointToScribble(this.pointFromEvent(raw))
		}
	}

	private onPointerUp(e: PointerEvent) {
		if (!this.lasering) return
		if (this.plugin.state.active) e.preventDefault()
		this.completeLasering()
		// LaserTool keeps the tool engaged; the user can lase again immediately.
	}
}

/**
 * getSvgPathFromPoints port: quadratic curves through consecutive outline
 * point midpoints, left open (tldraw's version for overlay strokes).
 */
function getSvgPathFromOutline(stroke: number[][]): string {
	const len = stroke.length
	if (len < 3) return ''
	const first = stroke[0]
	if (!first) return ''

	let d = `M ${first[0]} ${first[1]}`
	for (let i = 1; i < len; i++) {
		const [x0, y0] = stroke[i] as [number, number]
		const next = stroke[(i + 1) % len] as [number, number]
		const midX = (x0 + next[0]) / 2
		const midY = (y0 + next[1]) / 2
		d += ` Q ${x0} ${y0} ${midX} ${midY}`
	}
	return d
}
