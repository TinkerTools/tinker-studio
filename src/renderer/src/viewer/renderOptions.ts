/**
 * User-facing rendering choices, shared between the React UI (which sets them)
 * and the Three.js scene (which applies them). Ports the heart of the original
 * Force Field Explorer's Display and Color menus.
 */

export type Representation = 'ball-and-stick' | 'spacefill' | 'sticks' | 'wireframe' | 'tube'

export type ColorMode = 'element' | 'uniform' | 'residue' | 'chain' | 'charge'

export interface RenderOptions {
  representation: Representation
  colorMode: ColorMode
  /** Color used when colorMode === 'uniform'. */
  uniformColor: number
  showHydrogens: boolean
  /** Label the selected atoms in the viewport. */
  showLabels: boolean
  /** Render only the selected atoms (and their bonds). */
  restrictToSelection: boolean
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  representation: 'ball-and-stick',
  colorMode: 'element',
  uniformColor: 0xc8ccd4,
  showHydrogens: true,
  showLabels: false,
  restrictToSelection: false
}

export const REPRESENTATIONS: ReadonlyArray<{ value: Representation; label: string }> = [
  { value: 'ball-and-stick', label: 'Ball & Stick' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'sticks', label: 'Sticks' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'tube', label: 'Tube' }
]

export const COLOR_MODES: ReadonlyArray<{ value: ColorMode; label: string }> = [
  { value: 'element', label: 'Element' },
  { value: 'uniform', label: 'Uniform' },
  { value: 'residue', label: 'Residue' },
  { value: 'chain', label: 'Chain' },
  { value: 'charge', label: 'Charge' }
]
