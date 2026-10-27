/**
 * Headless load harness: proves the built main.js (a) loads as CommonJS, (b)
 * instantiates the plugin class, and (c) runs onload() without throwing -
 * the nearest reproducible equivalent of Obsidian's "failed to load plugin".
 *
 * Node-side quirk this compensates for: package.json sets "type": "module",
 * so a bare `require('main.js')` is parsed as ESM and fails. Obsidian ignores
 * package.json type for plugin bundles (they are always CJS). Copying main.js
 * to a .cjs file gives Node the same CommonJS interpretation Obsidian uses.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyFileSync, mkdirSync } from 'node:fs'

const require = createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')))
const mainPath = path.resolve('main.js')

if (process.argv[2] !== 'deployed') {
	mkdirSync('node_modules/.loadcheck', { recursive: true })
	copyFileSync(mainPath, 'node_modules/.loadcheck/main.cjs')
}

const target = process.argv[2] === 'deployed' ? process.argv[3] : 'node_modules/.loadcheck/main.cjs'

class MockStatusBar {
	setText() {}
	addClass() {}
}
class MockComponent {
	register() {}
	registerEvent() {}
	addCommand() { return { id: '', callback: () => {} } }
	addRibbonIcon() { return {} }
	addStatusBarItem() { return new MockStatusBar() }
	addSettingTab() {}
	registerEditorExtension() {}
	registerDomEvent() {}
	registerInterval() { return 0 }
	loadData() { return Promise.resolve(null) }
	saveData() { return Promise.resolve() }
}
class MockPlugin extends MockComponent {
	constructor(app, manifest) {
		super()
		this.app = app
		this.manifest = manifest
	}
}

const obsidianStub = {
	Plugin: MockPlugin,
	MarkdownView: class {},
	PluginSettingTab: class {
		constructor() {}
		display() {}
	},
	Setting: class {
		setName() { return this }
		setDesc() { return this }
		addColorPicker() { return this }
		addSlider() { return this }
		addToggle() { return this }
	},
	Notice: class {},
	TFile: class {},
	IconName: Object,
	setIcon() {},
	editorInfoField: {},
	editorEditorField: {},
	EditorView: class {},
	ViewPlugin: { define: () => ({}), fromClass: () => ({}) },
}

const Module = require('node:module')
const origLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'obsidian') return obsidianStub
	return origLoad.call(Module, request, parent, isMain)
}

const mod = require(path.resolve(target))
const pluginClass = mod.default ?? mod[Object.keys(mod).find((k) => typeof mod[k] === 'function')]
console.log(`[load] resolved exports: ${Object.keys(mod).join(', ')}`)
if (typeof pluginClass !== 'function') {
	console.error('[load] FAIL: no plugin class (default export) found')
	process.exit(1)
}
console.log(`[load] loaded plugin class: ${pluginClass.name}`)

const instance = new pluginClass(
	{
		vault: {},
		workspace: {
			on() {
				return {}
			},
			onLayoutReady() {},
			getLeavesOfType() {
				return []
			},
		},
	},
	{ id: 'md-laser' }
)
try {
	await instance.onload()
	console.log('[load] PASS: onload() resolved with no exception')
} catch (err) {
	console.error('[load] FAIL: onload() threw:')
	console.error(err && err.stack ? err.stack : err)
	process.exitCode = 1
}
