import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { Spinner } from '@mynaui/icons-react'
import { usePane, type PaneComponentProps } from '@zem-sh/pane'
import { FilePreview } from './preview/file-preview'
import { normalizeViewerPayload, inlineUrl, type NormalizedViewerPayload } from './preview/types'

// Self-inject CSS so styles travel with the pane regardless of how it's loaded
import styles from './styles.css?inline'
if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="explorer"]')) {
  const s = document.createElement('style'); s.textContent = styles; s.setAttribute('data-pane-css', 'explorer'); document.head.appendChild(s)
}

// Access the shared paneRegistry via the global bridge
const paneRegistry = (window as any).__zemPaneRegistry
import type { FileEntry, InlineInput, RemoteConnectionConfig, ExplorerPersistedState } from './types'

import { sortEntries } from './utils'
import { setSelectedPath as storeSetSelectedPath } from './store'
import { Toolbar } from './components/toolbar'
import { ColumnHeader } from './components/column-header'
import { InlineInput as InlineInputComponent } from './components/inline-input'
import { StatusBar } from './components/status-bar'
import { TreeNode } from './components/tree-node'
import { WelcomeScreen } from './components/welcome-screen'
import { explorerLaunchSchema } from './launch-schema'
import { useColumnResize } from './hooks/use-column-resize'
import { useExplorerKeyboard, type SelectMode } from './hooks/use-explorer-keyboard'
import { useRemoteConnection, fetchHomeDir, addonQuery, addonMutation, setServerUrl, setUserUuid, setWorkspaceId } from './hooks/use-remote-connection'
import { useDragDrop } from './hooks/use-drag-drop'

let pendingAutoConnectLocal = 0

