export type LaserMode = 'idle' | 'laser'

/**
 * tldraw scribble points are {x, y, z} vecs; z is pressure (laser uses the
 * z = 0.5 default since laser input carries no pressure).
 */
export interface ScribblePoint {
	x: number
	y: number
	z: number
}

/** Renderm state machine of a scribble, matching tldraw's TLScribble.states. */
export type ScribbleState = 'starting' | 'active' | 'complete' | 'stopping' | 'paused'

/**
 * Transient scribble, subset of tldraw's TLScribble. Lives only for the fade
 * window; nothing here is ever persisted.
 */
export interface LaserScribble {
	id: string
	color: string
	/** Stroke width px (tldraw laser: 4). */
	size: number
	opacity: number
	delay: number
	points: ScribblePoint[]
	/** Fraction of the size shaved per stopping tick (self-consuming fades). */
	shrink: number
	/** Whether the start end tapers (laser: false). */
	taper: boolean
	state: ScribbleState
}

/** Where the floating toolbar pill sits along the top of the pane. */
export type LaserToolbarPosition = 'top-center' | 'top-right'

export interface LaserSettings {
	/** Resolved CSS color for the ink. tldraw theme: hsl(0, 100%, 50%). */
	color: string
	/** Where the floating toolbar is docked. */
	toolbarPosition: LaserToolbarPosition
	/** Stroke width px (tldraw laser: 4). */
	width: number
	/** How long a finished trail holds before fading (tldraw laserDelayMs). */
	delayMs: number
	/** How long the fade runs (tldraw laserFadeoutMs). */
	fadeMs: number
	/** Ink alpha (tldraw laser scribble: 0.7). */
	opacity: number
	/**
	 * Let the plain (modifier-free) K key toggle the laser while the editor is
	 * focused. Off by default: a bare K is captured while typing too, so with
	 * this on you can no longer type the letter k in notes.
	 */
	usePlainKToggle: boolean
}
