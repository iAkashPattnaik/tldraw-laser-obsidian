import { MarkdownView, Plugin } from 'obsidian'
import { laserExtension } from './overlay'
import { PreviewOverlay } from './preview'
import { DEFAULT_SETTINGS, LaserSettingTab } from './settings'
import { LaserState } from './state'
import type { LaserSettings } from './types'

export class MdLaserPlugin extends Plugin {
	settings: LaserSettings = { ...DEFAULT_SETTINGS }
	state!: LaserState

	private settingsListeners = new Set<() => void>()
	private statusItem: HTMLElement | null = null
	private previewOverlays = new Map<HTMLElement, PreviewOverlay>()

	async onload() {
		const loaded = ((await this.loadData()) as LoadedData | null) ?? null
		this.settings = { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) }

		this.state = new LaserState()

		// One extension registration; every CM editor (including popouts) gets
		// its own LaserOverlay instance.
		this.registerEditorExtension(laserExtension(this))

		this.addCommand({
			id: 'toggle-laser',
			name: 'Toggle trail',
			callback: () => this.state.toggle(),
		})

		this.addCommand({
			id: 'exit-laser',
			name: 'Exit trail mode',
			callback: () => this.state.exit(),
		})

		this.addRibbonIcon(
			'crosshair',
			'Toggle laser pointer (transient red trail over this note)',
			() => this.state.toggle()
		)

		this.statusItem = this.addStatusBarItem()
		this.statusItem.addClass('mdh-status')
		this.register(this.state.subscribe(() => this.syncStatus()))
		this.syncStatus()

		this.addSettingTab(new LaserSettingTab(this.app, this))

		// Reading mode has no CodeMirror editor, so preview overlays are
		// attached/released per markdown leaf as its mode changes.
		this.registerEvent(this.app.workspace.on('layout-change', () => this.syncPreviewOverlays()))
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncPreviewOverlays()))
		this.app.workspace.onLayoutReady(() => this.syncPreviewOverlays())
	}

	onunload() {
		// Per-view sessions die with their view plugin; nothing to flush.
		for (const overlay of this.previewOverlays.values()) overlay.destroy()
		this.previewOverlays.clear()
	}

	onSettingsChanged(cb: () => void): () => void {
		this.settingsListeners.add(cb)
		return () => this.settingsListeners.delete(cb)
	}

	async updateSettings(patch: Partial<LaserSettings>) {
		this.settings = { ...this.settings, ...patch }
		await this.saveData({ settings: this.settings })
		for (const cb of this.settingsListeners) cb()
	}

	/**
	 * Attach a laser overlay to every markdown leaf currently in reading
	 * (preview) mode, and drop overlays whose container is gone. Idempotent:
	 * called on every layout change.
	 */
	private syncPreviewOverlays() {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view
			if (!(view instanceof MarkdownView) || view.getMode() !== 'preview') continue
			const containerEl = view.containerEl.querySelector<HTMLElement>('.markdown-reading-view')
			if (!containerEl || !containerEl.isConnected) continue
			if (!this.previewOverlays.has(containerEl)) {
				this.previewOverlays.set(containerEl, new PreviewOverlay(this, containerEl))
			}
		}
		for (const [el, overlay] of [...this.previewOverlays]) {
			if (!el.isConnected) {
				overlay.destroy()
				this.previewOverlays.delete(el)
			}
		}
	}

	private syncStatus() {
		if (!this.statusItem) return
		this.statusItem.hidden = !this.state.active
		if (this.state.active) this.statusItem.setText('Laser (esc or k exits)')
	}
}

interface LoadedData {
	settings?: Partial<LaserSettings>
}

// Obsidian loads plugins through the module's default export.
export default MdLaserPlugin
