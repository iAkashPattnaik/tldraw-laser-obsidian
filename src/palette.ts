/**
 * tldraw's default color palette, taken verbatim from
 * packages/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts
 * (the values the "solid" style resolves to in the dark and light themes).
 *
 * The order is the order the color swatches appear in tldraw's own UI
 * (packages/tldraw/src/lib/ui-hud/StyleWidget).
 *
 * The laser's own theme color ("laser" = hsl(0, 100%, 50%)) is included as
 * the first, theme-independent swatch - it is the shipped default ink.
 */
export interface LaserPaletteEntry {
	/** tldraw color name (also used as the aria label suffix). */
	name: string
	/** User-facing label. */
	label: string
	/** "solid" value in the light theme. */
	light: string
	/** "solid" value in the dark theme. */
	dark: string
}

/** The shipped default ink: tldraw's `laser` theme color, equal in both themes. */
export const LASER_DEFAULT_COLOR = 'hsl(0, 100%, 50%)'

const LASER_ENTRY: LaserPaletteEntry = {
	name: 'laser',
	label: 'Laser (default)',
	light: LASER_DEFAULT_COLOR,
	dark: LASER_DEFAULT_COLOR,
}

const THEME_ENTRIES: LaserPaletteEntry[] = [
	{ name: 'black', label: 'Black', light: '#1d1d1d', dark: '#f2f2f2' },
	{ name: 'grey', label: 'Grey', light: '#9fa8b2', dark: '#9398b0' },
	{ name: 'light-violet', label: 'Light violet', light: '#e085f4', dark: '#e599f7' },
	{ name: 'violet', label: 'Violet', light: '#ae3ec9', dark: '#ae3ec9' },
	{ name: 'blue', label: 'Blue', light: '#4465e9', dark: '#4f72fc' },
	{ name: 'light-blue', label: 'Light blue', light: '#4ba1f1', dark: '#4dabf7' },
	{ name: 'light-green', label: 'Light green', light: '#4cb05e', dark: '#40c057' },
	{ name: 'green', label: 'Green', light: '#099268', dark: '#099268' },
	{ name: 'light-red', label: 'Light red', light: '#f87777', dark: '#ff8787' },
	{ name: 'red', label: 'Red', light: '#e03131', dark: '#e03131' },
	{ name: 'orange', label: 'Orange', light: '#e16919', dark: '#f76707' },
	{ name: 'yellow', label: 'Yellow', light: '#f1ac4b', dark: '#ffc034' },
]

/** Swatch row order: the laser default first, then tldraw's UI order. */
export const LASER_SWATCHES: LaserPaletteEntry[] = [LASER_ENTRY, ...THEME_ENTRIES]

/**
 * Which swatch (if any) a stored color value corresponds to. Matches either
 * theme's value for an entry, so values picked with the old single-theme
 * scheme still highlight the named swatch. Constness: the passed value is
 * 'laser' for the default, an entry name otherwise, or null for custom colors.
 */
export function swatchNameOf(color: string): string | null {
	const raw = color.trim().toLowerCase()
	if (!raw) return 'laser'
	for (const entry of LASER_SWATCHES) {
		if (raw === entry.name || raw === entry.light || raw === entry.dark) {
			return entry.name
		}
	}
	return null
}

/**
 * Resolve a stored color to the ink actually drawn: names re-map to the
 * current theme's value (so "black" follows you across theme switches),
 * palette hexes re-map analogous, and unknown values are used verbatim.
 */
export function resolveLaserColor(color: string, isDark: boolean): string {
	const raw = color.trim().toLowerCase()
	if (!raw || raw === 'laser') return LASER_DEFAULT_COLOR
	for (const entry of LASER_SWATCHES) {
		if (raw === entry.light || raw === entry.dark) {
			return isDark ? entry.dark : entry.light
		}
	}
	// A raw CSS color (from the settings color picker): used as-is.
	return color.trim()
}
