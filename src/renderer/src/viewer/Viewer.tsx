import { useEffect, useRef } from 'react'
import { createScene, type SceneHandle, type Renderable, type PickResult } from './scene'
import type { RenderOptions } from './renderOptions'

/**
 * React wrapper that owns the lifetime of the Three.js scene. It feeds in the
 * renderables (one per visible system) + options whenever `sceneKey` changes,
 * forwards highlight markers, and — when picking is enabled — turns a click
 * (not a drag) into an atom pick.
 */
export function Viewer({
  renderables,
  options,
  sceneKey,
  pickingEnabled = false,
  highlights,
  onPick
}: {
  renderables: Renderable[]
  options: RenderOptions
  sceneKey: string
  pickingEnabled?: boolean
  highlights?: Array<[number, number, number]>
  onPick?: (result: PickResult | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  const renderablesRef = useRef(renderables)
  const optionsRef = useRef(options)
  const pickingRef = useRef(pickingEnabled)
  const onPickRef = useRef(onPick)
  renderablesRef.current = renderables
  optionsRef.current = options
  pickingRef.current = pickingEnabled
  onPickRef.current = onPick

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
      onPickRef.current(handle.pick(e.clientX, e.clientY))
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
    handleRef.current?.setScene(renderablesRef.current, optionsRef.current)
  }, [sceneKey])

  useEffect(() => {
    handleRef.current?.setHighlights(highlights ?? [])
  }, [highlights])

  return <div className={pickingEnabled ? 'viewer picking' : 'viewer'} ref={containerRef} />
}
