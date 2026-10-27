import type { TrailPoint } from './types'

/**
 * A transient stroke drawn by the pointer. Lives only inside the engine; the
 * renderer receives point copies toward each tick. `phase` drives stroke-end
 * taper: a 'done' or 'fading' stroke gets its tail tapered, a 'drawing' one
 * does not.
 */
export type TrailPhase = 'drawing' | 'done' | 'fading'

export interface TrailStroke {
	id: number
	phase: TrailPhase
	color: string
	/** Stroke width px. */
	size: number
	opacity: number
	/** Whether the start end tapers. */
	taper: boolean
	points: TrailPoint[]
}

/** Style used to open a stroke. */
export interface TrailStrokeSpec {
	color: string
	size: number
	opacity: number
	taper: boolean
}

export interface TrailSessionOptions {
	/**
	 * How long (ms) a session survives without activity before it stops
	 * itself and starts draining. 0 keeps it running until stopped.
	 */
	idleMs?: number
	/** How long (ms) the drain runs once the session stops. */
	fadeMs?: number
}

/**
 * Timer functions are injected so the engine stays DOM-free: the plugin passes
 * window-scoped timers (popouts get their own window), headless tests pass
 * bare globals.
 */
export interface TrailEngineTimers {
	schedule(handler: () => void, timeout: number): number
	cancel(handle: number): void
}

interface StrokeRecord {
	id: number
	phase: TrailPhase
	color: string
	size: number
	opacity: number
	taper: boolean
	/** Committed points, oldest first. */
	points: TrailPoint[]
	/** Point accepted since the previous tick; committed on the next tick. */
	pending: TrailPoint | null
	/** Newest point already committed to `points`; the input gate compares here. */
	gate: TrailPoint | null
}

/** A session is either holding (accepting strokes/points) or draining. */
interface SessionRecord {
	id: number
	holding: boolean
	strokes: StrokeRecord[]
	idleMs: number
	fadeMs: number
	idleHandle: number | undefined
	/** Points captured when the drain began; the ease-in denominator. */
	drainTotal: number
	drainElapsed: number
}

/**
 * Session-scoped trail engine: holds strokes as point lists, commits at most
 * one staged point per stroke per tick (fast input collapses to tick cadence
 * by staging between ticks; sub-pixel movement is rejected), and drains
 * finished sessions from their oldest points with a grouped ease-in fade. An
 * idle timer stops a session by itself after `idleMs` of silence unless
 * activity keeps resetting it.
 *
 * Timers and rendering are injected; the engine itself is DOM-free and testable
 * headlessly (scripts/smoke.ts is the behavior contract).
 */
export class TrailEngine {
	private sessions = new Map<number, SessionRecord>()
	private nextSessionId = 1
	private nextStrokeId = 1

	constructor(
		private readonly defaultFadeMs: number,
		private readonly onSnapshot: (strokes: TrailStroke[]) => void,
		private readonly timers: TrailEngineTimers
	) {}

	// ------------------------------------------------------------ session api

	/**
	 * Open a session that groups strokes; when the session stops, all of its
	 * strokes drain together. Returns the session id.
	 */
	startSession(options: TrailSessionOptions = {}): number {
		const session: SessionRecord = {
			id: this.nextSessionId++,
			holding: true,
			strokes: [],
			idleMs: options.idleMs ?? 0,
			fadeMs: options.fadeMs ?? this.defaultFadeMs,
			idleHandle: undefined,
			drainTotal: 0,
			drainElapsed: 0,
		}
		this.sessions.set(session.id, session)
		this.rearmIdle(session)
		return session.id
	}

	/** Begin a stroke inside a session, styled exactly per the spec. */
	addStroke(sessionId: number, spec: TrailStrokeSpec): TrailStroke {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		const stroke: StrokeRecord = {
			id: this.nextStrokeId++,
			phase: 'drawing',
			color: spec.color,
			size: spec.size,
			opacity: spec.opacity,
			taper: spec.taper,
			points: [],
			pending: null,
			gate: null,
		}
		session.strokes.push(stroke)
		this.rearmIdle(session)
		return this.snapshotOf(stroke)
	}

