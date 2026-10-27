import { PluginSettingTab, Setting } from 'obsidian'
import type { App, SettingDefinition, SettingDefinitionItem } from 'obsidian'
import type { MdLaserPlugin } from './main'
import type { LaserSettings } from './types'

/**
 * Defaults mirror tldraw's laser options and scribble defaults:
 * editor.options.laserDelayMs = 1200, laserFadeoutMs = 500; laser scribble =
 * color 'laser' (theme hsl(0,100%,50%)), opacity 0.7, size 4, taper false.
 */
export const DEFAULT_SETTINGS: LaserSettings = {
	color: 'hsl(0, 100%, 50%)',
	width: 4,
	delayMs: 1200,
	fadeMs: 500,
	opacity: 0.7,
	usePlainKToggle: false,
}

export class LaserSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: MdLaserPlugin
	) {
		super(app, plugin)
	}

	/**
	 * Declarative settings (Obsidian 1.13+): settings appear in the app-wide
	 * settings search without a hand-built display(). Storage is routed
	 * through the plugin's own settings object.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const def = DEFAULT_SETTINGS
		const defs: SettingDefinition[] = [
			{
				name: 'How to use',
				render: (setting: Setting): void => {
					setting.setDesc(
						'Run the "Toggle trail" command from the command palette (assign a hotkey to it under community plugins hotkeys, e.g. Ctrl+Alt+L) or click the crosshair ribbon icon. With the tool on, drag the pointer over the note: the red trail follows you, holds when you lift the pointer, then fades. Esc or K cancels the trail and returns the editor to typing. Trails are transient - nothing is ever written to your notes.'
					)
				},
			},
			{
				name: 'Trail color',
				desc: 'tldraw default: pure red.',
				control: {
					key: 'color',
					type: 'color',
					defaultValue: def.color,
				},
			},
			{
				name: 'Trail width',
				desc: 'Stroke width in pixels; tldraw uses 4.',
				control: {
					key: 'width',
					type: 'slider',
					min: 1,
					max: 16,
					step: 1,
					defaultValue: def.width,
				},
			},
			{
				name: 'Hold time',
				desc: 'How long a finished trail stays before it starts fading (tldraw: 1200 ms).',
				control: {
					key: 'delayMs',
					type: 'slider',
					min: 200,
					max: 3000,
					step: 100,
					defaultValue: def.delayMs,
				},
			},
			{
				name: 'Fade duration',
				desc: 'How long the fade-out runs once it starts (tldraw: 500 ms).',
				control: {
					key: 'fadeMs',
					type: 'slider',
					min: 100,
					max: 2000,
					step: 100,
					defaultValue: def.fadeMs,
				},
			},
			{
				name: 'Trail opacity',
				desc: 'Tldraw laser alpha is 0.7.',
				control: {
					key: 'opacity',
					type: 'slider',
					min: 0.2,
					max: 1,
					step: 0.05,
					defaultValue: def.opacity,
					displayFormat: (value: number) => value.toFixed(2),
				},
			},
			{
				name: 'Toggle with the plain k key',
				desc: 'With the editor focused, pressing k (no modifier) switches the laser on. Warning: a bare k is captured while typing too, so with this enabled you can no longer type the letter k in notes. Esc or k still exits the tool either way.',
				control: {
					key: 'usePlainKToggle',
					type: 'toggle',
					defaultValue: def.usePlainKToggle,
				},
			},
		]
		return defs
	}

	getControlValue(key: string): unknown {
		if (key === 'color') return this.plugin.settings.color
		if (key === 'width') return this.plugin.settings.width
		if (key === 'delayMs') return this.plugin.settings.delayMs
		if (key === 'fadeMs') return this.plugin.settings.fadeMs
		if (key === 'opacity') return this.plugin.settings.opacity
		if (key === 'usePlainKToggle') return this.plugin.settings.usePlainKToggle
		throw new Error(`Unknown laser setting: ${key}`)
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'color':
				await this.plugin.updateSettings({ color: value as string })
				break
			case 'width':
				await this.plugin.updateSettings({ width: value as number })
				break
			case 'delayMs':
				await this.plugin.updateSettings({ delayMs: value as number })
				break
			case 'fadeMs':
				await this.plugin.updateSettings({ fadeMs: value as number })
				break
			case 'opacity':
				await this.plugin.updateSettings({ opacity: value as number })
				break
			case 'usePlainKToggle':
				await this.plugin.updateSettings({ usePlainKToggle: value as boolean })
				break
			default:
				throw new Error(`Unknown laser setting: ${key}`)
		}
	}
}
