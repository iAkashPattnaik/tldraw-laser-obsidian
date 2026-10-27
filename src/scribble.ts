import { LaserScribble, ScribblePoint } from './types'

export interface ScribbleSessionOptions {
	id?: string
	/**
	 * Whether scribbles self-consume (shrink from start) while drawing.
	 * - true: scribbles eat their own tail as you draw (default, used for eraser/select)
	 * - false: scribbles persist until session stops (used for laser)
	 */
	selfConsume?: boolean
	/** How long to wait after last activity before auto-stopping. Only when selfConsume is false. */
	idleTimeoutMs?: number
	/** How scribbles fade when stopping: each on its own, or all as one sequence. */
	fadeMode?: 'individual' | 'grouped'
	/** Easing for grouped fade. */
	fadeEasing?: 'linear' | 'ease-in'
	/** Duration of the fade in milliseconds. */
	fadeDurationMs?: number
}

interface ScribbleItem {
	id: string
	scribble: LaserScribble
	timeoutMs: number
	delayRemaining: number
	prev: ScribblePoint | null
	next: ScribblePoint | null
}

interface Session {
	id: string
	items: ScribbleItem[]
	state: 'active' | 'stopping' | 'complete'
	options: Required<Omit<ScribbleSessionOptions, 'id'>>
	idleTimeoutHandle: number | undefined
	fadeElapsed: number
	totalPointsAtFadeStart: number
}

/**
 * Timer functions are injected so the engine stays DOM-free: the plugin passes
 * window-scoped timers (popouts get their own window), headless tests pass
 * bare globals.
 */
export interface ScribbleTimers {
	schedule(handler: () => void, timeout: number): number
	cancel(handle: number): void
}

