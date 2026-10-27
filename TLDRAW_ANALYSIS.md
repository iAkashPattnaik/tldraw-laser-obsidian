# tldraw → Obsidian: laser pointer design notes

Source of truth for this document: the tldraw checkout at `..\tldraw` in this workspace, analyzed (and once followed closely by an earlier iteration of this plugin). The laser pointer feature spans three subsystems — a state-machine tool, a scribble session manager, and an overlay renderer — described here as a behavior specification.

**Implementation note:** the code in this repo is an independent implementation of the behavior documented below (see `src/trail-engine.ts` and the tool layer in `src/base-overlay.ts`); it does not copy tldraw's source or carry it as a dependency. tldraw's own code lives only in the local `..\tldraw` checkout, which is not distributed with this project.

## Upstream files analyzed

| File | Role |
| --- | --- |
| `packages/tldraw/src/lib/tools/LaserTool/LaserTool.ts` | Tool state machine root: session id reuse, `clearSession` on cancel, `startScribble()` |
| `packages/tldraw/src/lib/tools/LaserTool/childStates/Idle.ts` | Idle state: pointer-down starts a scribble and transitions to `lasering` |
| `packages/tldraw/src/lib/tools/LaserTool/childStates/Lasering.ts` | Lasering state: pushes points per move, `extendSession()` **every tick** while a stroke is in progress, completes on pointer-up |
| `packages/editor/src/lib/editor/managers/ScribbleManager/ScribbleManager.ts` | Session engine: sessions hold scribble items; `tick(elapsed)` runs per animation frame |
| `packages/editor/src/lib/options.ts` | `laserDelayMs: 1200`, `laserFadeoutMs: 500` defaults |
| `packages/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts` | Laser color: `laser: 'hsl(0, 100%, 50%)'` (light and dark themes). Also the palette source: the floating toolbar's swatches use these themes' `solid` values, ordered like tldraw's color swatch UI |
| `packages/tldraw/src/lib/overlays/ScribbleOverlayUtil.ts` | Render: `perfect-freehand` outlines, streamlining, Path2D caching, dot fallback |
| `packages/tldraw/src/lib/ui/hud/StyleWidget.tsx` | The color-picking UI the toolbar mirrors: swatch row, tldraw UI order (black, grey, light-violet, violet, blue, light-blue, light-green, green, light-red, red, orange, yellow) |

## Laser-specific constants (upstream → port)

| Constant | Upstream | Port (`src/settings.ts` defaults) |
| --- | --- | --- |
| Session start options | `{ selfConsume: false, idleTimeoutMs: laserDelayMs, fadeMode: 'grouped', fadeEasing: 'ease-in' }` | identical, driven by settings |
| Scribble | color `hsl(0,100%,50%)`, `opacity 0.7`, `size 4`, `taper false` | identical |
| `laserDelayMs` | 1200 | hold-time setting (1200) |
| `laserFadeoutMs` | 500 | fade-duration setting (500) |
| Streamline | `0.32` | `STREAMLINE = 0.32` in `src/base-overlay.ts` |
| Path cache | per-scribble key on len/last point/zoom/size/taper/state, cap 500 | same key set (zoom fixed at 1 — editor px = screen px) |
| Fade easing | `ease-in` (grouped) | identical |

## Behavior kept 1:1

