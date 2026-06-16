import { useEffect, useRef } from 'react'
import { createScene, type SceneHandle } from './scene'
import type { Structure } from '../core/types'

/**
 * React wrapper that owns the lifetime of the Three.js scene. React manages the
 * DOM container and feeds in the current structure; everything inside the WebGL
 * canvas is plain Three.js so we keep full, framework-independent control.
 */
export function Viewer({ structure }: { structure: Structure | null }) {
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
    handleRef.current?.setStructure(structure)
  }, [structure])

  return <div className="viewer" ref={containerRef} />
}
