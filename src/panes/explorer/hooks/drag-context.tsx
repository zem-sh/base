import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface DragState {
  paths: string[]
  sourcePaneId: string
  sourceConnectionType: string
}

interface DragContextValue {
  dragState: DragState | null
  startDrag: (state: DragState) => void
  endDrag: () => void
}

const DragContext = createContext<DragContextValue>({
  dragState: null,
  startDrag: () => {},
  endDrag: () => {},
})

export function DragProvider({ children }: { children: ReactNode }) {
  const [dragState, setDragState] = useState<DragState | null>(null)

  const startDrag = useCallback((state: DragState) => {
    setDragState(state)
  }, [])

  const endDrag = useCallback(() => {
    setDragState(null)
  }, [])

  return (
    <DragContext.Provider value={{ dragState, startDrag, endDrag }}>
      {children}
    </DragContext.Provider>
  )
}

export function useDragContext() {
  return useContext(DragContext)
}
