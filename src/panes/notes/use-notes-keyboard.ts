import { useEffect, useRef, useCallback } from 'react'
import type { NoteSummary } from './types'

interface UseNotesKeyboardOptions {
  paneId: number
  isFocused: boolean
  welcomeRef: React.RefObject<HTMLDivElement | null>
  notes: NoteSummary[]
  loading: boolean
  composing: boolean
  /** The currently selected note id (cursor position), or null. */
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  onOpen: (id: string) => void
  onNew: () => void
  onEdit: (note: NoteSummary) => void
  onDelete: (note: NoteSummary) => void
  onCancelCompose: () => void
  yankEnabled: boolean
  showNotif: (msg: string) => void
}

// Reach the global keybinding engine (same bridge as the explorer).
function getEngine(): any {
  return (window as any).__zemKeybindingEngine
}

interface Chord {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

interface LocalBinding {
  name: keyof Actions
  keys: Chord[]
  description: string
}

const BINDINGS: LocalBinding[] = [
  { name: 'moveDown',   keys: [{ key: 'j' }],                  description: 'Move down' },
  { name: 'moveUp',     keys: [{ key: 'k' }],                  description: 'Move up' },
  { name: 'open',       keys: [{ key: 'l' }],                  description: 'Open note' },
  { name: 'open',       keys: [{ key: 'enter' }],              description: 'Open note' },
  { name: 'goTop',      keys: [{ key: 'g' }, { key: 'g' }],    description: 'Jump to top' },
  { name: 'goBottom',   keys: [{ key: 'g', shift: true }],     description: 'Jump to bottom' },
  { name: 'newEntry',   keys: [{ key: 'n' }],                  description: 'New note' },
  { name: 'editEntry',  keys: [{ key: 'e' }],                  description: 'Edit note' },
  { name: 'deleteEntry',keys: [{ key: 'd' }],                  description: 'Delete note' },
  { name: 'yankEntry',  keys: [{ key: 'y' }],                  description: 'Yank note name to clipboard' },
  { name: 'escape',     keys: [{ key: 'escape' }],             description: 'Cancel compose / deselect' },
  { name: 'halfDown',   keys: [{ key: 'd', ctrl: true }],      description: 'Half page down' },
  { name: 'halfUp',     keys: [{ key: 'u', ctrl: true }],      description: 'Half page up' },
  { name: 'refresh',    keys: [{ key: 'r' }],                  description: 'Refresh notes' },
]

export function useNotesKeyboard({
  paneId,
  isFocused,
  welcomeRef,
  notes,
  loading,
  composing,
  selectedId,
  setSelectedId,
  onOpen,
  onNew,
  onEdit,
  onDelete,
  onCancelCompose,
  yankEnabled,
  showNotif,
}: UseNotesKeyboardOptions) {
  const notesRef = useRef(notes)
  notesRef.current = notes
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const composingRef = useRef(composing)
  composingRef.current = composing
  const yankEnabledRef = useRef(yankEnabled)
  yankEnabledRef.current = yankEnabled
  const onRefreshRef = useRef<(() => void) | null>(null)

  const getNoteRows = (): HTMLElement[] => {
    const el = welcomeRef.current
    if (!el || !el.isConnected) return []
    // Each note row has a button that opens the note; query by the Edit button's
    // preceding sibling pattern: the row container with the FileText icon.
    return Array.from(el.querySelectorAll<HTMLElement>('[data-note-id]'))
  }

  const getCurIndex = (rows: HTMLElement[]): number => {
    const id = selectedIdRef.current
    if (!id) return -1
    return rows.findIndex((r) => r.dataset.noteId === id)
  }

  const moveCursor = (rows: HTMLElement[], index: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(index, rows.length - 1))
    const id = rows[i]?.dataset.noteId
    if (id) setSelectedId(id)
  }

  const resolveNote = (): NoteSummary | null => {
    const id = selectedIdRef.current
    if (!id) return null
    return notesRef.current.find((n) => n.id === id) ?? null
  }

  const actionsRef = useRef<Actions>(null!)
  actionsRef.current = {
    moveDown: () => {
      const rows = getNoteRows()
      moveCursor(rows, getCurIndex(rows) + 1)
    },
    moveUp: () => {
      const rows = getNoteRows()
      moveCursor(rows, getCurIndex(rows) - 1)
    },
    open: () => {
      if (composingRef.current) return
      const id = selectedIdRef.current
      if (id) onOpen(id)
    },
    goTop: () => moveCursor(getNoteRows(), 0),
    goBottom: () => {
      const rows = getNoteRows()
      moveCursor(rows, rows.length - 1)
    },
    newEntry: () => onNew(),
    editEntry: () => {
      const note = resolveNote()
      if (note) onEdit(note)
    },
    deleteEntry: () => {
      const note = resolveNote()
      if (note) onDelete(note)
    },
    yankEntry: () => {
      const note = resolveNote()
      if (note) { navigator.clipboard.writeText(note.name); showNotif(`Yanked "${note.name}"`) }
    },
    escape: () => {
      if (composingRef.current) { onCancelCompose(); return }
      setSelectedId(null)
    },
    halfDown: () => {
      const rows = getNoteRows()
      const cur = getCurIndex(rows)
      moveCursor(rows, cur + Math.ceil(rows.length / 2))
    },
    halfUp: () => {
      const rows = getNoteRows()
      const cur = getCurIndex(rows)
      moveCursor(rows, cur - Math.ceil(rows.length / 2))
    },
    refresh: () => onRefreshRef.current?.(),
  }

  useEffect(() => {
    if (loading) return // don't register bindings while loading
    const engine = getEngine()
    if (!engine) {
      console.warn('[notes] keybinding engine not available; keyboard nav disabled')
      return
    }
    engine.pushScope('local')
    const ids: string[] = []
    BINDINGS.forEach((b, i) => {
      const id = `local:notes:${paneId}:${i}`
      ids.push(id)
      engine.registry.register({
        id,
        scope: 'local',
        keys: b.keys,
        description: b.description,
        group: 'Notes',
        when: (ctx: { event: KeyboardEvent }) => {
          const target = ctx.event.target as HTMLElement | null
          const editable =
            target?.tagName === 'INPUT' ||
            target?.tagName === 'TEXTAREA' ||
            target?.tagName === 'SELECT' ||
            target?.isContentEditable
          // In compose mode, only Escape passes through to cancel.
          if (composingRef.current) {
            return b.name === 'escape' && !editable
          }
          // yankEntry only active when yankEnabled setting is on.
          if (b.name === 'yankEntry' && !yankEnabledRef.current) return false
          return !editable
        },
        action: () => actionsRef.current[b.name]?.(),
      })
    })
    return () => {
      engine.popScope('local')
      for (const id of ids) engine.registry.unregister(id)
      engine.resetBuffer()
    }
  }, [paneId, loading])

  return {
    /** Call this to wire up the onRefresh callback (stable ref pattern). */
    setOnRefresh: (fn: () => void) => { onRefreshRef.current = fn },
  }
}

interface Actions {
  moveDown: () => void
  moveUp: () => void
  open: () => void
  goTop: () => void
  goBottom: () => void
  newEntry: () => void
  editEntry: () => void
  deleteEntry: () => void
  yankEntry: () => void
  escape: () => void
  halfDown: () => void
  halfUp: () => void
  refresh: () => void
}
