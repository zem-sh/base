import { useEffect, useRef, useCallback } from 'react'
import { addonMutation } from './use-remote-connection'
import type { InlineInput } from '../types'

export type SelectMode = 'NORMAL' | 'VISUAL' | 'VISUAL_LINE'

interface UseExplorerKeyboardOptions {
  paneId: number
  isFocused: boolean
  rootRef: React.RefObject<HTMLDivElement | null>
  selectedPath: string | null
  selectedPaths: Set<string>
  selectMode: SelectMode
  currentPath: string | null
  setSelectedPath: (path: string | null) => void
  setSelectedPaths: (paths: Set<string>) => void
  setSelectMode: (mode: SelectMode) => void
  setShowHidden: (fn: (prev: boolean) => boolean) => void
  setInlineInput: (input: InlineInput | null) => void
  setNotif: (msg: string | null) => void
  loadDirectory: (path: string, addToHistory?: boolean, fallbackPath?: string) => void
  goUp: () => void
  goBack: () => void
  goForward: () => void
  goHome: () => void
}

// The explorer is built as a standalone package and must not bundle its own copy
// of the keybinding engine (the app would then have two). Like `__zemPaneRegistry`,
// the engine is reached through the global bridge set by the app's keybinding init.
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

// Explorer navigation lives in the `local` scope, active only while the pane is
// focused.  Vim-style chords mirror the visual-mode state machine: `v` enters
// VISUAL, `V` enters VISUAL_LINE, `y` yanks, `Esc` exits, and movement keys
// extend the selection.
const BINDINGS: LocalBinding[] = [
  { name: 'moveDown', keys: [{ key: 'j' }], description: 'Move down' },
  { name: 'moveUp', keys: [{ key: 'k' }], description: 'Move up' },
  { name: 'open', keys: [{ key: 'l' }], description: 'Open / activate' },
  { name: 'open', keys: [{ key: 'enter' }], description: 'Open / activate' },
  { name: 'goUpDir', keys: [{ key: 'h' }], description: 'Go to parent directory' },
  { name: 'goUpDir', keys: [{ key: '-' }], description: 'Go to parent directory' },
  { name: 'goUpDir', keys: [{ key: '_' }], description: 'Go to parent directory' },
  { name: 'toggleNode', keys: [{ key: 'o' }], description: 'Expand folder / swap selection end' },
  { name: 'goTop', keys: [{ key: 'g' }, { key: 'g' }], description: 'Jump to top' },
  { name: 'goBottom', keys: [{ key: 'g', shift: true }], description: 'Jump to bottom' },
  { name: 'goBackDir', keys: [{ key: 'h', shift: true }], description: 'Back' },
  { name: 'goForwardDir', keys: [{ key: 'l', shift: true }], description: 'Forward' },
  { name: 'refreshDir', keys: [{ key: 'r' }], description: 'Refresh' },
  { name: 'goHomeDir', keys: [{ key: '~' }], description: 'Go home' },
  { name: 'toggleSelect', keys: [{ key: ' ' }], description: 'Toggle selection' },
  { name: 'selectAll', keys: [{ key: 'a' }], description: 'Select all entries' },
  { name: 'toggleVisual', keys: [{ key: 'v' }], description: 'Enter / exit visual mode' },
  { name: 'toggleVisualLine', keys: [{ key: 'v', shift: true }], description: 'Enter / exit visual line mode' },
  { name: 'yankSelection', keys: [{ key: 'y' }], description: 'Yank (copy) selection' },
  { name: 'escapeDir', keys: [{ key: 'escape' }], description: 'Cancel / exit visual mode' },
  { name: 'toggleHidden', keys: [{ key: '.' }], description: 'Toggle hidden files' },
  { name: 'deleteSelected', keys: [{ key: 'd' }], description: 'Delete selection' },
  { name: 'newEntry', keys: [{ key: 'n' }], description: 'New file / folder' },
  { name: 'renameEntry', keys: [{ key: 'r', shift: true }], description: 'Rename' },
  { name: 'copyPaths', keys: [{ key: 'c' }], description: 'Copy paths' },
  { name: 'cutPaths', keys: [{ key: 'x' }], description: 'Cut paths' },
  { name: 'halfDown', keys: [{ key: 'd', ctrl: true }], description: 'Half page down' },
  { name: 'halfUp', keys: [{ key: 'u', ctrl: true }], description: 'Half page up' },
]

