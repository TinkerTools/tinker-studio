import { useEffect, useRef } from 'react'
import { createScene, type SceneHandle } from './scene'
import type { Structure } from '../core/types'
import type { RenderOptions } from './renderOptions'

/**
 * React wrapper that owns the lifetime of the Three.js scene. React feeds in the
 * structure, render options, and (for trajectories) the current frame's
 * coordinates; everything inside the WebGL canvas is plain Three.js.
 */
export function Viewer({
  structure,
  options,
  frameCoords
}: {
  structure: Structure | null
  options: RenderOptions
  frameCoords: Float32Array | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handle = createScene(container)
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  useEffect(() => {
    handleRef.current?.setOptions(options)
  }, [options])

  // Setting the structure resets coordinates to the base frame and reframes the
  // camera, so apply it before any frame override.
  useEffect(() => {
    handleRef.current?.setStructure(structure)
  }, [structure])

  useEffect(() => {
    if (frameCoords) handleRef.current?.setFrame(frameCoords)
  }, [frameCoords])

  return <div className="viewer" ref={containerRef} />
}
