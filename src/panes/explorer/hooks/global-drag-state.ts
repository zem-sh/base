export interface DragState {
  paths: string[]
  sourcePaneId: number
  sourceConnectionType: string
}

declare global {
  interface Window {
    __explorerDragState: DragState | null
    __explorerDragListeners: Array<() => void>
  }
}

if (typeof window !== 'undefined') {
  window.__explorerDragState = null
  window.__explorerDragListeners = []
}

export function getGlobalDragState(): DragState | null {
  return window.__explorerDragState
}

export function subscribeGlobalDragState(listener: () => void): () => void {
  window.__explorerDragListeners.push(listener)
  return () => {
    window.__explorerDragListeners = window.__explorerDragListeners.filter(l => l !== listener)
  }
}

export function setGlobalDragState(state: DragState | null) {
  window.__explorerDragState = state
  window.__explorerDragListeners.forEach(l => l())
}