export function ExplorerPane({ paneId, isFocused, params }: PaneComponentProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [selectedPath, _setSelectedPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState<SelectMode>('NORMAL')
  const [showHidden, setShowHidden] = useState(false)
  const [treeKey, setTreeKey] = useState(0)
  const [notif, setNotif] = useState<string | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInput | null>(null)
  const [restoreSel, setRestoreSel] = useState<string | null | undefined>(undefined)

  // ── File preview (inline viewer) ──────────────────────────────────────────
  // viewerOnly: launched as a clean viewer (no tree/toolbar) or expanded from
  // inline preview. When active the entire pane shows only the FilePreview.
  const isViewerOnlyLaunch = !!(params?.launch as Record<string,unknown>|undefined)?.viewerOnly
  const [viewerOnly, setViewerOnly] = useState(isViewerOnlyLaunch)
  const [previewPayload, setPreviewPayload] = useState<NormalizedViewerPayload | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const previewContentRef = useRef(previewContent)
  previewContentRef.current = previewContent

  const entriesContainerRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const scrollThumbRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingPathRef = useRef<string | null>(null)
  const restoreScrollTopRef = useRef(0)
  const restoreAttemptRef = useRef(0)
  const connectionEpochRef = useRef(0)
  const intentionallyDisconnectedRef = useRef(false)
  const restoreSelRef = useRef(restoreSel)
  restoreSelRef.current = restoreSel
  const pendingOpenFileRef = useRef<string | null>(null)
  const loadDirectoryRef = useRef<(path: string, addToHistory?: boolean, fallbackPath?: string, connectionState?: import('./hooks/use-remote-connection').RemoteState) => Promise<void>>(null!)

  const remote = useRemoteConnection()

  // The pane's displayed name is driven server-side: the explorer addon
  // persists the active connection's label via `set_temp_name` (clearing it
  // for local browsing), and the host broadcasts `pane_updated` so the
  // header/sidebar re-fetch. No client-side title resolution here.

  const { rootRef } = usePane(
    paneId,
    isFocused,
    () => entriesContainerRef.current?.focus(),
    (action, path) => {
      if (action === 'refresh' && currentPath) {
        loadDirectory(currentPath, false)
      } else if (action === 'copy' && path) {
        navigator.clipboard.writeText(path).then(() => setNotif("Copied"))
      } else if (action === 'cut' && path) {
        navigator.clipboard.writeText(path).then(() => setNotif("Cut"))
      } else if (action === 'paste' && currentPath) {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            setNotif("Pasted")
            setTreeKey(k => k + 1)
            loadDirectory(currentPath, false)
          }
        })
      } else if (action === 'delete' && path) {
        remote.deleteEntry(path).then(() => {
          setNotif("Deleted")
          setTreeKey(k => k + 1)
          if (currentPath) loadDirectory(currentPath, false)
        }).catch((e) => setError(String(e)))
      } else if (action === 'new-file') {
        setInlineInput({ mode: 'create' })
      } else if (action === 'rename' && path) {
        const name = path.split('/').pop() || ''
        setInlineInput({ mode: 'rename', path, name })
      }
    },
  )

  const setSelectedPath = useCallback((path: string | null) => {
    _setSelectedPath(path)
    storeSetSelectedPath(paneId, path)
  }, [paneId])

  const { colWidths, startResize } = useColumnResize()

  // ── Native drag & drop ─────────────────────────────────────────────────────
  useDragDrop({
    enabled: !!currentPath,
    currentPath,
    rootRef,
    dropTargetRef: scrollContainerRef,
    paneId,
    connectionType: remote.remote.type,
    onDrop: () => {
      if (currentPath) {
        setTreeKey(k => k + 1)
        loadDirectory(currentPath, false)
      }
    },
  })

  // ── Custom scrollbar sync ──────────────────────────────────────────────────
  useEffect(() => {
    const container = scrollContainerRef.current
    const thumb = scrollThumbRef.current
    if (!container || !thumb) return

    const updateThumb = () => {
      const { scrollHeight, clientHeight, scrollTop } = container
      if (scrollHeight <= clientHeight) {
        thumb.style.opacity = '0'
        return
      }
      const ratio = clientHeight / scrollHeight
      const thumbHeight = Math.max(20, ratio * clientHeight)
      const maxTop = clientHeight - thumbHeight
      const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop
      thumb.style.height = `${thumbHeight}px`
      thumb.style.top = `${top}px`
      thumb.style.opacity = '1'
    }

    const showThumb = () => { thumb.style.opacity = '1' }
    const hideThumb = () => { thumb.style.opacity = '0' }

    container.addEventListener('scroll', updateThumb, { passive: true })
    container.addEventListener('mouseenter', showThumb)
    container.addEventListener('mouseleave', hideThumb)
    updateThumb()

    return () => {
      container.removeEventListener('scroll', updateThumb)
      container.removeEventListener('mouseenter', showThumb)
      container.removeEventListener('mouseleave', hideThumb)
    }
  }, [entries])

  // ── Navigation ─────────────────────────────────────────────────────────────
  const loadDirectory = useCallback(async (path: string, addToHistory = true, fallbackPath?: string, connectionState?: import('./hooks/use-remote-connection').RemoteState) => {
    const epoch = connectionEpochRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await remote.listDirectory(path, connectionState)
      if (epoch !== connectionEpochRef.current || intentionallyDisconnectedRef.current) return
      const sorted = sortEntries(result)
      setEntries(sorted)
      setCurrentPath(path)
      setSelectedPath(null)
      const pendingPath = fallbackPath ?? pendingPathRef.current
      pendingPathRef.current = null
      if (pendingPath) {
        const found = sorted.find(e => e.path === pendingPath)
        if (found) {
          setSelectedPath(found.path)
        } else if (sorted.length) {
          const first = showHidden ? sorted[0] : (sorted.find(e => !e.name.startsWith(".")) ?? sorted[0])
          setSelectedPath(first.path)
        }
      } else if (sorted.length && restoreSelRef.current === undefined) {
        const first = showHidden ? sorted[0] : (sorted.find(e => !e.name.startsWith(".")) ?? sorted[0])
        setSelectedPath(first.path)
      }

      if (addToHistory) {
        const newHistory = history.slice(0, historyIndex + 1)
        if (newHistory[newHistory.length - 1] !== path) {
          newHistory.push(path)
        }
        setHistory(newHistory)
        setHistoryIndex(newHistory.length - 1)
      }
    } catch (e) {
      if (epoch === connectionEpochRef.current && !intentionallyDisconnectedRef.current) {
        setError(String(e))
      }
    } finally {
      if (epoch === connectionEpochRef.current) setLoading(false)
    }
  }, [showHidden, history, historyIndex, setSelectedPath, remote])

  loadDirectoryRef.current = loadDirectory

  const goUp = useCallback(() => {
    if (!currentPath) return
    const parts = currentPath.split('/')
    if (parts.length <= 1) return
    parts.pop()
    const newPath = parts.join('/') || '/'
    pendingPathRef.current = currentPath
    loadDirectory(newPath)
  }, [currentPath, loadDirectory])

  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      pendingPathRef.current = currentPath
      loadDirectory(history[newIndex], false)
    }
  }, [historyIndex, history, currentPath, loadDirectory])

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      loadDirectory(history[newIndex], false)
    }
  }, [historyIndex, loadDirectory])

  const goHome = useCallback(() => {
    if (remote.remote.type !== 'local') {
      loadDirectory(remote.remote.rootPath)
    } else {
      fetchHomeDir().then((home) => loadDirectory(home))
    }
  }, [loadDirectory, remote.remote])

  const refresh = useCallback(() => {
    if (currentPath) loadDirectory(currentPath, false)
  }, [currentPath, loadDirectory])

  const handleNavigate = useCallback((path: string) => {
    loadDirectory(path, true)
  }, [loadDirectory])

  const handleOpenFile = useCallback(async (path: string, entry: FileEntry) => {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    const imageExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
    const audioExt = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm'])
    const kind = imageExt.has(ext) ? 'image' : audioExt.has(ext) ? 'audio' : 'code'
    try {
      const file = kind === 'image' || kind === 'audio'
        ? await remote.readFileBytes(path)
        : await remote.readFile(path)
      const raw: Record<string, unknown> = {
        kind,
        data: file.data,
        encoding: file.encoding,
        filename: entry.name,
        title: entry.name,
        source: path,
        editable: true,
        path: entry.path,
      }
      const normalized = normalizeViewerPayload(raw)
      if (!normalized) return
      setPreviewPayload(normalized)
      setPreviewContent(file.data)
      setNotif(`Opened ${entry.name}`)
    } catch (cause) {
      setError(String(cause))
    }
  }, [remote])

  const handleOpenFileRef = useRef(handleOpenFile)
  handleOpenFileRef.current = handleOpenFile

  // Auto-open a file on mount when launched with a file path ("Open in new pane").
  useEffect(() => {
    if (!entries || !pendingOpenFileRef.current) return
    const filePath = pendingOpenFileRef.current
    pendingOpenFileRef.current = null
    const entry = entries.find(e => e.path === filePath)
    if (entry) handleOpenFileRef.current(entry.path, entry)
  }, [entries])

  const handleSelect = useCallback((path: string, _isDir: boolean) => {
    setSelectedPath(path)
    setSelectedPaths(new Set())
  }, [setSelectedPath])

  const displayEntries = entries ? entries.filter(e => showHidden || !e.name.startsWith('.')) : []

  // ── Connection handling ────────────────────────────────────────────────────
  const lastSavedRef = useRef('')
  // Keep state writes ordered so an older remote save cannot finish after the
  // disconnect snapshot and restore the connection on the next mount.
  const persistenceQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const queuePersistState = useCallback((state: Record<string, unknown>) => {
    const write = () => addonMutation('save_state', {
      pane_id: paneId,
      state,
    }, paneId)
    const queued = persistenceQueueRef.current.catch(() => {}).then(write)
    persistenceQueueRef.current = queued
    return queued
  }, [paneId])
  // `initialPath` lets a restore jump straight to the last visited folder
  // instead of landing on the connection root.
  const handleConnect = useCallback((config: RemoteConnectionConfig, rootPath: string, initialPath?: string) => {
    intentionallyDisconnectedRef.current = false
    restoreAttemptRef.current += 1
    connectionEpochRef.current += 1
    const connectionState = remote.connect(config, rootPath)
    const path = initialPath || rootPath || ''
    if (path) {
      setHistory([])
      setHistoryIndex(-1)
      setEntries(null)
      loadDirectory(path, true, undefined, connectionState)
    } else {
      fetchHomeDir().then((home) => {
        setHistory([])
        setHistoryIndex(-1)
        setEntries(null)
        loadDirectory(home)
      })
    }
  }, [remote, loadDirectory])

  const handleDisconnect = useCallback(() => {
    intentionallyDisconnectedRef.current = true
    restoreAttemptRef.current += 1
    connectionEpochRef.current += 1
    remote.disconnect()
    setHistory([])
    setHistoryIndex(-1)
    setEntries(null)
    setLoading(false)
    setCurrentPath(null)
    // Forget the last connection so a page refresh doesn't auto-reconnect.
    lastSavedRef.current = ''
    queuePersistState({ type: 'local', connectionId: null, rootPath: '', path: '' }).catch(() => {})
  }, [remote, paneId, queuePersistState])

  // ── Persist connection + current directory (like the terminal addon) ──────
  // The addon writes the state into the pane's `extra` (returned as `params` on
  // refresh) and into `panes.cwd` for local browsing, so the pane reopens on
  // the same connection and folder after a page refresh.
  const persistState = useCallback(async () => {
    const r = remote.remote
    await queuePersistState({
      type: r.type,
      connectionId: r.connectionId,
      rootPath: r.rootPath,
      path: currentPath ?? '',
    })
  }, [remote.remote, currentPath, queuePersistState])

  useEffect(() => {
    if (entries === null) return
    const r = remote.remote
    const key = `${r.type}|${r.connectionId ?? ''}|${currentPath ?? ''}`
    if (key === lastSavedRef.current) return
    lastSavedRef.current = key
    persistState().catch(() => {})
  }, [currentPath, remote.remote, entries, persistState])

  // A connection label can be edited from another explorer pane's welcome
  // screen while this pane is already open. Re-publish the current connection
  // state so the addon resolves the newly saved label immediately. Do not
  // reload the directory or alter the user's current navigation.
  useEffect(() => {
    const refreshTempName = () => {
      if (entries === null || intentionallyDisconnectedRef.current) return
      persistState().catch(() => {})
    }
    window.addEventListener('explorer-connections-updated', refreshTempName)
    return () => window.removeEventListener('explorer-connections-updated', refreshTempName)
  }, [entries, persistState])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useExplorerKeyboard({
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
  })

  // ── Inline input ───────────────────────────────────────────────────────────
  const inlineInputRef = useRef(inlineInput)
  inlineInputRef.current = inlineInput
  const currentPathRef = useRef(currentPath)
  currentPathRef.current = currentPath
  // Stable refs for the mount-time restore effect (see above).
  const handleConnectRef = useRef(handleConnect)
  handleConnectRef.current = handleConnect
  const paramsRef = useRef(params)
  paramsRef.current = params

  const submitInlineInput = async (value: string) => {
    const input = inlineInputRef.current
    if (!input || !currentPathRef.current) return
    if (input.mode === 'create') {
      const isDir = value.endsWith('/')
      const clean = isDir ? value.slice(0, -1) : value
      if (!clean) { setInlineInput(null); return }
      const full = currentPathRef.current + '/' + clean
      try { await remote.createEntry(full, isDir) }
      catch (e) { console.error('Create failed:', e) }
      setTreeKey(k => k + 1)
      setRestoreSel(full)
      loadDirectoryRef.current(currentPathRef.current, false)
    } else {
      const parent = input.path.substring(0, input.path.lastIndexOf('/'))
      const newPath = parent + '/' + value
      try { await remote.renameEntry(input.path, newPath) }
      catch (e) { console.error('Rename failed:', e) }
      setTreeKey(k => k + 1)
      setRestoreSel(newPath)
      loadDirectoryRef.current(currentPathRef.current, false)
    }
    setInlineInput(null)
  }

  const cancelInlineInput = () => setInlineInput(null)

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (currentPath) loadDirectory(currentPath, false)
  }, [showHidden])

  // ── Auto-connect to local home (triggered by Cmd+E shortcut) ──────────────
  useEffect(() => {
    if (entries !== null || intentionallyDisconnectedRef.current) return
    if (pendingAutoConnectLocal > 0) {
      pendingAutoConnectLocal--
      const config: RemoteConnectionConfig = { type: 'local', id: crypto.randomUUID(), label: 'Local', path: '' }
      handleConnect(config, '')
    }
  }, [entries, handleConnect])

  // ── Auto-connect on mount (restore persisted state, then launch presets) ──
  // Runs only while `entries` is still null. The connection callbacks and
  // `params` are read through refs so the effect deps stay stable — the remote
  // hook returns a fresh object every render, which would otherwise re-fire
  // this effect in a loop while the initial load is in flight.
  useEffect(() => {
    if (entries !== null || intentionallyDisconnectedRef.current) return
    const hc = handleConnectRef.current
    const p = paramsRef.current
    const attempt = ++restoreAttemptRef.current

    // 1) Restore the last connection + directory from a previous session. The
    //    saved state arrives in `params` (the pane's `extra`), which the addon
    //    persists on every connect/navigation. Only the connection *id* is
    //    stored — the config is re-fetched so credential edits are honored and
    //    secrets never end up in the pane's `extra`.
    const saved = (p as { explorer?: ExplorerPersistedState } | undefined)?.explorer
    if (saved?.path) {
      if (saved.connectionId) {
        ;(async () => {
          try {
            const res = await addonQuery<{ connections: RemoteConnectionConfig[] }>('get_saved_connections', {})
            const config = (res.connections || []).find(c => c.id === saved.connectionId)
            if (config && attempt === restoreAttemptRef.current && !intentionallyDisconnectedRef.current) {
              const rootPath = saved.rootPath || (config.type === 'local' ? config.path : '/')
              hc(config, rootPath, saved.path)
            }
          } catch {}
        })()
      } else {
        // Plain local browsing — jump straight to the last visited folder.
        loadDirectoryRef.current(saved.path, false)
      }
      return
    }

    // 2) Launch params (pane opened with a saved preset or "Open in new pane").
    const launch = (p as { launch?: { connectionId?: string; rootPath?: string; path?: string } } | undefined)?.launch
    if (!launch?.connectionId) return
    ;(async () => {
      try {
        const res = await addonQuery<{ connections: RemoteConnectionConfig[] }>('get_saved_connections', {})
        const config = (res.connections || []).find(c => c.id === launch.connectionId)
        if (config && attempt === restoreAttemptRef.current && !intentionallyDisconnectedRef.current) {
          const rootPath = launch.rootPath || (config.type === 'local' ? config.path : '/')
          // If a specific file path was requested, navigate to its parent
          // directory and schedule the file to open once entries load.
          if (launch.path) {
            const parent = launch.path.substring(0, launch.path.lastIndexOf('/')) || '/'
            pendingOpenFileRef.current = launch.path
            hc(config, rootPath, parent)
          } else {
            hc(config, rootPath)
          }
        }
      } catch {}
    })()
  }, [entries])

  // ── Selection indicator ────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = indicatorRef.current
    if (!el) return
    if (!selectedPath) { el.style.display = 'none'; return }
    const container = entriesContainerRef.current
    if (!container || !container.isConnected) { el.style.display = 'none'; return }
    const escaped = selectedPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const row = container.querySelector<HTMLElement>(`[data-path="${escaped}"]`)
    if (!row) { el.style.display = 'none'; return }
    el.style.display = 'block'
    el.style.top = `${row.offsetTop}px`
    el.style.height = `${row.offsetHeight}px`
    row.scrollIntoView({ block: 'nearest' })
  }, [selectedPath, selectedPaths, entries])

  // ── Restore selection after reload ─────────────────────────────────────────
  useEffect(() => {
    if (!entries || restoreSel === undefined) return
    const path = restoreSel
    const scrollTop = restoreScrollTopRef.current
    restoreScrollTopRef.current = 0

    if (path && !entries.some(e => e.path === path)) return

    setRestoreSel(undefined)
    if (path) {
      setSelectedPath(path)
      requestAnimationFrame(() => {
        if (!entriesContainerRef.current) return
        const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const row = entriesContainerRef.current.querySelector<HTMLElement>(`[data-path="${escaped}"]`)
        row?.scrollIntoView({ block: 'nearest' })
      })
    }
    if (scrollTop > 0) {
      requestAnimationFrame(() => {
        const el = document.querySelector('.overflow-auto')
        if (el) el.scrollTop = scrollTop
      })
    }
  }, [entries, restoreSel])

  // ── Derived ────────────────────────────────────────────────────────────────
  const fileCount = displayEntries.filter(e => !e.is_dir).length
  const folderCount = displayEntries.filter(e => e.is_dir).length
  const canGoUp = currentPath && currentPath !== "/" && currentPath.split('/').filter(Boolean).length > 0

  // ── Viewer-only mode: clean full-screen preview, no tree/toolbar ─────────
  if (viewerOnly && previewPayload) {
    return (
      <div ref={rootRef} className="w-full h-full flex flex-col text-xs">
        <FilePreview
          payload={previewPayload}
          content={previewContent}
          expanded={true}
          viewerOnly
          onCopy={() => navigator.clipboard.writeText(previewContent).then(() => setNotif('Copied'))}
          onDownload={() => {
            const href = previewPayload.kind === 'code' || previewPayload.kind === 'raw'
              ? `data:${previewPayload.mimeType};charset=utf-8,${encodeURIComponent(previewContent)}`
              : inlineUrl(previewPayload)
            if (!href) return
            const anchor = document.createElement('a')
            anchor.href = href
            anchor.download = previewPayload.filename || 'download'
            anchor.click()
          }}
          onClose={() => {
            setViewerOnly(false)
            setPreviewPayload(null)
            setPreviewContent('')
          }}
          onToggleExpand={() => {}} // no-op in viewerOnly (no tree to return to)
          onBack={isViewerOnlyLaunch ? undefined : () => setViewerOnly(false)}
          onOpenInNotes={previewPayload.filename.endsWith('.md') ? () => {
            const path = previewPayload.path || previewPayload.source
            if (!path) return
            const parentDir = path.substring(0, path.lastIndexOf('/')) || '/'
            const nameWithoutExt = previewPayload.filename.replace(/\.md$/i, '')
            window.dispatchEvent(new CustomEvent('pane:new-tile', {
              detail: {
                kind: 'notes',
                name: nameWithoutExt,
                params: { launch: { storage: 'disk', directory: parentDir, noteId: path, noteName: nameWithoutExt } },
              },
            }))
          } : undefined}
          onOpenInNewPane={() => {
            const r = remote.remote
            window.dispatchEvent(new CustomEvent('pane:new-tile', {
              detail: {
                kind: 'explorer',
                name: previewPayload.filename,
                params: {
                  launch: {
                    viewerOnly: true,
                    connectionId: r.connectionId ?? undefined,
                    rootPath: r.rootPath || undefined,
                    path: previewPayload.path,
                  },
                },
              },
            }))
          }}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="w-full h-full flex flex-col text-xs">
      {entries && (
        <Toolbar
          currentPath={currentPath}
          loading={loading}
          historyIndex={historyIndex}
          historyLength={history.length}
          canGoUp={!!canGoUp}
          remoteType={remote.remote.type}
          remoteLabel={remote.remote.config?.label}
          onBack={goBack}
          onForward={goForward}
          onUp={goUp}
          onHome={goHome}
          onRefresh={refresh}
          onDisconnect={handleDisconnect}
        />
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden">

        {inlineInput && (
          <InlineInputComponent
            input={inlineInput}
            onSubmit={submitInlineInput}
            onCancel={cancelInlineInput}
          />
        )}
        {loading && !entries ? (
          <div className="flex items-center justify-center h-full">
            <Spinner className="w-4 h-4 text-muted-foreground animate-spin" />
            <span className="ml-2 text-muted-foreground">Loading...</span>
          </div>
        ) : !entries ? (
          <WelcomeScreen onConnect={handleConnect} />
        ) : error ? (
          <div className="p-4 text-red-400">{error}</div>
        ) : entries ? (
          <div ref={scrollContainerRef} className="h-full overflow-auto explorer-scroll relative">
            <div
              ref={scrollThumbRef}
              className="custom-scrollbar"
            />
            <div
              ref={entriesContainerRef}
              data-entries-container
              tabIndex={-1}
              className="relative select-none min-w-full py-0.5 outline-none"
            >
              <div
                ref={indicatorRef}
                className="absolute left-0 rounded-r-sm pointer-events-none z-10"
                style={{ display: 'none', backgroundColor: 'var(--primary)', width: 3 }}
              />
              <ColumnHeader colWidths={colWidths} onResize={startResize} />
              {displayEntries.length === 0 ? (
                <div className="p-6 text-muted-foreground text-center space-y-3">
                  <p className="text-sm font-medium">Empty folder</p>
                  <div className="text-[10px] space-y-1 leading-relaxed">
                    <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">n</kbd> New file or folder (trailing <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">/</kbd> for directory)</p>
                    <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">.</kbd> Toggle hidden files</p>
                    <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">h</kbd> Go to parent &nbsp; <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">~</kbd> Go home</p>
                    <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">j</kbd> / <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">k</kbd> Navigate &nbsp; <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">r</kbd> Refresh</p>
                  </div>
                </div>
              ) : (
                displayEntries.map((entry) => (
                  <TreeNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    isSelected={selectedPath === entry.path}
                    isMultiSelected={selectedPaths.has(entry.path)}
                    showHidden={showHidden}
                    treeKey={treeKey}
                    colWidths={colWidths}
                    paneId={paneId}
                    connectionType={remote.remote.type}
                    onSelect={handleSelect}
                    onNavigate={handleNavigate}
                    onOpenFile={handleOpenFile}
                    listDirectory={remote.remote.type !== 'local' ? remote.listDirectory : undefined}
                  />
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* ── File Preview (inline viewer) ───────────────────────────────── */}
      {previewPayload && (
        <FilePreview
          payload={previewPayload}
          content={previewContent}
          expanded={false}
          onCopy={() => {
            navigator.clipboard.writeText(previewContent).then(() => setNotif('Copied'))
          }}
          onDownload={() => {
            const href = previewPayload.kind === 'code' || previewPayload.kind === 'raw'
              ? `data:${previewPayload.mimeType};charset=utf-8,${encodeURIComponent(previewContent)}`
              : inlineUrl(previewPayload)
            if (!href) return
            const anchor = document.createElement('a')
            anchor.href = href
            anchor.download = previewPayload.filename || 'download'
            anchor.click()
          }}
          onClose={() => {
            setPreviewPayload(null)
            setPreviewContent('')
          }}
          onContentChange={(val) => setPreviewContent(val)}
          onSave={() => {}}
          onToggleExpand={() => setViewerOnly(true)}
          onOpenInNotes={previewPayload.filename.endsWith('.md') ? () => {
            const path = previewPayload.path || previewPayload.source
            if (!path) return
            const parentDir = path.substring(0, path.lastIndexOf('/')) || '/'
            const nameWithoutExt = previewPayload.filename.replace(/\.md$/i, '')
            window.dispatchEvent(new CustomEvent('pane:new-tile', {
              detail: {
                kind: 'notes',
                name: nameWithoutExt,
                params: { launch: { storage: 'disk', directory: parentDir, noteId: path, noteName: nameWithoutExt } },
              },
            }))
          } : undefined}
          onOpenInNewPane={() => {
            const r = remote.remote
            window.dispatchEvent(new CustomEvent('pane:new-tile', {
              detail: {
                kind: 'explorer',
                name: previewPayload.filename,
                params: {
                  launch: {
                    viewerOnly: true,
                    connectionId: r.connectionId ?? undefined,
                    rootPath: r.rootPath || undefined,
                    path: previewPayload.path,
                  },
                },
              },
            }))
          }}
        />
      )}

      {entries && (
        <StatusBar
          showHidden={showHidden}
          notif={notif}
          selectedCount={selectedPaths.size}
          fileCount={fileCount}
          folderCount={folderCount}
        />
      )}
    </div>
  )
}

export function register(): void {
  paneRegistry.register({
    kind: 'explorer',
    title: 'Explorer',
    description: 'Browse files and folders with an inline code and image viewer',
    icon: ({ className }: { className?: string }) => (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6a2 2 0 0 1 2-2h1.745a2 2 0 0 1 1.322.5l2.272 2a2 2 0 0 0 1.322.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
    component: ExplorerPane,
    launchSchema: explorerLaunchSchema,
    contextMenuActions: (paneId: number, targetPath?: string) => {
      const hasSelection = targetPath !== undefined && targetPath !== null
      return [
        {
          label: 'Refresh', shortcut: 'r', action: () => {
            window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'refresh' } }))
          }
        },
        ...(hasSelection ? [
          {
            label: 'Copy', shortcut: 'c', action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'copy', path: targetPath } }))
            }
          },
          {
            label: 'Cut', shortcut: 'x', action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'cut', path: targetPath } }))
            }
          },
          {
            label: 'Open in Terminal', shortcut: 't', action: () => {
              const isFile = targetPath.split('/').pop()?.includes('.') ?? false
              const dir = isFile ? targetPath.substring(0, targetPath.lastIndexOf('/')) || '/' : targetPath
              window.dispatchEvent(new CustomEvent('pane:new-tile', {
                detail: {
                  kind: 'terminal',
                  name: dir.split('/').pop() || dir,
                  params: { cwd: dir },
                },
              }))
            }
          },
          ...(targetPath.endsWith('.md') ? [{
            label: 'Open in Notes', shortcut: 'O', action: () => {
              const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/')) || '/'
              const name = targetPath.split('/').pop()?.replace(/\.md$/i, '') || ''
              window.dispatchEvent(new CustomEvent('pane:new-tile', {
                detail: {
                  kind: 'notes',
                  name,
                  params: { launch: { storage: 'disk', directory: parentDir, noteId: targetPath, noteName: name } },
                },
              }))
            }
          }] : []),
        ] : []),
        {
          label: 'Paste', shortcut: 'p', action: () => {
            window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'paste' } }))
          }
        },
        {
          label: 'New File', shortcut: 'n', action: () => {
            window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'new-file' } }))
          }
        },
        ...(hasSelection ? [
          {
            label: 'Rename', shortcut: 'R', action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'rename', path: targetPath } }))
            }
          },
          {
            label: 'Delete', shortcut: 'd', danger: true, action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'delete', path: targetPath } }))
            }
          },
        ] : []),
      ]
    },
    registerBindings() {
      return [
        {
          id: 'new-explorer',
          keys: [{ key: 'e', meta: true, shift: true }],
          description: 'New Explorer pane',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'explorer' } }))
          },
        },
        {
          id: 'open-local-explorer',
          keys: [{ key: 'e', meta: true }],
          description: 'Open local explorer in home directory',
          action: () => {
            pendingAutoConnectLocal++
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'explorer' } }))
          },
        },
      ]
    },
  })
}

export function unregister(): void {
  paneRegistry.unregister('explorer')
}

// Backward compatibility alias
export const registerExplorerPane = register

export { setServerUrl, setUserUuid, setWorkspaceId }
