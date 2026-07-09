/**
 * User-facing rendering choices, shared between the React UI (which sets them)
 * and the Three.js scene (which applies them). Ports the heart of the original
 * Tinker-FFE's Display and Color menus.
 */

export type Representation = 'ball-and-stick' | 'spacefill' | 'tube' | 'wireframe'

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
  /**
   * Camera field of view in degrees. Smaller = telephoto (far + flat), larger =
   * wide angle (near + strong perspective). The subject's on-screen size is held
   * constant as this changes; only the perspective distortion varies.
   */
  fov: number
  /** Atom radius multiplier (application-level graphics setting). */
  ballScale: number
  /** Bond cylinder radius multiplier (application-level graphics setting). */
  bondScale: number
  /** Wireframe line width in screen pixels (Wireframe representation only). */
  wireWidth: number
  /** Viewport background color. */
  backgroundColor: number
  /**
   * Lighting contrast, 0..1. Shifts the balance between the camera headlights and
   * ambient fill: 0 = flat / evenly lit, 1 = strong shading with a dim backside.
   */
  contrast: number
  /** Surface finish, 0..1: 0 = matte, 1 = glossy. 0.5 ≈ the original look. */
  glossiness: number
  /** Antialiasing (SMAA) on/off. */
  antialias: boolean
  /** Render the background as a subtle vertical gradient instead of a flat color. */
  backgroundGradient: boolean
  /** Color of the selection highlight spheres. */
  highlightColor: number
  /** Atom-label text color. */
  labelColor: number
  /** Atom-label size multiplier. */
  labelScale: number
  /** Depth cueing (fog) amount, 0..1. 0 = off. Distant atoms fade to background. */
  fog: number
  /** Screen-space ambient occlusion (soft contact shadows). */
  ambientOcclusion: boolean
  /** Dark silhouette outline around shapes (depth-edge). */
  outline: boolean
  /** Orthographic projection (vs perspective). */
  orthographic: boolean
  /** Draw the periodic box, when the structure carries one. */
  showBox: boolean
}

/** Field-of-view range for the perspective control (degrees). */
export const FOV_MIN = 5
export const FOV_MAX = 90
export const FOV_DEFAULT = 50

export const DEFAULT_BACKGROUND = 0x12141a

/** Default lighting contrast (0..1); ~matches the original fixed light balance. */
export const CONTRAST_DEFAULT = 0.5
/** Default surface finish (0..1); reproduces the original 0.4 material roughness. */
export const GLOSSINESS_DEFAULT = 0.5
export const HIGHLIGHT_COLOR_DEFAULT = 0xffd400
export const LABEL_COLOR_DEFAULT = 0xffe066

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  representation: 'tube',
  colorMode: 'element',
  uniformColor: 0xc8ccd4,
  showHydrogens: true,
  showLabels: false,
  restrictToSelection: false,
  fov: FOV_DEFAULT,
  ballScale: 1,
  bondScale: 1,
  wireWidth: 1,
  backgroundColor: DEFAULT_BACKGROUND,
  contrast: CONTRAST_DEFAULT,
  glossiness: GLOSSINESS_DEFAULT,
  antialias: true,
  backgroundGradient: false,
  highlightColor: HIGHLIGHT_COLOR_DEFAULT,
  labelColor: LABEL_COLOR_DEFAULT,
  labelScale: 1,
  fog: 0,
  ambientOcclusion: false,
  outline: false,
  orthographic: false,
  showBox: false
}

export const REPRESENTATIONS: ReadonlyArray<{ value: Representation; label: string }> = [
  { value: 'ball-and-stick', label: 'Ball & Stick' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'tube', label: 'Tube' },
  { value: 'wireframe', label: 'Wireframe' }
]

export const COLOR_MODES: ReadonlyArray<{ value: ColorMode; label: string }> = [
  { value: 'element', label: 'Element' },
  { value: 'uniform', label: 'Custom' },
  { value: 'residue', label: 'Residue' },
  { value: 'chain', label: 'Chain' },
  { value: 'charge', label: 'Charge' }
]
