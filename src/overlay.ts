import { ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { BaseLaserOverlay } from './base-overlay'
import { cmHost } from './host'
import type { MdLaserPlugin } from './main'

/**
 * Laser overlay for a CodeMirror editor (source mode / Live Preview).
 * Obsidian provides the '@codemirror/*' modules at runtime (see obsidian's
 * peerDependencies); esbuild keeps them external so our ViewPlugin facet
 * shares identity with the app's CodeMirror instance.
 */
export class LaserOverlay extends BaseLaserOverlay {
	constructor(
		plugin: MdLaserPlugin,
		private readonly view: import('@codemirror/view').EditorView
	) {
		super(plugin, cmHost(view))
	}

	update(_update: ViewUpdate) {
		this.refresh()
	}
}

/** One overlay instance per CM editor view. */
export const laserExtension = (plugin: MdLaserPlugin): Extension =>
	ViewPlugin.define((view) => new LaserOverlay(plugin, view))