	/**
	 * Stage a point on a stroke. One staged point per stroke survives a tick,
	 * so a burst of input inside a single frame collapses to its newest point.
	 * Points under 1px from the newest committed one are rejected instead of
	 * staged, which also suppresses exact repeats.
	 */
	queuePoint(sessionId: number, strokeId: number, x: number, y: number): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		const point: TrailPoint = { x, y, z: 0.5 }
		for (const stroke of session.strokes) {
			if (stroke.id !== strokeId) continue
			const gate = stroke.gate
			if (gate && Math.hypot(point.x - gate.x, point.y - gate.y) < 1) return
			stroke.pending = point
			this.rearmIdle(session)
		}
	}

	/** Reset a session's idle timer so an active session keeps running. */
	extendSession(sessionId: number): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		this.rearmIdle(session)
	}

	/** End a session's hold phase: what remains drains away as one group. */
	stopSession(sessionId: number): void {
		const session = this.sessions.get(sessionId)
		if (!session || !session.holding) return
		this.cancelIdle(session)
		const total = this.totalPoints(session)
		if (total === 0) {
			this.sessions.delete(sessionId)
			return
		}
		session.holding = false
		session.drainTotal = total
		session.drainElapsed = 0
		for (const stroke of session.strokes) {
			stroke.phase = 'fading'
			stroke.pending = null
		}
	}

	/** Dismiss a session: drop every point and remove it immediately. */
	dismissSession(sessionId: number): void {
		if (!this.sessions.has(sessionId)) return
		const session = this.sessions.get(sessionId)
		if (session) this.cancelIdle(session)
		this.sessions.delete(sessionId)
		this.emitSnapshot()
	}

	/** Mark a stroke as ended (its tail tapers) while it stays on screen. */
	finishStroke(strokeId: number): void {
		for (const session of this.sessions.values()) {
			for (const stroke of session.strokes) {
				if (stroke.id !== strokeId) continue
				if (stroke.phase === 'drawing') stroke.phase = 'done'
				return
			}
		}
	}

	/** Whether a session is still holding its points (not yet draining). */
	isLive(sessionId: number): boolean {
		return this.sessions.get(sessionId)?.holding ?? false
	}

	/** Whether no sessions remain (the renderer can stop ticking). */
	isQuiet(): boolean {
		return this.sessions.size === 0
	}

	/** How many sessions exist right now. */
	get count(): number {
		return this.sessions.size
	}

	/** Drop every session at once (used when the shown file changes). */
	clearAll(): void {
		for (const session of this.sessions.values()) this.cancelIdle(session)
		this.sessions.clear()
		this.emitSnapshot()
	}

	// ------------------------------------------------------------- frame tick

	/**
	 * Advance every session by `dtMs`: commit staged points while holding,
	 * advance the drain otherwise, and drop sessions that emptied out. Emits a
	 * snapshot toward the renderer on every call so it can paint what remains.
	 */
	advance(dtMs: number): void {
		for (const session of [...this.sessions.values()]) {
			if (session.holding) {
				this.commitStagedPoints(session)
			} else {
				this.advanceDrain(session, dtMs)
			}
			if (session.strokes.length === 0 || this.totalPoints(session) === 0) {
				// Nothing left to show or grow: the session is finished.
				this.cancelIdle(session)
				this.sessions.delete(session.id)
			}
		}
		this.emitSnapshot()
	}

	private commitStagedPoints(session: SessionRecord): void {
		for (const stroke of session.strokes) {
			if (stroke.phase !== 'drawing' || !stroke.pending) continue
			stroke.points.push(stroke.pending)
			stroke.gate = stroke.pending
			stroke.pending = null
		}
	}

	private advanceDrain(session: SessionRecord, dtMs: number): void {
		const alive = this.totalPoints(session)
		if (alive === 0) return
		session.drainElapsed += dtMs
		if (session.drainElapsed >= session.fadeMs) {
			for (const stroke of session.strokes) stroke.points.length = 0
			return
		}
		// Grouped ease-in drain: square the progress so early ticks barely
		// shave points, then let the removals accelerate. Removals always
		// advance by at least one point per tick and remove oldest-first
		// across strokes, in session order.
		const eased = (session.drainElapsed / session.fadeMs) ** 2
		const targetGone = Math.floor(eased * session.drainTotal)
		const alreadyGone = session.drainTotal - alive
		let toRemove = Math.max(1, targetGone - alreadyGone)
		for (const stroke of session.strokes) {
			while (toRemove > 0 && stroke.points.length > 0) {
				stroke.points.shift()
				toRemove--
			}
			if (toRemove === 0) break
		}
	}

	// ---------------------------------------------------------------- plumbing

	private emitSnapshot(): void {
		const strokes: TrailStroke[] = []
		for (const session of this.sessions.values()) {
			for (const stroke of session.strokes) {
				if (stroke.points.length > 0) strokes.push(this.snapshotOf(stroke))
			}
		}
		this.onSnapshot(strokes)
	}

	private snapshotOf(stroke: StrokeRecord): TrailStroke {
		return {
			id: stroke.id,
			phase: stroke.phase,
			color: stroke.color,
			size: stroke.size,
			opacity: stroke.opacity,
			taper: stroke.taper,
			points: [...stroke.points],
		}
	}

	private rearmIdle(session: SessionRecord): void {
		if (session.idleMs <= 0) return
		this.cancelIdle(session)
		session.idleHandle = this.timers.schedule(() => {
			session.idleHandle = undefined
			this.stopSession(session.id)
		}, session.idleMs)
	}

	private cancelIdle(session: SessionRecord): void {
		if (session.idleHandle === undefined) return
		this.timers.cancel(session.idleHandle)
		session.idleHandle = undefined
	}

	private totalPoints(session: SessionRecord): number {
		let total = 0
		for (const stroke of session.strokes) total += stroke.points.length
		return total
	}
}
