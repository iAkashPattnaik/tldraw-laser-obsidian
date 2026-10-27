# md-laser — Laser Pointer for Obsidian

A **laser pointer for Obsidian notes** modeled on tldraw's laser feature. With the tool on, drag the pointer anywhere over an open note: a red trail follows you, holds when you lift the pointer, then fades away. Nothing is ever written to the note — the trail is transient overlay ink only and the implementation is independent of tldraw's code (see `TLDRAW_ANALYSIS.md` for the behavior analysis).

## What it does

- **Toggle trail** command (also on the crosshair ribbon icon) switches the pointer tool on for the focused editor.
- Drag to point; the trail holds for a short "hold time" after you lift the pointer, then all strokes in the session fade out together (tldraw's grouped, ease-in fade).
- **Esc** or **k** exits back to typing (mirrors tldraw's `onCancel`).
- **Floating color toolbar**: while the tool is on, a pill at the top of the pane shows round swatches from tldraw's default palette (with proper light/dark variants, like tldraw's themes). Click one to switch the trail color immediately; the *Laser* swatch restores the tldraw default red. *Toolbar position* setting: **Top center** (horizontal pill) or **Top right** (a vertical, tldraw-style panel with a 4-column swatch grid). The corner panel has a hide button that slides it off-screen; a half-circle tab with a `<` chevron at the top-right edge brings it back.
- Trails belong to the note they were drawn on: switching notes clears stale trails.
- Works in **both editing modes** (source / Live Preview) and **reading mode** — each markdown pane gets its own overlay automatically as you switch modes.
- Everything is per-session and in-memory: no files, no note content, no undo history touched.

## Install

The plugin is not (yet) in Obsidian's official community store. Ways to get it from this repo:

### From GitHub releases

1. Open the repo's [Releases](https://github.com/akashpattnaik/md-laser/releases) page and download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in your vault:
   ```
   <vault>/.obsidian/plugins/md-laser/
   ```
3. Restart Obsidian (or `Ctrl+R`), then enable **Laser Pointer** under Settings → Community plugins (temporary files mode if you use restricted mode).

### Via BRAT

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat): Command palette → *BRAT: Add a beta plugin for testing* → enter `akashpattnaik/md-laser`. Releases made with tags are picked up automatically.

### Build from source

Requires the [bun](https://bun.sh) runtime (npm is not used in this repo):

1. ```sh
   bun install
   bun run build        # type-checks (tsc) then bundles to main.js
   ```
2. Copy `main.js`, `manifest.json`, `styles.css` into your vault at `<vault>/.obsidian/plugins/md-laser/`.
3. Restart Obsidian (or `Ctrl+R`), then enable **Laser Pointer**.

Releases are cut automatically: tag a commit with the manifest version (`git tag 1.2.0 && git push origin 1.2.0`) — the GitHub Action lints, smoke-tests, builds, verifies the tag against `manifest.json`, and attaches the three files to the release. `main.js` is generated and never committed.

Requires Obsidian **1.13.0 or newer** (the settings tab uses the declarative settings API).

## Hotkeys

A **default hotkey is intentionally not shipped** (Obsidian's plugin guidelines): you bind your own. Open Settings → Hotkeys → search "Laser Pointer" → assign e.g. `Ctrl+Alt+L` to *Toggle trail*.

Optional setting *"Toggle with the plain k key"* lets the bare `k` key toggle the laser while an editor is focused. Think twice about enabling it: a bare `k` is captured while typing too, so with this on you can no longer type the letter *k* in notes.

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
| `bun run loadcheck` | Loads the built `main.js` in Node (via a `.cjs` copy) with a stubbed `obsidian` module and runs `onload()` — the reproducible form of Obsidian's "failed to load plugin" |

### Why the previous build failed to load

The old `md-highlighter` bundle exported its plugin class only as a **named** export. Obsidian loads plugins from `module.exports.default`, so the class never resolved and the app reported "failed to load plugin". This repo now default-exports the plugin class, and `bun run loadcheck` verifies the shape (exports must include `default`) before shipping.

### Runtime dependencies

Only two modules stay external in the bundle, both provided by Obsidian at runtime: `obsidian` and `@codemirror/view` (+ the rest of the official template's `@codemirror/*`/`@lezer/*` list, kept external so the `ViewPlugin` facet shares identity with the app's CodeMirror). Everything else — including `perfect-freehand` — is bundled.

## How it works

- `src/trail-engine.ts` — DOM-free engine owning transient trail sessions: staging between ticks with one commit per stroke per tick (sub-pixel input rejected), idle-timeout auto-stop, grouped ease-in drain of finished sessions. Contract covered by `scripts/smoke.ts`.
- `src/base-overlay.ts` — the tool layer (pointer -> trail feeding, Esc/k exit, per-file reset) and the canvas painter (perfect-freehand outlines, per-stroke outline cache), shared by both editor and reading-view overlays.
- `src/host.ts` — per-surface plumbing: one context for CodeMirror surfaces (`src/overlay.ts`, a `ViewPlugin` per editor), one for a markdown leaf's reading view (`src/preview.ts`, installed outside CodeMirror since reading mode has no editor).
- `src/state.ts` — one global "laser on/off" switch shared across editors.
- `src/main.ts`, `src/settings.ts` — plugin wiring, commands, ribbon, status bar, declarative settings.
- `src/palette.ts` — tldraw default theme colors + the `laser` default, and the theme-resolving helpers behind the floating toolbar.

The engine and tool layer reimplement the outward behavior documented in `TLDRAW_ANALYSIS.md` (which analyzes upstream tldraw, kept here as the design reference); no code is shared with tldraw.
