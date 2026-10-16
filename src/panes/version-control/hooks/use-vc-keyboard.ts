import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { useVCSettings } from '../settings-store'
import type { ChangedFile } from '../types'

export type SelectMode = 'NORMAL' | 'VISUAL' | 'VISUAL_LINE'

interface UseVCKeyboardOptions {
  paneId: number
  isFocused: boolean
  /** The scroll container holding the changes list. Rows are found via `[data-path]`. */
  containerRef: React.RefObject<HTMLDivElement | null>
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onShowDiff: (path: string, staged: boolean) => void
  onSwitchTab: (tab: 'git' | 'github') => void
}

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
  { name: 'moveDown', keys: [{ key: 'j' }], description: 'Move down' },
  { name: 'moveUp', keys: [{ key: 'k' }], description: 'Move up' },
  { name: 'toggleNode', keys: [{ key: 'o' }], description: 'Expand / collapse folder' },
  { name: 'stageToggle', keys: [{ key: 's' }], description: 'Stage / unstage file' },
  { name: 'discardFile', keys: [{ key: 'd' }], description: 'Discard changes' },
  { name: 'showDiff', keys: [{ key: 'l' }], description: 'Show diff' },
  { name: 'showDiff', keys: [{ key: 'enter' }], description: 'Show diff' },
  { name: 'toggleVisual', keys: [{ key: 'v' }], description: 'Visual mode' },
  { name: 'toggleVisualLine', keys: [{ key: 'v', shift: true }], description: 'Visual line mode' },
  { name: 'yankSelection', keys: [{ key: 'y' }], description: 'Yank (copy) paths' },
  { name: 'switchTab', keys: [{ key: 'tab' }], description: 'Switch to GitHub tab' },
  { name: 'goTop', keys: [{ key: 'g' }, { key: 'g' }], description: 'Jump to top' },
  { name: 'goBottom', keys: [{ key: 'g', shift: true }], description: 'Jump to bottom' },
  { name: 'escapeDir', keys: [{ key: 'escape' }], description: 'Exit visual mode' },
  { name: 'toggleSelect', keys: [{ key: ' ' }], description: 'Toggle selection' },
  { name: 'selectAll', keys: [{ key: 'a' }], description: 'Select all changes' },
  { name: 'refreshStatus', keys: [{ key: 'r' }], description: 'Refresh changes' },
  { name: 'halfDown', keys: [{ key: 'd', ctrl: true }], description: 'Half page down' },
  { name: 'halfUp', keys: [{ key: 'u', ctrl: true }], description: 'Half page up' },
]