export function useExplorerKeyboard({
  paneId,
  isFocused,
  rootRef,
  selectedPath,
  selectedPaths,
  selectMode,
  currentPath,
  setSelectedPath,
  setSelectedPaths,
  setSelectMode,
  setShowHidden,
  setInlineInput,
  setNotif,
  loadDirectory,
  goUp,
  goBack,
  goForward,
  goHome,
}: UseExplorerKeyboardOptions) {
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const selectedPathsRef = useRef(selectedPaths)
  selectedPathsRef.current = selectedPaths
  const currentPathRef = useRef(currentPath)
  currentPathRef.current = currentPath
  const selectModeRef = useRef(selectMode)
  selectModeRef.current = selectMode
  const selectAnchorRef = useRef(-1)
  const selectBaseRef = useRef(new Set<string>())
  const notifTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showNotif = useCallback((msg: string) => {
    setNotif(msg)
    if (notifTimer.current) clearTimeout(notifTimer.current)
    notifTimer.current = setTimeout(() => setNotif(null), 2500)
  }, [setNotif])

  const setGlobalMode = (mode: SelectMode | null) => {
    ;(window as any).__zemSetSelectMode?.(paneId, mode)
  }

  const enterVisualMode = useCallback((mode: 'VISUAL' | 'VISUAL_LINE') => {
    const rows = getRows()
    const cur = getCurIndex(rows)
    if (!rows.length || cur < 0) return
    selectAnchorRef.current = cur
    // Preserve the existing selection from a previous visual session so the
    // user can move the cursor elsewhere, re-enter visual mode, and extend
    // the selection without losing the previously selected items.
    selectBaseRef.current = new Set(selectedPathsRef.current)
    const curPath = rows[cur]?.dataset.path
    if (curPath) selectBaseRef.current.add(curPath)
    setSelectMode(mode)
    selectModeRef.current = mode
    setSelectedPaths(new Set(selectBaseRef.current))
    setGlobalMode(mode)
  }, [setSelectMode, setSelectedPaths])

  const exitSelectMode = useCallback((clearSelection = false) => {
    setSelectMode('NORMAL')
    selectModeRef.current = 'NORMAL'
    setGlobalMode('NORMAL')
    if (clearSelection) {
      setSelectedPaths(new Set())
    }
  }, [setSelectMode, setSelectedPaths])

  const normalizeTreePaths = useCallback((paths: string[]) => {
    const unique = [...new Set(paths)].sort((a, b) => a.length - b.length)
    return unique.filter((path, index) => !unique
      .slice(0, index)
      .some((parent) => path.startsWith(`${parent}/`)))
  }, [])

  const deleteSelected = useCallback(async () => {
    const selected = selectedPathsRef.current.size > 0
      ? Array.from(selectedPathsRef.current)
      : selectedPathRef.current ? [selectedPathRef.current] : []
    const paths = normalizeTreePaths(selected)
    if (paths.length === 0) return

    // Remember which item to land on after deletion: prefer the item before
    // the deleted one, falling back to the item after if it was the first.
    const rows = getRows()
    const curIdx = getCurIndex(rows)
    let fallbackPath: string | undefined
    if (curIdx > 0) {
      fallbackPath = rows[curIdx - 1]?.dataset.path
    } else if (curIdx === 0 && rows.length > 1) {
      fallbackPath = rows[1]?.dataset.path
    }

    for (const p of paths) {
      try { await addonMutation('delete_entry', { path: p }) }
      catch (e) { console.error('Delete failed:', e) }
    }
    setSelectedPaths(new Set())
    exitSelectMode(true)
    const itemLabel = paths.length === 1 ? 'item' : 'items'
    showNotif(`Deleted ${paths.length} ${itemLabel}`)
    if (currentPathRef.current) {
      loadDirectory(currentPathRef.current, false, fallbackPath)
    }
  }, [setSelectedPaths, exitSelectMode, showNotif, loadDirectory, normalizeTreePaths])

  const getRows = () => {
    const root = rootRef.current
    if (!root || !root.isConnected) return []
    const container = root.querySelector<HTMLElement>('[data-entries-container]')
    return container ? Array.from(container.querySelectorAll<HTMLElement>('[data-path]')) : []
  }

  const getCurIndex = (rows: HTMLElement[]) => {
    const selPath = selectedPathRef.current
    if (!selPath) return -1
    return rows.findIndex((row) => row.dataset.path === selPath)
  }

  const pick = (rows: HTMLElement[], index: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(index, rows.length - 1))
    const path = rows[i]?.dataset.path
    if (path) setSelectedPath(path)
  }

  const moveCursor = (rows: HTMLElement[], index: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(index, rows.length - 1))
    const path = rows[i]?.dataset.path
    if (!path) return
    setSelectedPath(path)
    if (selectModeRef.current === 'NORMAL' || selectAnchorRef.current < 0) return

    const from = Math.min(selectAnchorRef.current, i)
    const to = Math.max(selectAnchorRef.current, i)
    const nextSet = new Set(selectBaseRef.current)
    for (let rowIndex = from; rowIndex <= to; rowIndex++) {
      const rowPath = rows[rowIndex]?.dataset.path
      if (rowPath) nextSet.add(rowPath)
    }
    setSelectedPaths(nextSet)
  }

  // Handlers read refs at dispatch time (never captured in a binding closure), so
  // bindings stay registered once per focus and always act on fresh state. The
  // table is reassigned each render; the registry actions call through `actionsRef`.
  const actionsRef = useRef<Actions>(null!)
  actionsRef.current = {
    moveDown: () => {
      const rows = getRows()
      moveCursor(rows, getCurIndex(rows) + 1)
    },
    moveUp: () => {
      const rows = getRows()
      moveCursor(rows, getCurIndex(rows) - 1)
    },
    open: () => {
      const rows = getRows()
      const cur = getCurIndex(rows)
      if (rows.length && cur >= 0) rows[cur]!.click()
    },
    goUpDir: () => goUp(),
    toggleNode: () => {
      const rows = getRows()
      const cur = getCurIndex(rows)
      if (!rows.length || cur < 0) return
      if (selectModeRef.current !== 'NORMAL') {
        // Vim-style `o` in visual mode: swap cursor to the other end
        const anchor = selectAnchorRef.current
        selectAnchorRef.current = cur
        moveCursor(rows, anchor)
      } else {
        // Normal mode: expand / collapse folder, or open file preview
        const row = rows[cur]!
        const isDir = row.dataset.isDir === 'true'
        if (isDir) {
          // Folder: click the chevron to expand/collapse
          row.querySelector<HTMLElement>('[data-chevron]')?.click()
        } else {
          // File: click the row to open preview
          row.click()
        }
      }
    },
    goTop: () => moveCursor(getRows(), 0),
    goBottom: () => {
      const rows = getRows()
      moveCursor(rows, rows.length - 1)
    },
    goBackDir: () => goBack(),
    goForwardDir: () => goForward(),
    refreshDir: () => {
      if (currentPathRef.current) loadDirectory(currentPathRef.current, false)
    },
    goHomeDir: () => goHome(),
    toggleSelect: () => {
      const path = selectedPathRef.current
      if (!path) return
      const next = new Set(selectedPathsRef.current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      setSelectedPaths(next)
    },
    selectAll: () => {
      const rows = getRows()
      const paths = rows.flatMap((row) => row.dataset.path ? [row.dataset.path] : [])
      if (!paths.length) return
      const current = selectedPathRef.current
      const cursor = current && paths.includes(current) ? current : paths[0]
      const cursorIndex = paths.indexOf(cursor)
      setSelectedPath(cursor)
      setSelectedPaths(new Set(paths))
      selectBaseRef.current = new Set()
      selectAnchorRef.current = cursorIndex
      setSelectMode('VISUAL_LINE')
      selectModeRef.current = 'VISUAL_LINE'
      setGlobalMode('VISUAL_LINE')
    },
    // ── Visual mode toggles ────────────────────────────────────────────────
    toggleVisual: () => {
      const current = selectModeRef.current
      if (current === 'VISUAL') {
        exitSelectMode(false) // exit but keep selection
      } else if (current === 'VISUAL_LINE') {
        // Switch from VISUAL_LINE to VISUAL
        setSelectMode('VISUAL')
        selectModeRef.current = 'VISUAL'
        setGlobalMode('VISUAL')
      } else {
        enterVisualMode('VISUAL')
      }
    },
    toggleVisualLine: () => {
      const current = selectModeRef.current
      if (current === 'VISUAL_LINE') {
        exitSelectMode(false)
      } else if (current === 'VISUAL') {
        // Switch from VISUAL to VISUAL_LINE
        setSelectMode('VISUAL_LINE')
        selectModeRef.current = 'VISUAL_LINE'
        setGlobalMode('VISUAL_LINE')
      } else {
        enterVisualMode('VISUAL_LINE')
      }
    },
    yankSelection: () => {
      const paths = selectedPathsRef.current.size > 0
        ? Array.from(selectedPathsRef.current)
        : selectedPathRef.current ? [selectedPathRef.current] : []
      if (paths.length) {
        navigator.clipboard.writeText(paths.join('\n'))
        showNotif(`Yanked ${paths.length} ${paths.length === 1 ? 'item' : 'items'}`)
      }
      exitSelectMode(true)
    },
    escapeDir: () => {
      if (selectModeRef.current !== 'NORMAL') {
        exitSelectMode(true)
      } else {
        setSelectedPaths(new Set())
      }
    },
    toggleHidden: () => setShowHidden(prev => !prev),
    newEntry: () => setInlineInput({ mode: 'create' }),
    renameEntry: () => {
      const path = selectedPathRef.current
      if (path) {
        const name = path.split('/').pop() || ''
        setInlineInput({ mode: 'rename', path, name })
      }
    },
    copyPaths: () => {
      const paths = selectedPathsRef.current.size > 0
        ? Array.from(selectedPathsRef.current)
        : selectedPathRef.current ? [selectedPathRef.current] : []
      if (paths.length) {
        navigator.clipboard.writeText(paths.join('\n'))
        showNotif(`Copied ${paths.length} ${paths.length === 1 ? 'item' : 'items'}`)
      }
      exitSelectMode(true)
    },
    cutPaths: () => {
      const paths = selectedPathsRef.current.size > 0
        ? Array.from(selectedPathsRef.current)
        : selectedPathRef.current ? [selectedPathRef.current] : []
      if (paths.length) {
        navigator.clipboard.writeText(paths.join('\n'))
        showNotif(`Cut ${paths.length} ${paths.length === 1 ? 'item' : 'items'}`)
      }
      exitSelectMode(true)
    },
    halfDown: () => {
      const rows = getRows()
      const cur = getCurIndex(rows)
      moveCursor(rows, cur + Math.ceil(rows.length / 2))
    },
    halfUp: () => {
      const rows = getRows()
      const cur = getCurIndex(rows)
      moveCursor(rows, cur - Math.ceil(rows.length / 2))
    },
    deleteSelected: () => { void deleteSelected() },
  }

  // Local-scope bindings + scope activation live and die with focus. Only one
  // pane is focused at a time, so a single explorer holds the `local` scope and
  // no per-instance `when` guard is needed.
  useEffect(() => {
    if (!isFocused) return
    const engine = getEngine()
    if (!engine) {
      console.warn('[explorer] keybinding engine not available; keyboard nav disabled')
      return
    }
    engine.pushScope('local')
    const ids: string[] = []
    BINDINGS.forEach((b, i) => {
      const id = `local:explorer:${paneId}:${i}`
      ids.push(id)
      engine.registry.register({
        id,
        scope: 'local',
        keys: b.keys,
        description: b.description,
        group: 'Explorer',
        when: (ctx: { event: KeyboardEvent }) => {
          const target = ctx.event.target as HTMLElement | null
          const editable = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable
          return !(editable && b.name === 'escapeDir')
        },
        action: () => actionsRef.current[b.name]?.(),
      })
    })
    return () => {
      engine.popScope('local')
      for (const id of ids) engine.registry.unregister(id)
      engine.resetBuffer()
      selectModeRef.current = 'NORMAL'
      selectAnchorRef.current = -1
      selectBaseRef.current.clear()
      setSelectMode('NORMAL')
      setSelectedPaths(new Set())
      setGlobalMode(null)
    }
  }, [isFocused, paneId])

  return { deleteSelected, showNotif }
}

interface Actions {
  moveDown: () => void
  moveUp: () => void
  open: () => void
  goUpDir: () => void
  toggleNode: () => void
  goTop: () => void
  goBottom: () => void
  goBackDir: () => void
  goForwardDir: () => void
  refreshDir: () => void
  goHomeDir: () => void
  toggleSelect: () => void
  selectAll: () => void
  toggleVisual: () => void
  toggleVisualLine: () => void
  yankSelection: () => void
  escapeDir: () => void
  toggleHidden: () => void
  newEntry: () => void
  renameEntry: () => void
  copyPaths: () => void
  cutPaths: () => void
  halfDown: () => void
  halfUp: () => void
  deleteSelected: () => void
}
