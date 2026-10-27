import { editorInfoField } from 'obsidian'
import type { EditorView } from '@codemirror/view'

/**
 * Per-surface view plumbing for the laser overlay. The overlay machinery is
 * surface-agnostic; a host context tells it where to anchor, what counts as
 * content space, and which events belong to it.
 */
export interface LaserHostContext {
	/** Whether this surface is attachable right now (retry on next update). */
	ready(): boolean
	/** Viewport-anchoring element: the canvas layer + tag are created inside it. */
	host(): HTMLElement
	/** Content-space origin element - it scrolls with the text. */
	content(): HTMLElement
	/** Identity token used to clear trails when the shown file changes. */
	fileKey(): string
	/** Whether a keyboard event target belongs to this surface's scope. */
	inScope(target: EventTarget | null): boolean
}

/** Host context for a CodeMirror editor (source mode / Live Preview). */
export function cmHost(view: EditorView): LaserHostContext {
	return {
		ready: () =>
			view.dom.closest('.markdown-source-view') !== null &&
			view.dom.querySelector('.cm-sizer') !== null,
		host: () => view.dom,
		content: () => view.contentDOM,
		fileKey: () => {
			const info = view.state.field(editorInfoField, false)
			return info && info.file ? info.file.path : ''
		},
		inScope: (target) => target instanceof Node && view.contentDOM.contains(target),
	}
}

/**
 * Host context for a markdown leaf's reading view (no CodeMirror there).
 * containerEl is the leaf's `.markdown-reading-view`; content space is the
 * preview sizer, which scrolls with the rendered text.
 */
export function previewHost(containerEl: HTMLElement): LaserHostContext {
	const previewView = () =>
		containerEl.querySelector<HTMLElement>('.markdown-preview-view') ?? containerEl
	return {
		ready: () => containerEl.querySelector('.markdown-preview-view') !== null,
		host: () => containerEl,
		content: () =>
			containerEl.querySelector<HTMLElement>('.markdown-preview-sizer') ?? previewView(),
		fileKey: () => previewView().dataset.path ?? '',
		inScope: (target) => target instanceof Node && containerEl.contains(target),
	}
}
