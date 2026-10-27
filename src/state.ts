import { LaserMode } from './types'

type ModeListener = () => void

/**
 * Tool state shared by all open editors (a single switch for whether the
 * laser owns the pointer); the per-editor lasers live in the overlays.
 */
export class LaserState {
	private listeners = new Set<ModeListener>()
	private _mode: LaserMode = 'idle'

	get mode(): LaserMode {
		return this._mode
	}

	get active(): boolean {
		return this._mode === 'laser'
	}

	set(mode: LaserMode) {
		if (this._mode === mode) return
		this._mode = mode
		this.emit()
	}

	toggle() {
		this.set(this._mode === 'idle' ? 'laser' : 'idle')
	}

	exit() {
		this.set('idle')
	}

	subscribe(listener: ModeListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit() {
		for (const listener of this.listeners) listener()
	}
}
