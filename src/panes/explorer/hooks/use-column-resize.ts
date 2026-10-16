import { useState, useRef, useCallback } from 'react'
import type { ColWidths } from '../types'

const DEFAULT_COL_WIDTHS: ColWidths = { name: 0, size: 80, perms: 100, modified: 120 }

export function useColumnResize() {
  const [colWidths, setColWidths] = useState<ColWidths>(DEFAULT_COL_WIDTHS)
  const resizingRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null)

  const startResize = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = colWidths[col as keyof ColWidths]
    resizingRef.current = { col, startX, startWidth }

    const onMouseMove = (me: MouseEvent) => {
      if (!resizingRef.current) return
      const diff = me.clientX - resizingRef.current.startX
      const newWidth = Math.max(40, resizingRef.current.startWidth - diff)
      setColWidths(prev => ({ ...prev, [resizingRef.current!.col]: newWidth }))
    }

    const onMouseUp = () => {
      resizingRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [colWidths])

  return { colWidths, startResize }
}
