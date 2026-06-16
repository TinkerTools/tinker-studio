/**
 * User-facing rendering choices, shared between the React UI (which sets them)
 * and the Three.js scene (which applies them). Ports the heart of the original
 * Force Field Explorer's Display and Color menus.
 */

export type Representation = 'ball-and-stick' | 'spacefill' | 'sticks' | 'wireframe'

export type ColorMode = 'element' | 'uniform'

export interface RenderOptions {
  representation: Representation
  colorMode: ColorMode
  /** Color used when colorMode === 'uniform'. */
  uniformColor: number
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  representation: 'ball-and-stick',
  colorMode: 'element',
  uniformColor: 0xc8ccd4
}

export const REPRESENTATIONS: ReadonlyArray<{ value: Representation; label: string }> = [
  { value: 'ball-and-stick', label: 'Ball & Stick' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'sticks', label: 'Sticks' },
  { value: 'wireframe', label: 'Wireframe' }
]

export const COLOR_MODES: ReadonlyArray<{ value: ColorMode; label: string }> = [
  { value: 'element', label: 'Element' },
  { value: 'uniform', label: 'Uniform' }
]
