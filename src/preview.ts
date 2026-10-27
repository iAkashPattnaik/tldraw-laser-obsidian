import { BaseLaserOverlay } from './base-overlay'
import { previewHost } from './host'
import type { MdLaserPlugin } from './main'

/**
 * Laser overlay for a markdown leaf's reading view. Reading mode has no
 * CodeMirror editor, so this is attached outside the editor extension: the
 * plugin instantiates one per preview-mode markdown leaf on layout changes.
 */
export class PreviewOverlay extends BaseLaserOverlay {
	constructor(
		plugin: MdLaserPlugin,
		containerEl: HTMLElement
	) {
		super(plugin, previewHost(containerEl))
	}
}
