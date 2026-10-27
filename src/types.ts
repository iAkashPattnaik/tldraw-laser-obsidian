export type LaserMode = 'idle' | 'laser'

/**
 * A point on the trail: x/y in the content element's coordinate space, z
 * carrying pressure (0.5 for mouse/laser input, which has none).
 */
export interface TrailPoint {
	x: number
	y: number
	z: number
}

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

/** Where the floating toolbar pill sits along the top of the pane. */
export type LaserToolbarPosition = 'top-center' | 'top-right'
