import { useEffect, useCallback, useState, type RefObject } from 'react'
import { getGlobalDragState, subscribeGlobalDragState } from './global-drag-state'

interface UseDragDropOptions {
  enabled: boolean
  currentPath: string | null
  rootRef: RefObject<HTMLDivElement | null>
  dropTargetRef: RefObject<HTMLDivElement | null>
  paneId: number
  connectionType: string
  onDrop?: (paths: string[]) => void
}

export function useDragDrop({ enabled, currentPath, rootRef, dropTargetRef, paneId, connectionType, onDrop }: UseDragDropOptions) {
  const [dragVersion, setDragVersion] = useState(0)

  useEffect(() => {
    return subscribeGlobalDragState(() => setDragVersion(v => v + 1))
  }, [])

  const handleDrop = useCallback(async (paths: string[]) => {
    if (!currentPath) return
    onDrop?.(paths)
  }, [currentPath, onDrop])

  // Internal drop handler
  const handleInternalDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const state = getGlobalDragState()
    if (!state || state.sourcePaneId === paneId) return
    await handleDrop(state.paths)
  }, [paneId, handleDrop])

  // Internal dragover handler
  const handleDragOver = useCallback((e: DragEvent) => {
    const state = getGlobalDragState()
    if (!state || state.sourcePaneId === paneId) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  }, [paneId])

  // Listen for internal drag and drop on the scroll container
  useEffect(() => {
    if (!enabled || !currentPath) return
    const el = dropTargetRef.current
    if (!el) return

    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('drop', handleInternalDrop)
    return () => {
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('drop', handleInternalDrop)
    }
  }, [enabled, currentPath, dropTargetRef, handleDragOver, handleInternalDrop])
}