1. **Session reuse**: while a session is active, new scribbles join it; when it is gone, a fresh session is created (`LaserTool.startScribble`).
2. **Fresh session mid-stroke on timeout (#10125)**: `Lasering.pushPointToScribble` checks `isSessionActive` before adding a point and re-opens a session if the idle timeout fired while the user was still dragging.
3. **Single next-slot point queue**: `addPointToSession` keeps the last accepted point in `item.next` (kept only when ≥1px from `item.prev`); `tick()` flushes at most one new point per frame. Intermediate events inside one frame collapse to the final point — identical to upstream.
4. **'starting' → 'active' transition**: scribbles stay `starting` until more than 8 points exist.
5. **Idle timeout auto-stop**: `idleTimeoutMs > 0` schedules `stopSession`; every accepted point and every `extendSession()` (called while a stroke is in progress — `Lasering.onTick`) resets it. Between strokes nothing extends it, so a released trail fades after the hold time.
6. **Grouped ease-in fade (#fade)**: on stop, `totalPointsAtFadeStart` is captured; per tick `targetRemoved = floor(easedProgress * total)`, points are shifted off the start across items in order, `Math.max(1, …)` guarantees forward progress, and leftover points are zeroed at `fadeElapsed >= fadeDurationMs`.
7. **Session completion**: a session goes `complete` when no items have points; completed sessions are deleted in the same tick.
8. **Clear on page change (#10449)**: upstream clears sessions whose page differs from the current page inside `tick()`. The overlay clears the engine when the editor's `editorInfoField.file` changes.
9. **Cancel semantics**: `LaserTool.onCancel` clears the active session; a bare second cancel exits the tool. Esc/k in this plugin does exactly this (exit + dismiss the in-flight trail; already-settled trails continue draining).
10. **Cancel-while-lasering of old build note**: switching away from the tool (`syncMode → exit`) keeps fading trails, matching tldraw's tool-switch behavior, and only the in-flight stroke is marked complete/dropped.

## Rendering pipeline (ScribbleOverlayUtil → canvas)

- Points → `getStroke()` from `perfect-freehand` (tldraw's freehand engine): options `{ size, start: { taper, easing: linear }, last: state ∈ {complete, stopping}, simulatePressure: false, streamline: 0.32 }`. Laser uses `taper: false`.
- Outline ≥ 4 points → SVG path via the `getSvgPathFromPoints` port (quadratics through segment midpoints, left open); smaller → a fallback circle arc at the last point (tldraw's tiny-stroke dot).
- `ctx.globalAlpha = scribble.opacity`, `ctx.fillStyle = scribble.color`, Path2D fill. Path2D cache invalidated by (len, lastPoint, size, taper, state) hits, clearing wholesale at >500 entries.
- Rendering happens on each `ScribbleManager.tick()` emit — the store-snapshot emits upstream become direct canvas draws here.

## Deliberate divergences

- **Canvas per editor instead of SVG overlays**: tldraw renders on a zoomable canvas with overlay SVG layers; Obsidian's editor has no zoom, so editor-space px = screen px and a single full-size 2D `<canvas>` inset over the content is the simplest faithful surface.
- **Persistence**: upstream scribbles live in the reactive store; the port keeps them purely in memory per editor view. Nothing reaches the store/DOM of the markdown note.
- **Editor pointer capture**: while the laser owns the pointer, the CM content is made `contenteditable="false"` (tri-state saved/restored) so text can't be selected or mutated; tldraw instead just isn't editable under the canvas at all.
- **Settings**: user-tunable color/width/hold/fade/opacity wrap the upstream defaults; defaults equal upstream exactly.

## Color toolbar (tldraw palette)

The floating pill carries a `Laser` swatch (the theme-constant `hsl(0,100%,50%)` default) plus the 12 default theme colors in tldraw's UI order, drawn as circular swatches like tldraw's StyleWidget pips. Values are the `solid` variants from `defaultThemes.ts` for each theme — e.g. black is `#1d1d1d` in light and `#f2f2f2` in dark, matching what tldraw's StyleWidget shows per theme. Swatch chips carry both values as CSS variables and `styles.css` picks per `theme-light`/`theme-dark`, so chips re-tint live on theme switches. Clicking a swatch stores the current theme's value (settings remain a plain CSS color string); a name/hex mapper (`src/palette.ts`) re-resolves palette values to the active theme at stroke time, so "black" follows theme switches. Arbitrary custom colors from the settings tab pass through untouched. Top center renders the original horizontal pill; top right renders a vertical corner panel like tldraw's docked style panel (4-column swatch grid), with a hide button that slides the panel off-screen and a half-circle chevron tab pinned to the edge to bring it back — overriding the pill positioning rather than copying tldraw's canvas layout directly, since here the "canvas" is a pane.