export function useVCKeyboard({
  paneId,
  isFocused,
  containerRef,
  onStage,
  onUnstage,
  onDiscard,
  onShowDiff,
  onSwitchTab,
}: UseVCKeyboardOptions) {
  const selectedFile = useStore(s => s.selectedFile)
  const setSelectedFile = useStore(s => s.setSelectedFile)
  const visualSelection = useStore(s => s.visualSelection)
  const setVisualSelection = useStore(s => s.setVisualSelection)
  const status = useStore(s => s.status)
  const activeTab = useStore(s => s.activeTab)
  const { confirmDiscard } = useVCSettings()

  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile
  const visualSelectionRef = useRef(visualSelection)
  visualSelectionRef.current = visualSelection
  const statusRef = useRef(status)
  statusRef.current = status
  const selectModeRef = useRef<SelectMode>('NORMAL')
  const selectAnchorRef = useRef(-1)
  const selectBaseRef = useRef(new Set<string>())

  const setGlobalMode = (mode: SelectMode | null) => {
    ;(window as any).__zemSetSelectMode?.(paneId, mode)
  }

  // ── DOM row navigation ─────────────────────────────────────────────────────
  // The changes list renders a tree (ChangesList → TreeNode): leaf files render
  // <FileItem data-path> and directories render a row with data-path as well.
  // Querying the DOM (instead of the flat status.files list) means J/K walk
  // every *visible* node — files AND expanded folders — in render order, and
  // collapsed folders' children are naturally skipped.
  const getRows = useCallback((): HTMLElement[] => {
    const container = containerRef.current
    if (!container || !container.isConnected) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-path]'))
  }, [containerRef])

  const getCurIndex = useCallback((rows: HTMLElement[]) => {
    const path = selectedFileRef.current
    if (!path) return -1
    return rows.findIndex((row) => row.dataset.path === path)
  }, [])

  const moveCursor = useCallback((rows: HTMLElement[], index: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(index, rows.length - 1))
    const path = rows[i]?.dataset.path
    if (!path) return
    setSelectedFile(path)
    if (selectModeRef.current === 'NORMAL' || selectAnchorRef.current < 0) return

    const from = Math.min(selectAnchorRef.current, i)
    const to = Math.max(selectAnchorRef.current, i)
    const nextSet = new Set(selectBaseRef.current)
    for (let rowIndex = from; rowIndex <= to; rowIndex++) {
      const rowPath = rows[rowIndex]?.dataset.path
      if (rowPath) nextSet.add(rowPath)
    }
    setVisualSelection(Array.from(nextSet))
  }, [setSelectedFile, setVisualSelection])

  // Look up real file metadata (staged/status) from the flat status list. Directory
  // paths return undefined — actions that support folders handle that case.
  const getFile = useCallback((path: string): ChangedFile | undefined => {
    return statusRef.current?.files.find((f) => f.path === path)
  }, [])

  // Mirror changes-list hasStaged/hasUnstaged for directory paths: a folder has
  // staged children iff any file under its path prefix is staged (and vice versa).
  const folderHasStaged = useCallback((path: string): boolean => {
    const prefix = path + '/'
    return (statusRef.current?.files ?? []).some((f) => f.path.startsWith(prefix) && f.staged)
  }, [])

  const folderHasUnstaged = useCallback((path: string): boolean => {
    const prefix = path + '/'
    return (statusRef.current?.files ?? []).some((f) => f.path.startsWith(prefix) && !f.staged)
  }, [])

  const exitSelectMode = useCallback((clearSelection = false) => {
    selectModeRef.current = 'NORMAL'
    setGlobalMode('NORMAL')
    if (clearSelection) {
      setVisualSelection([])
    }
  }, [setVisualSelection])

  const normalizeTreePaths = useCallback((paths: string[]) => {
    const unique = [...new Set(paths)].sort((a, b) => a.length - b.length)
    return unique.filter((path, index) => !unique
      .slice(0, index)
      .some((parent) => path.startsWith(`${parent}/`)))
  }, [])

  const enterVisualMode = useCallback((mode: 'VISUAL' | 'VISUAL_LINE') => {
    const rows = getRows()
    const cur = getCurIndex(rows)
    if (!rows.length || cur < 0) return
    selectAnchorRef.current = cur
    // Visual mode owns the current contiguous range. Start with the cursor,
    // rather than retaining a stale range from a previous visual session.
    selectBaseRef.current = new Set()
    const curPath = rows[cur]?.dataset.path
    if (curPath) selectBaseRef.current.add(curPath)
    selectModeRef.current = mode
    setVisualSelection(Array.from(selectBaseRef.current))
    setGlobalMode(mode)
  }, [getRows, getCurIndex, setVisualSelection])

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
    toggleNode: () => {
      // Click the folder's chevron to expand / collapse it. File rows have no
      // chevron, so `o` is a no-op on them.
      const rows = getRows()
      const cur = getCurIndex(rows)
      if (!rows.length || cur < 0) return
      rows[cur]?.querySelector<HTMLElement>('[data-chevron]')?.click()
    },
    stageToggle: () => {
      const sel = visualSelectionRef.current
      const inVisual = selectModeRef.current !== 'NORMAL' && sel.length > 0
      if (inVisual) {
        for (const path of normalizeTreePaths(sel)) {
          const f = getFile(path)
          if (f) {
            if (f.staged) onUnstage(path)
            else onStage(path)
          } else if (folderHasStaged(path)) {
            onUnstage(path) // folder has staged children → unstage subtree
          } else if (folderHasUnstaged(path)) {
            onStage(path) // folder has unstaged children → stage subtree
          }
        }
        exitSelectMode(true)
      } else {
        const path = selectedFileRef.current
        if (!path) return
        const f = getFile(path)
        if (f) {
          if (f.staged) onUnstage(path)
          else onStage(path)
        } else if (folderHasStaged(path)) {
          onUnstage(path) // folder has staged children → unstage subtree
        } else if (folderHasUnstaged(path)) {
          onStage(path) // folder has unstaged children → stage subtree
        }
      }
    },
    discardFile: () => {
      const sel = visualSelectionRef.current
      const inVisual = selectModeRef.current !== 'NORMAL' && sel.length > 0
      const paths = inVisual
        ? normalizeTreePaths(sel)
        : selectedFileRef.current ? [selectedFileRef.current] : []

      if (!paths.length) return

      if (confirmDiscard && !window.confirm(`Discard changes to ${paths.length} file(s)?`)) return

      for (const path of paths) {
        const f = getFile(path)
        if (!f || f.status !== 'untracked') onDiscard(path)
      }
      if (inVisual) exitSelectMode(true)
    },
    showDiff: () => {
      const path = selectedFileRef.current
      if (!path) return
      const f = getFile(path)
      if (!f) return // folder: no diff to show
      onShowDiff(path, f.staged)
    },
    toggleVisual: () => {
      const current = selectModeRef.current
      if (current === 'VISUAL') {
        exitSelectMode(false)
      } else if (current === 'VISUAL_LINE') {
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
        selectModeRef.current = 'VISUAL_LINE'
        setGlobalMode('VISUAL_LINE')
      } else {
        enterVisualMode('VISUAL_LINE')
      }
    },
    yankSelection: () => {
      const sel = visualSelectionRef.current
      const paths = sel.length > 0
        ? sel
        : selectedFileRef.current ? [selectedFileRef.current] : []
      if (paths.length) {
        navigator.clipboard.writeText(paths.join('\n'))
      }
      exitSelectMode(true)
    },
    switchTab: () => {
      onSwitchTab(activeTab === 'git' ? 'github' : 'git')
    },
    goTop: () => moveCursor(getRows(), 0),
    goBottom: () => {
      const rows = getRows()
      moveCursor(rows, rows.length - 1)
    },
    escapeDir: () => {
      if (selectModeRef.current !== 'NORMAL') {
        exitSelectMode(true)
      }
    },
    toggleSelect: () => {
      const path = selectedFileRef.current
      if (!path) return
      const arr = visualSelectionRef.current
      const next = arr.includes(path)
        ? arr.filter(p => p !== path)
        : [...arr, path]
      setVisualSelection(next)
    },
    selectAll: () => {
      const rows = getRows()
      const paths = rows.flatMap((row) => row.dataset.path ? [row.dataset.path] : [])
      if (!paths.length) return
      const current = selectedFileRef.current
      const cursor = current && paths.includes(current) ? current : paths[0]
      setSelectedFile(cursor)
      setVisualSelection(paths)
      selectBaseRef.current = new Set()
      selectAnchorRef.current = paths.indexOf(cursor)
      selectModeRef.current = 'VISUAL_LINE'
      setGlobalMode('VISUAL_LINE')
    },
    refreshStatus: () => {
      window.dispatchEvent(new CustomEvent('pane-action', {
        detail: { paneId, action: 'refresh' },
      }))
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
  }

  useEffect(() => {
    if (!isFocused) return
    const engine = getEngine()
    if (!engine) return
    engine.pushScope('local')
    const ids: string[] = []
    BINDINGS.forEach((b, i) => {
      const id = `local:vc:${paneId}:${i}`
      ids.push(id)
      engine.registry.register({
        id,
        scope: 'local',
        keys: b.keys,
        description: b.description,
        group: 'Version Control',
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
      setVisualSelection([])
      setGlobalMode(null)
    }
  }, [isFocused, paneId])

  return { exitSelectMode }
}

interface Actions {
  moveDown: () => void
  moveUp: () => void
  toggleNode: () => void
  stageToggle: () => void
  discardFile: () => void
  showDiff: () => void
  toggleVisual: () => void
  toggleVisualLine: () => void
  yankSelection: () => void
  switchTab: () => void
  goTop: () => void
  goBottom: () => void
  escapeDir: () => void
  toggleSelect: () => void
  selectAll: () => void
  refreshStatus: () => void
  halfDown: () => void
  halfUp: () => void
}