type PointDist = (a: ScribblePoint, b: ScribblePoint) => number
const dist: PointDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function uniqueId(): string {
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Port of tldraw's ScribbleManager (packages/editor/.../managers/ScribbleManager),
 * reduced to the laser surface: sessions of transient scribbles, a per-frame
 * tick() that flushes queued points and runs fades, and an idle timeout that
 * stops a laser session after laserDelayMs of silence. Numbers and branch
 * structure follow upstream so the behavior is identical, including the
 * grouped, ease-in, points-shifted-from-the-start fade.
 *
 * The storage-less twin of tldraw's design: instead of pushing snapshots into
 * the reactive store, tick() emits them to the renderer.
 */
export class ScribbleManager {
	private sessions = new Map<string, Session>()

	constructor(
		private readonly defaultFadeMs: number,
		private readonly onTick: (scribbles: LaserScribble[]) => void,
		private readonly timers: ScribbleTimers
	) {}

	// ==================== SESSION API ====================

	/** Start a new session for grouping scribbles; returns its session ID. */
	startSession(options: ScribbleSessionOptions = {}): string {
		const id = options.id ?? uniqueId()
		const session: Session = {
			id,
			items: [],
			state: 'active',
			options: {
				selfConsume: options.selfConsume ?? true,
				idleTimeoutMs: options.idleTimeoutMs ?? 0,
				fadeMode: options.fadeMode ?? 'individual',
				fadeEasing:
					options.fadeEasing ?? (options.fadeMode === 'grouped' ? 'ease-in' : 'linear'),
				fadeDurationMs: options.fadeDurationMs ?? this.defaultFadeMs,
			},
			idleTimeoutHandle: undefined,
			fadeElapsed: 0,
			totalPointsAtFadeStart: 0,
		}

		this.sessions.set(id, session)
		if (session.options.idleTimeoutMs > 0) this.resetIdleTimeout(session)
		return id
	}

	/** Add a scribble to a session. */
	addScribbleToSession(
		sessionId: string,
		scribble: Partial<LaserScribble>,
		scribbleId = uniqueId()
	): ScribbleItem {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Session ${sessionId} not found`)

		const item: ScribbleItem = {
			id: scribbleId,
			scribble: {
				id: scribbleId,
				size: 20,
				color: 'hsl(0, 100%, 50%)',
				opacity: 0.8,
				delay: 0,
				points: [],
				shrink: 0.1,
				taper: true,
				...scribble,
				state: 'starting',
			},
			timeoutMs: 0,
			delayRemaining: scribble.delay ?? 0,
			prev: null,
			next: null,
		}

		session.items.push(item)
		if (session.options.idleTimeoutMs > 0) this.resetIdleTimeout(session)
		return item
	}

	/**
	 * Add a point to a scribble in a session. Queued via item.next and only
	 * committed on the next tick, exactly like upstream.
	 */
	addPointToSession(sessionId: string, scribbleId: string, x: number, y: number) {
		const session = this.sessions.get(sessionId)
		if (!session) return
		const item = session.items.find((i) => i.id === scribbleId)
		if (!item) return

		const point: ScribblePoint = { x, y, z: 0.5 }
		if (!item.prev || dist(item.prev, point) >= 1) {
			item.next = point
			// Reset idle timeout on activity
			if (session.options.idleTimeoutMs > 0) this.resetIdleTimeout(session)
		}
		return item
	}

	/** Extend a session, resetting its idle timeout. */
	extendSession(sessionId: string): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		if (session.options.idleTimeoutMs > 0) this.resetIdleTimeout(session)
	}

	/** Stop a session, triggering fade-out. */
	stopSession(sessionId: string): void {
		const session = this.sessions.get(sessionId)
		if (!session || session.state !== 'active') return

		this.clearIdleTimeout(session)
		session.state = 'stopping'

		if (session.options.fadeMode === 'grouped') {
			session.totalPointsAtFadeStart = session.items.reduce(
				(sum, item) => sum + item.scribble.points.length,
				0
			)
			session.fadeElapsed = 0
			for (const item of session.items) {
				item.scribble.state = 'stopping'
			}
		} else {
			for (const item of session.items) {
				item.delayRemaining = Math.min(item.delayRemaining, 200)
				item.scribble.state = 'stopping'
			}
		}
	}

	/** Clear all scribbles in a session immediately. */
	clearSession(sessionId: string): void {
		const session = this.sessions.get(sessionId)
		if (!session) return

		this.clearIdleTimeout(session)
		for (const item of session.items) {
			item.scribble.points = []
		}
		session.state = 'complete'
		this.requestEmit()
	}

	/** Check if a session is active. */
	isSessionActive(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.state === 'active'
	}

	/** Mark a scribble as complete (done being drawn but not yet fading). */
	complete(scribbleId: string): ScribbleItem | null {
		for (const session of this.sessions.values()) {
			const item = session.items.find((i) => i.id === scribbleId)
			if (item) {
				if (item.scribble.state === 'starting' || item.scribble.state === 'active') {
					item.scribble.state = 'complete'
				}
				return item
			}
		}
		return null
	}

	/** Stop and remove all sessions. */
	reset(): void {
		for (const session of this.sessions.values()) {
			this.clearIdleTimeout(session)
		}
		this.sessions.clear()
		this.requestEmit()
	}

	sessionCount(): number {
		return this.sessions.size
	}

	// ==================== FRAME TICK ====================

	/**
	 * Update on each animation frame: flush queued points, run fades, and emit
	 * the current snapshot (upstream pushes the same into the store here).
	 */
	tick(elapsed: number): void {
		if (this.sessions.size === 0) return

		for (const session of this.sessions.values()) {
			this.tickSession(session, elapsed)
		}

		for (const [id, session] of this.sessions) {
			if (session.state === 'complete') {
				this.clearIdleTimeout(session)
				this.sessions.delete(id)
			}
		}

		this.requestEmit()
	}

	hasLiveSessions(): boolean {
		return this.sessions.size > 0
	}

	private requestEmit() {
		const scribbles: LaserScribble[] = []
		for (const session of this.sessions.values()) {
			for (const item of session.items) {
				if (item.scribble.points.length > 0) {
					scribbles.push({ ...item.scribble, points: [...item.scribble.points] })
				}
			}
		}
		this.onTick(scribbles)
	}

	// ==================== PRIVATE HELPERS ====================

	private resetIdleTimeout(session: Session): void {
		this.clearIdleTimeout(session)
		session.idleTimeoutHandle = this.timers.schedule(() => {
			session.idleTimeoutHandle = undefined
			this.stopSession(session.id)
		}, session.options.idleTimeoutMs)
	}

	private clearIdleTimeout(session: Session): void {
		if (session.idleTimeoutHandle !== undefined) {
			this.timers.cancel(session.idleTimeoutHandle)
			session.idleTimeoutHandle = undefined
		}
	}

	private tickSession(session: Session, elapsed: number): void {
		if (session.state === 'complete') return

		if (session.state === 'stopping' && session.options.fadeMode === 'grouped') {
			this.tickGroupedFade(session, elapsed)
		} else {
			this.tickSessionItems(session, elapsed)
		}

		// Check if session is complete
		const hasContent = session.items.some((item) => item.scribble.points.length > 0)
		if (!hasContent && (session.state === 'stopping' || session.items.length === 0)) {
			session.state = 'complete'
		}
	}

	private tickSessionItems(session: Session, elapsed: number): void {
		for (const item of session.items) {
			const shouldSelfConsume =
				session.options.selfConsume ||
				session.state === 'stopping' ||
				item.scribble.state === 'stopping'

			if (shouldSelfConsume) {
				this.tickSelfConsumingItem(item, elapsed)
			} else {
				this.tickPersistentItem(item)
			}
		}

		if (session.options.fadeMode === 'individual') {
			session.items = session.items.filter(
				({ scribble }) => scribble.points.length > 0 || scribble.state === 'starting'
			)
		}
	}

	private tickPersistentItem(item: ScribbleItem): void {
		const { scribble } = item

		if (scribble.state === 'starting') {
			const { next, prev } = item
			if (next && next !== prev) {
				item.prev = next
				scribble.points.push(next)
			}
			if (scribble.points.length > 8) {
				scribble.state = 'active'
			}
			return
		}

		if (scribble.state === 'active') {
			const { next, prev } = item
			if (next && next !== prev) {
				item.prev = next
				scribble.points.push(next)
			}
		}
	}

	private tickSelfConsumingItem(item: ScribbleItem, elapsed: number): void {
		const { scribble } = item

		if (scribble.state === 'starting') {
			const { next, prev } = item
			if (next && next !== prev) {
				item.prev = next
				scribble.points.push(next)
			}
			if (scribble.points.length > 8) {
				scribble.state = 'active'
			}
			return
		}

		if (item.delayRemaining > 0) {
			item.delayRemaining = Math.max(0, item.delayRemaining - elapsed)
		}

		item.timeoutMs += elapsed
		if (item.timeoutMs >= 16) {
			item.timeoutMs = 0
		}

		const { delayRemaining, timeoutMs, prev, next } = item

		switch (scribble.state) {
			case 'active': {
				if (next && next !== prev) {
					item.prev = next
					scribble.points.push(next)
					if (delayRemaining === 0 && scribble.points.length > 8) {
						scribble.points.shift()
					}
				} else if (timeoutMs === 0) {
					if (scribble.points.length > 1) {
						scribble.points.shift()
					} else {
						item.delayRemaining = scribble.delay
					}
				}
				break
			}
			case 'stopping': {
				if (delayRemaining === 0 && timeoutMs === 0) {
					if (scribble.points.length <= 1) {
						scribble.points = []
						return
					}
					if (scribble.shrink) {
						scribble.size = Math.max(1, scribble.size * (1 - scribble.shrink))
					}
					scribble.points.shift()
				}
				break
			}
			case 'paused':
			case 'complete':
				break
		}
	}

	private tickGroupedFade(session: Session, elapsed: number): void {
		session.fadeElapsed += elapsed

		let remainingPoints = 0
		for (const item of session.items) {
			remainingPoints += item.scribble.points.length
		}

		if (remainingPoints === 0) return

		if (session.fadeElapsed >= session.options.fadeDurationMs) {
			for (const item of session.items) {
				item.scribble.points = []
			}
			return
		}

		const progress = session.fadeElapsed / session.options.fadeDurationMs
		const easedProgress =
			session.options.fadeEasing === 'ease-in' ? progress * progress : progress

		const targetRemoved = Math.floor(easedProgress * session.totalPointsAtFadeStart)
		const actuallyRemoved = session.totalPointsAtFadeStart - remainingPoints
		const pointsToRemove = Math.max(1, targetRemoved - actuallyRemoved)

		let removed = 0
		let itemIndex = 0
		while (removed < pointsToRemove && itemIndex < session.items.length) {
			const item = session.items[itemIndex]
			if (item && item.scribble.points.length > 0) {
				item.scribble.points.shift()
				removed++
			} else {
				itemIndex++
			}
		}
	}
}
