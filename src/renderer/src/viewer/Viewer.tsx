import { useEffect, useRef, type MutableRefObject } from 'react'
import {
  createScene,
  type SceneHandle,
  type Renderable,
  type PickResult,
  type HighlightItem,
  type ManipTarget
} from './scene'
import type { Transform } from '../core/transform'
import type { RenderOptions } from './renderOptions'

/**
 * Heavy per-frame scene inputs (the full structure + coordinate arrays). These
 * are passed through a ref rather than props on purpose: in dev, React 19's
 * component-render performance tracking deep-walks and String()-ifies every
 * prop on each render, and stringifying a 19k-atom structure every frame
 * allocated ~15MB/frame and ballooned the V8 heap. A ref's identity is stable,
 * so React never inspects its contents.
 */
export interface ViewerInputs {
  renderables: Renderable[]
  liveUpdate: { systemId: string; coords: Float32Array | null; transform?: Transform } | null
}

/**
 * React wrapper that owns the lifetime of the Three.js scene. It feeds in the
 * renderables (one per visible system) + options whenever `sceneKey` changes,
 * forwards highlight markers, and — when picking is enabled — turns a click
 * (not a drag) into an atom pick.
 */
export function Viewer({
  inputsRef,
  options,
  sceneKey,
  pickingEnabled = false,
  highlights,
  onPick,
  manipulation = null,
  onTransform,
  coordKey = ''
}: {
  /** Heavy scene data (structure + coords), passed by ref to keep it out of prop diffing. */
  inputsRef: MutableRefObject<ViewerInputs>
  options: RenderOptions
  sceneKey: string
  pickingEnabled?: boolean
  highlights?: HighlightItem[]
  onPick?: (result: PickResult | null, additive: boolean) => void
  manipulation?: ManipTarget | null
  onTransform?: (systemId: string, transform: Transform) => void
  coordKey?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  const optionsRef = useRef(options)
  const pickingRef = useRef(pickingEnabled)
  const onPickRef = useRef(onPick)
  const manipulationRef = useRef(manipulation)
  const onTransformRef = useRef(onTransform)
  optionsRef.current = options
  pickingRef.current = pickingEnabled
  onPickRef.current = onPick
  manipulationRef.current = manipulation
  onTransformRef.current = onTransform

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handle = createScene(container)
    handleRef.current = handle

    // Distinguish a click (pick) from a drag (rotate).
    let downX = 0
    let downY = 0
    const onDown = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
    }
    const onUp = (e: PointerEvent): void => {
      if (!pickingRef.current || !onPickRef.current) return
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return
      onPickRef.current(handle.pick(e.clientX, e.clientY), e.metaKey || e.ctrlKey)
    }
    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointerup', onUp)

    return () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointerup', onUp)
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  useEffect(() => {
    handleRef.current?.setScene(inputsRef.current.renderables, optionsRef.current)
  }, [sceneKey])

  useEffect(() => {
    handleRef.current?.setHighlights(highlights ?? [])
  }, [highlights])

  const manipKey = manipulation ? `${manipulation.systemId}:${manipulation.mode}` : 'none'
  useEffect(() => {
    handleRef.current?.setManipulation(
      manipulationRef.current,
      (id, t) => onTransformRef.current?.(id, t)
    )
  }, [manipKey, sceneKey])

  useEffect(() => {
    handleRef.current?.setFov(options.fov)
  }, [options.fov])

  useEffect(() => {
    handleRef.current?.setBackground(options.backgroundColor)
  }, [options.backgroundColor])

  useEffect(() => {
    handleRef.current?.setContrast(options.contrast)
  }, [options.contrast])

  useEffect(() => {
    handleRef.current?.setBackgroundGradient(options.backgroundGradient)
  }, [options.backgroundGradient])

  useEffect(() => {
    handleRef.current?.setFinish(options.glossiness)
  }, [options.glossiness])

  useEffect(() => {
    handleRef.current?.setAntialias(options.antialias)
  }, [options.antialias])

  useEffect(() => {
    handleRef.current?.setHighlightStyle(
      options.highlightColor,
      options.labelColor,
      options.labelScale
    )
  }, [options.highlightColor, options.labelColor, options.labelScale])

  useEffect(() => {
    handleRef.current?.setFog(options.fog)
  }, [options.fog])

  useEffect(() => {
    handleRef.current?.setOrthographic(options.orthographic)
  }, [options.orthographic])

  useEffect(() => {
    handleRef.current?.setOutline(options.outline)
  }, [options.outline])

  useEffect(() => {
    handleRef.current?.setAmbientOcclusion(options.ambientOcclusion)
  }, [options.ambientOcclusion])

  // Coordinate-only changes (trajectory frame, gizmo/center transforms) update
  // the merged mesh in place instead of triggering a full rebuild.
  useEffect(() => {
    const u = inputsRef.current.liveUpdate
    if (u) handleRef.current?.updateSystem(u.systemId, u.coords, u.transform)
  }, [coordKey])

  return (
    <div className={pickingEnabled ? 'viewer picking' : 'viewer'} ref={containerRef}>
      <button
        className="viewer-recenter"
        title="Recenter view"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={() => handleRef.current?.recenter()}
      >
        Recenter
      </button>
    </div>
  )
}
