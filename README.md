# tldraw-laser-obsidian

A laser pointer for Obsidian notes, modeled on tldraw's laser feature. With the tool on, drag the pointer anywhere over an open note: a red trail follows you, holds after you lift the pointer, then fades away. Nothing is ever written to the note; the trail is transient overlay ink only.

The trail behavior is an independent implementation of the analysis in `TLDRAW_ANALYSIS.md`. This repository contains no source code from tldraw.

## What it does

- The "Toggle trail" command (also on the crosshair ribbon icon) switches the pointer tool on for the focused editor.
- Drag to point. The trail holds for a short "hold time" after you lift the pointer, then all strokes in the session fade out together (tldraw's grouped, ease-in fade).
- `Esc` or `k` exits back to typing (mirrors tldraw's `onCancel`).
- Floating color toolbar. While the tool is on, a pill at the top of the pane shows round swatches from tldraw's default palette, with light and dark variants like tldraw's themes. Click one to switch the trail color immediately; the Laser swatch restores the tldraw default red. The "Toolbar position" setting switches between top center (horizontal pill) and top right (a vertical, tldraw-style panel with a 4-column swatch grid). The corner panel has a hide button that slides it off-screen, and a half-circle tab with a `<` chevron at the top-right edge brings it back.
- Trails belong to the note they were drawn on: switching notes clears stale trails.
- Works in both editing modes (source and Live Preview) and in reading mode. Each markdown pane gets its own overlay automatically as you switch modes.
- Everything stays in memory per session, so the plugin never touches files, note content, or undo history.

## Install

The plugin is not in Obsidian's community store yet. From this repo:

### From GitHub releases

1. Open the [Releases](https://github.com/iakashpattnaik/tldraw-laser-obsidian/releases) page and download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in your vault at `<vault>/.obsidian/plugins/tldraw-laser-obsidian/`.
3. Restart Obsidian (or `Ctrl+R`), then enable "Laser Pointer" under Settings → Community plugins (temporary files mode if you use restricted mode).

### Via BRAT

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat): Command palette → "BRAT: Add a beta plugin for testing" → enter `iakashpattnaik/tldraw-laser-obsidian`. Releases made with tags are picked up automatically.

### Build from source

Requires the [bun](https://bun.sh) runtime (npm is not used in this repo):

1. ```sh
   bun install
   bun run build        # type-checks (tsc) then bundles to main.js
   ```
2. Copy `main.js`, `manifest.json`, `styles.css` into your vault at `<vault>/.obsidian/plugins/tldraw-laser-obsidian/`.
3. Restart Obsidian (or `Ctrl+R`), then enable "Laser Pointer".

Releases are cut automatically: tag a commit with the manifest version (`git tag 1.2.0 && git push origin 1.2.0`) and the GitHub Action lints, smoke-tests, builds, verifies the tag against `manifest.json`, and attaches the three files to the release. `main.js` is generated and never committed.

Requires Obsidian 1.13.0 or newer (the settings tab uses the declarative settings API).

## Hotkeys

The plugin ships no default hotkey (Obsidian's plugin guidelines): you bind your own. Open Settings → Hotkeys, search "Laser Pointer", and assign e.g. `Ctrl+Alt+L` to "Toggle trail".

Optional setting "Toggle with the plain k key" lets the bare `k` key toggle the laser while an editor is focused. Enabling it has a cost: a bare `k` is captured while typing too, so with this on you can no longer type the letter k in notes.

## Settings

| Setting | Default (tldraw values) |
| --- | --- |
| Trail color | `hsl(0, 100%, 50%)` (tldraw `laser` theme color); also choosable from the editor's floating toolbar (tldraw palette) |
| Toolbar position | Top center (horizontal pill) or top right (vertical tldraw-style panel, hide/unhide) |
| Trail width | `4` px |
| Hold time | `1200` ms (tldraw `laserDelayMs`) |
| Fade duration | `500` ms (tldraw `laserFadeoutMs`) |
| Trail opacity | `0.7` |
| Plain-k toggle | off |

## Development

Scripts (all via bun; `esbuild`/`node` sub-steps run inside bun):

| Command | Purpose |
| --- | --- |
| `bun run dev` | Bundle with inline sourcemaps, watch mode |
| `bun run build` | `tsc` type-check + production bundle (minified, sourcemap-less) |
| `bun run lint` | ESLint with the official `eslint-plugin-obsidianmd` recommended config |
| `bun run smoke` | Headless behavior contract for the trail engine (`src/trail-engine.ts`) |
| `bun run loadcheck` | Loads the built `main.js` in Node (via a `.cjs` copy) with a stubbed `obsidian` module and runs `onload()`: the reproducible form of Obsidian's "failed to load plugin" |

### Why the previous build failed to load

The old `md-highlighter` bundle exported its plugin class only as a named export. Obsidian loads plugins from `module.exports.default`, so the class never resolved and the app reported "failed to load plugin". This repo now default-exports the plugin class, and `bun run loadcheck` verifies the shape (exports must include `default`) before shipping.

### Runtime dependencies

Only two modules stay external in the bundle, both provided by Obsidian at runtime: `obsidian` and `@codemirror/view` (plus the rest of the official template's `@codemirror/*`/`@lezer/*` list, kept external so the `ViewPlugin` facet shares identity with the app's CodeMirror). Bundling covers everything else, including `perfect-freehand`.

## How it works

- `src/trail-engine.ts`: DOM-free engine owning transient trail sessions. It stages input between ticks, commits at most one point per stroke per tick, rejects sub-pixel movement, stops a session on an idle timeout, and drains finished sessions with a grouped ease-in fade. `scripts/smoke.ts` is the behavior contract.
- `src/base-overlay.ts`: the tool layer (feeds pointer events into the trail, handles `Esc`/`k` exit and the per-file reset) and the canvas painter (perfect-freehand outlines, per-stroke outline cache), shared by both editor and reading-view overlays.
- `src/host.ts`: per-surface plumbing. One context serves CodeMirror surfaces (`src/overlay.ts`, a `ViewPlugin` per editor); another serves a markdown leaf's reading view (`src/preview.ts`, installed outside CodeMirror since reading mode has no editor).
- `src/state.ts`: one global laser on/off switch shared across editors.
- `src/main.ts` and `src/settings.ts`: plugin wiring, commands, ribbon, status bar, declarative settings.
- `src/palette.ts`: tldraw default theme colors plus the `laser` default, and the theme-resolving helpers behind the floating toolbar.

The engine and tool layer reimplement the outward behavior documented in `TLDRAW_ANALYSIS.md`, which analyzes upstream tldraw and stays here as the design reference. No code is shared with tldraw.

## License

The plugin code is released under the MIT license (see `LICENSE`). The trail behavior was reimplemented from the behavior analysis in `TLDRAW_ANALYSIS.md`; the repository contains no source code from tldraw.

This project is not affiliated with tldraw, Inc. tldraw's own license is reproduced verbatim in `TLDRAW_LICENSE.md` for reference.
