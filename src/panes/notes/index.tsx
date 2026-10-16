import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePane, type PaneComponentProps, type PaneLaunchSchema } from '@zem-sh/pane'
import { toggleCheckbox, useMarkdownEditor } from './editor'
import { Toolbar } from './components/toolbar'
import { StatusBar } from './components/status-bar'
import { WelcomeScreen, type ComposeOptions } from './components/welcome-screen'
import type { NoteScope, NoteSummary, ScopeFilter, StorageKind } from './types'
import { useNotesKeyboard } from './use-notes-keyboard'
import { NotesSettingsProvider, useNotesSettings, settingsStore } from './settings'
import { notesSettingsSchema } from './settings-schema'
import styles from './styles.css?inline'

if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="markdown-notes"]')) {
  const style = document.createElement('style')
  style.textContent = styles
  style.setAttribute('data-pane-css', 'markdown-notes')
  document.head.appendChild(style)
}

const paneRegistry = (window as any).__zemPaneRegistry

interface NoteDocument { id: string; name: string; content: string; updated_at?: number; path?: string; backlinks?: number; scope?: NoteScope }
interface NotesApi {
  runPaneQuery: (paneKind: string, query: string, params?: string, paneId?: number) => Promise<unknown>
  runPaneMutation: (paneKind: string, mutation: string, params?: string, paneId?: number) => Promise<unknown>
}

let addonApi: NotesApi = { runPaneQuery: async () => null, runPaneMutation: async () => null }
export function setAddonApi(api: NotesApi) { addonApi = api }

interface NotesState { storage: StorageKind; directory: string; noteId: string; noteName: string; scope: NoteScope; scopeFilter: ScopeFilter }

function parseState(params?: Record<string, unknown>): Partial<NotesState> {
  const saved = params?.notes
  const launch = params?.launch
  const merged = {
    ...(launch && typeof launch === 'object' ? launch as Partial<NotesState> : {}),
    ...(saved && typeof saved === 'object' ? saved as Partial<NotesState> : {}),
  }
  return merged
}

function operation<T>(method: 'query' | 'mutation', name: string, payload: Record<string, unknown>, paneId: number) {
  const fn = method === 'query' ? addonApi.runPaneQuery : addonApi.runPaneMutation
  return fn('notes', name, JSON.stringify(payload), paneId) as Promise<T>
}

export function MarkdownNotesPane({ paneId, isFocused, params, theme }: PaneComponentProps) {
  const settings = useNotesSettings()

  // ── Settings persistence ──────────────────────────────────────────────────
  useEffect(() => {
    const paneConfig = (window as any).__zemPaneConfig as
      { savePaneSetting?: (kind: string, key: string, value: unknown) => void; getPaneSettings?: (kind: string) => Record<string, unknown> } | undefined
    // Restore persisted settings on mount.
    const persisted = paneConfig?.getPaneSettings?.('notes') ?? {}
    if (Object.keys(persisted).length > 0) {
      settingsStore.loadPersisted(persisted)
    }
    // Persist every subsequent change.
    const unsub = settingsStore.onChange((key, value) => {
      paneConfig?.savePaneSetting?.('notes', key, value)
    })
    return unsub
  }, [])

  const saved = parseState(params)
  const [storage, setStorage] = useState<StorageKind>(saved.storage === 'disk' ? 'disk' : 'database')
  const [directory, setDirectory] = useState(saved.directory || '')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [noteId, setNoteId] = useState(saved.noteId || '')
  const [noteName, setNoteName] = useState(saved.noteName || 'Untitled')
  const [content, setContent] = useState('')
  const [backlinks, setBacklinks] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('Loading notes…')
  const [error, setError] = useState<string | null>(null)
  const [showDirectory, setShowDirectory] = useState(false)
  const [composing, setComposing] = useState(false)
  const [editingNote, setEditingNote] = useState<NoteSummary | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  // Database notes are scoped to the whole workspace or the current project;
  // the host injects the project id into pane operations so the pane only
  // needs to know whether it sits inside a project (for the compose form).
  const [scope, setScope] = useState<NoteScope>((saved.scope as NoteScope) || 'project')
  const [projectId, setProjectId] = useState(0)
  const [scopeFilter, setScopeFilterState] = useState<ScopeFilter>(
    saved.scopeFilter === 'project' || saved.scopeFilter === 'workspace' ? saved.scopeFilter : 'all',
  )
  const initialRestoreRef = useRef(true)
  const saveGenerationRef = useRef(0)
  const saveRequestedRef = useRef(false)
  const editorHostRef = useRef<HTMLDivElement>(null)
  const welcomeRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef(content)
  const noteIdRef = useRef(noteId)
  const noteNameRef = useRef(noteName)
  const storageRef = useRef(storage)
  const directoryRef = useRef(directory)
  const scopeRef = useRef(scope)
  const scopeFilterRef = useRef(scopeFilter)
  const savingRef = useRef(saving)
  contentRef.current = content
  noteIdRef.current = noteId
  noteNameRef.current = noteName
  storageRef.current = storage
  directoryRef.current = directory
  scopeRef.current = scope
  scopeFilterRef.current = scopeFilter
  savingRef.current = saving

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // The welcome screen also hosts the "New Note" compose form (no editor).
  const showWelcome = composing || (!noteId && !content)
  const showWelcomeRef = useRef(showWelcome)
  showWelcomeRef.current = showWelcome

  const { rootRef } = usePane(paneId, isFocused, () => {
    // Focusing the host div is a no-op (it has no tabindex). Route pane focus
    // into the CodeMirror editor so keybinding-driven pane focus lands in the
    // document, matching the terminal/explorer panes.
    if (showWelcomeRef.current) welcomeRef.current?.focus()
    else editorViewRef.current?.focus()
  }, (action, _path, params) => {
    if (action === 'save') saveRef.current().catch(() => {})
    if (action === 'toggle-checkbox') toggleCheckbox(editorViewRef.current)
    if (action === 'new-note') startCompose()
    // Focused existing pane received launch state (e.g. the command palette
    // picked a saved note from the addon's list action): apply it here so the
    // pane switches to the requested note instead of staying put.
    if (action === 'params' && params?.notes && typeof params.notes === 'object') {
      const noteState = params.notes as { storage?: string; directory?: string; noteId?: string; noteName?: string }
      if (noteState.noteId) {
        const kind = noteState.storage === 'disk' ? 'disk' : 'database'
        if (storageRef.current !== kind) {
          setStorage(kind)
          storageRef.current = kind
        }
        const dir = noteState.directory || directoryRef.current
        setDirectory(dir)
        directoryRef.current = dir
        // Switching an open editor to another note must never lose unsaved
        // edits — flush first, mirroring closeNote/startCompose.
        void (async () => {
          if (settingsRef.current.autoSave && dirty && !savingRef.current && noteNameRef.current.trim()) {
            await saveRef.current().catch(() => {})
          }
          loadNote(noteState.noteId!, noteState.noteName).catch(() => {})
        })()
      }
    }
  })

  const persistState = useCallback(async (next: Partial<NotesState> = {}) => {
    const state = {
      storage: storageRef.current,
      directory: directoryRef.current,
      noteId: noteIdRef.current,
      noteName: noteNameRef.current,
      scope: scopeRef.current,
      scopeFilter: scopeFilterRef.current,
      ...next,
    }
    try {
      await operation('mutation', 'save_state', { state }, paneId)
    } catch {
      // State persistence should not interrupt editing.
    }
  }, [paneId])

  const loadNotes = useCallback(async (kind = storageRef.current, dir = directoryRef.current) => {
    setLoading(true); setError(null)
    try {
      const result = await operation<{ notes: NoteSummary[] }>('query', 'list_notes', { storage: kind, directory: dir }, paneId)
      setNotes(result?.notes ?? [])
      setStatus(`${result?.notes?.length ?? 0} notes`)
    } catch (e) {
      setError(String(e)); setNotes([]); setStatus('Unable to load notes')
    } finally { setLoading(false) }
  }, [paneId])

  // The backend already returns the union of workspace + current-project
  // notes; the scope filter narrows that list client-side. Disk notes carry no
  // scope, so filtering only ever applies to database storage.
  const filteredNotes = useMemo(() => {
    if (scopeFilter === 'all' || storage !== 'database') return notes
    return notes.filter(note => note.scope === scopeFilter)
  }, [notes, scopeFilter, storage])

  // Auto-select the first note when the list loads or filter changes.
  useEffect(() => {
    if (!showWelcome || composing || loading) return
    if (filteredNotes.length === 0) { setSelectedNoteId(null); return }
    const current = filteredNotes.find(n => n.id === selectedNoteId)
    if (!current) setSelectedNoteId(filteredNotes[0].id)
  }, [filteredNotes, showWelcome, composing, loading])

  // Wire vim-like keyboard navigation for the welcome list.
  const { setOnRefresh } = useNotesKeyboard({
    paneId,
    isFocused: isFocused && showWelcome,
    welcomeRef,
    notes: filteredNotes,
    loading,
    composing,
    selectedId: selectedNoteId,
    setSelectedId: setSelectedNoteId,
    onOpen: (id) => selectNote(id),
    onNew: () => { startCompose().catch(() => {}) },
    onEdit: (note) => { startEdit(note).catch(() => {}) },
    onDelete: (note) => { deleteNote(note).catch(() => {}) },
    onCancelCompose: () => { setComposing(false); setEditingNote(null) },
    yankEnabled: settings.yankEnabled,
    showNotif: (msg) => setStatus(msg),
  })

  const setScopeFilter = (filter: ScopeFilter) => {
    setScopeFilterState(filter)
    scopeFilterRef.current = filter
    persistState({ scopeFilter: filter })
  }

  const loadNote = useCallback(async (id: string, name?: string) => {
    if (!id) return
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    saveGenerationRef.current += 1
    setLoading(true); setError(null)
    try {
      const result = await operation<NoteDocument>('query', 'read_note', { storage: storageRef.current, directory: directoryRef.current, id, path: storageRef.current === 'disk' ? id : undefined }, paneId)
      setNoteId(result.id || id)
      setNoteName(result.name || name || 'Untitled')
      if (result.scope) { setScope(result.scope); scopeRef.current = result.scope }
      setContent(result.content || '')
      setBacklinks(result.backlinks ?? 0)
      setDirty(false)
      setStatus('Saved')
      await persistState({ noteId: result.id || id, noteName: result.name || name || 'Untitled' })
    } catch (e) { setError(String(e)); setStatus('Could not open note')
    } finally { setLoading(false) }
  }, [paneId, persistState])

  const save = useCallback(async () => {
    if (saving) { saveRequestedRef.current = true; return }
    if (!noteNameRef.current.trim()) return
    setSaving(true); setError(null); setStatus('Saving…')
    const generation = saveGenerationRef.current
    const snapshot = contentRef.current
    const kind = storageRef.current
    const name = noteNameRef.current.trim()
    // A brand-new note sends no id so the backend assigns a unique one
    // (`untitled`, `untitled-2`, … / `Untitled.md`, `Untitled-2.md`, …)
    // instead of overwriting an existing note that shares the same name.
    const id = noteIdRef.current || ''
    try {
      const result = await operation<NoteDocument>('mutation', 'save_note', {
        storage: kind,
        directory: directoryRef.current,
        id,
        path: kind === 'disk' ? id : undefined,
        name,
        content: snapshot,
        scope: scopeRef.current,
      }, paneId)
      const stillCurrent = generation === saveGenerationRef.current
      if (stillCurrent) {
        setNoteId(result.id || id)
        setNoteName(result.name || name)
        if (result.scope) { setScope(result.scope); scopeRef.current = result.scope }
        setBacklinks(result.backlinks ?? 0)
        if (snapshot === contentRef.current) setDirty(false)
        setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
        await loadNotes(kind, directoryRef.current)
        await persistState({ noteId: result.id || id, noteName: result.name || name })
      }
    } catch (e) { setError(String(e)); setStatus('Save failed')
    } finally {
      setSaving(false)
      if (saveRequestedRef.current) {
        saveRequestedRef.current = false
        queueMicrotask(() => saveRef.current().catch(() => {}))
      }
    }
  }, [loadNotes, paneId, persistState, saving])

  const saveRef = useRef(save)
  saveRef.current = save
  const editorViewRef = useMarkdownEditor(editorHostRef, content, (value) => {
    saveGenerationRef.current += 1
    setContent(value); setDirty(true); setStatus('Unsaved changes')
  }, () => saveRef.current(), !showWelcome)

  useEffect(() => {
    loadNotes().then(() => {
      const restoreId = saved.noteId
      if (initialRestoreRef.current && restoreId) {
        initialRestoreRef.current = false
        loadNote(restoreId, saved.noteName).catch(() => {})
      } else {
        initialRestoreRef.current = false
      }
    }).catch(() => {})
  }, [loadNotes, loadNote, saved.noteId, saved.noteName])

  // Learn the pane's project context (injected by the host) so the compose
  // form can offer project scope and the selector can be scoped correctly.
  useEffect(() => {
    operation<{ project_id?: number }>('query', 'context', {}, paneId)
      .then(result => setProjectId(Number(result?.project_id) || 0))
      .catch(() => {})
  }, [paneId])

  useEffect(() => {
    // Read directly from the store singleton — never stale.
    if (!dirty || !settingsStore.get().autoSave) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (!settingsStore.get().autoSave) return
      saveRef.current().catch(() => {})
    }, 900)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [content, dirty])

  // Open the compose form. Flushes the current note first so its unsaved
  // changes are never lost; the previous note stays open underneath, so
  // cancelling the form returns to it (or to the list if none was open).
  const startCompose = async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    saveGenerationRef.current += 1
    if (settingsRef.current.autoSave && dirty && !savingRef.current && noteNameRef.current.trim()) {
      await saveRef.current().catch(() => {})
    }
    setEditingNote(null)
    setComposing(true)
    setError(null)
  }

  // Create the note from the compose form: apply the chosen name, storage,
  // scope and (for disk) directory, then open the editor with a fresh note.
  const createNote = async ({ name, storage: kind, directory: dir, scope: noteScope }: ComposeOptions) => {
    saveGenerationRef.current += 1
    const trimmedName = name.trim() || 'Untitled'
    setStorage(kind); storageRef.current = kind
    setScope(noteScope); scopeRef.current = noteScope
    // Never let the new note vanish from a filtered view: snap the filter to
    // the note's scope when the active filter would hide it.
    if (scopeFilterRef.current !== 'all' && scopeFilterRef.current !== noteScope) {
      setScopeFilter(noteScope)
    }
    if (kind === 'disk') {
      setDirectory(dir); directoryRef.current = dir
    }
    setNoteId(''); setNoteName(trimmedName); setContent(`# ${trimmedName}\n\n`); setBacklinks(0); setDirty(true); setStatus('New note'); setError(null)
    setComposing(false)
    await persistState({ storage: kind, directory: kind === 'disk' ? dir : directoryRef.current, noteId: '', noteName: trimmedName, scope: noteScope })
    await loadNotes(kind, kind === 'disk' ? dir : directoryRef.current).catch(() => {})
  }

  // Rename an existing note. Renaming is name-only: the note keeps its
  // storage and its directory (for disk, the directory is the parent of the
  // note's own path, not the pane state). Used by both the welcome screen's
  // edit form and the toolbar's edit popover.
  const renameNote = async (note: NoteSummary, { name, scope: nextScope }: ComposeOptions) => {
    if (!note) return
    saveGenerationRef.current += 1
    const trimmedName = name.trim() || note.name
    try {
      const result = await operation<NoteDocument>('mutation', 'rename_note', {
        storage: storageRef.current,
        directory: note.id.includes('/') ? note.id.slice(0, note.id.lastIndexOf('/')) : directoryRef.current,
        id: note.id,
        name: trimmedName,
        scope: nextScope,
      }, paneId)
      setEditingNote(null)
      setComposing(false)
      setStatus('Renamed')
      // A scope change must never hide the note from the active view: snap the
      // filter to the new scope when it wouldn't otherwise show the note.
      const newScope = result.scope ?? nextScope
      if (storageRef.current === 'database' && scopeFilterRef.current !== 'all' && scopeFilterRef.current !== newScope) {
        setScopeFilter(newScope)
      }
      // If the renamed note is the one currently open (toolbar popover), keep
      // the editor in sync: the new id/name must be used by the next save,
      // otherwise disk saves would write to the old path and DB saves would
      // send the stale name back, clobbering the rename.
      if (note.id === noteIdRef.current) {
        setNoteId(result.id || note.id)
        setNoteName(result.name || trimmedName)
        setBacklinks(result.backlinks ?? backlinks)
        if (result.scope) { setScope(result.scope); scopeRef.current = result.scope }
        await persistState({ noteId: result.id || note.id, noteName: result.name || trimmedName, scope: result.scope ?? nextScope })
      }
      await loadNotes().catch(() => {})
    } catch (e) {
      setError(String(e)); setStatus('Rename failed')
    }
  }

  // Delete a note from the welcome list. The list only renders when no note
  // is open, so there is nothing to reset after deletion.
  const deleteNote = async (note: NoteSummary) => {
    saveGenerationRef.current += 1
    try {
      await operation('mutation', 'delete_note', {
        storage: storageRef.current,
        directory: directoryRef.current,
        id: note.id,
        path: storageRef.current === 'disk' ? note.id : undefined,
      }, paneId)
      setStatus('Deleted')
      await loadNotes().catch(() => {})
    } catch (e) {
      setError(String(e)); setStatus('Delete failed')
    }
  }

  // Open the compose form in edit mode for an existing note.
  const startEdit = async (note: NoteSummary) => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    saveGenerationRef.current += 1
    if (settingsRef.current.autoSave && dirty && !savingRef.current && noteNameRef.current.trim()) {
      await saveRef.current().catch(() => {})
    }
    setEditingNote(note)
    setComposing(true)
    setError(null)
  }

  const switchStorage = async (kind: StorageKind) => {
    // Flush the current note before switching storage so changes aren't lost.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    saveGenerationRef.current += 1
    if (settingsRef.current.autoSave && dirty && !savingRef.current && noteNameRef.current.trim()) {
      await saveRef.current().catch(() => {})
    }
    setStorage(kind); storageRef.current = kind; setNoteId(''); setNoteName('Untitled'); setContent(''); setBacklinks(0); setDirty(false)
    await persistState({ storage: kind, noteId: '', noteName: 'Untitled' })
    await loadNotes(kind, directoryRef.current)
  }

  const selectNote = (id: string) => {
    const note = notes.find(item => item.id === id)
    loadNote(id, note?.name).catch(() => {})
  }

  const closeNote = useCallback(async () => {
    // Flush any unsaved changes, then reset to the welcome screen.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    // Invalidate any in-flight save so it cannot clobber the reset state.
    saveGenerationRef.current += 1
    // Only flush when nothing is mid-save: a save already in flight has the
    // latest snapshot queued, and calling save() again while saving would set
    // saveRequestedRef and trigger a spurious re-save after we've reset.
    if (settingsRef.current.autoSave && dirty && !savingRef.current && noteNameRef.current.trim()) {
      await saveRef.current().catch(() => {})
    }
    setNoteId(''); setNoteName('Untitled'); setContent(''); setBacklinks(0); setDirty(false); setError(null); setStatus('Closed')
    await persistState({ noteId: '', noteName: 'Untitled' })
    await loadNotes(storageRef.current, directoryRef.current).catch(() => {})
    requestAnimationFrame(() => welcomeRef.current?.focus())
  }, [dirty, persistState, loadNotes])

  // Wire the refresh callback for the keyboard hook.
  useEffect(() => {
    setOnRefresh(() => { loadNotes().catch(() => {}) })
  }, [setOnRefresh, loadNotes])

  return (
    <NotesSettingsProvider>
    <div
      ref={rootRef}
      data-theme={theme?.mode ?? 'dark'}
      data-theme-variant={theme?.variant ?? 'default'}
      className="notes-pane-root w-full h-full min-h-0 flex flex-col text-xs text-foreground"
    >
      {showWelcome ? (
        // The welcome screen is its own page: no toolbar, status bar or editor.
        <WelcomeScreen
          ref={welcomeRef}
          className="flex-1 min-h-0"
          notes={filteredNotes}
          loading={loading}
          composing={composing}
          editing={editingNote}
          storage={storage}
          directory={directory}
          inProject={projectId > 0}
          scopeFilter={scopeFilter}
          selectedId={selectedNoteId}
          onScopeFilterChange={setScopeFilter}
          onStartCompose={() => { setEditingNote(null); startCompose().catch(() => {}) }}
          onCancelCompose={() => { setComposing(false); setEditingNote(null) }}
          onCreate={(options) => {
            if (editingNote) renameNote(editingNote, options).catch(() => {})
            else createNote(options).catch(() => {})
          }}
          onEdit={(note) => { startEdit(note).catch(() => {}) }}
          onDelete={(note) => { deleteNote(note).catch(() => {}) }}
          onSelect={selectNote}
        />
      ) : (
        <>
          <Toolbar
            noteId={noteId}
            noteName={noteName}
            storage={storage}
            notes={filteredNotes}
            loading={loading}
            saving={saving}
            dirty={dirty}
            showDirectory={showDirectory}
            directory={directory}
            scope={scope}
            inProject={projectId > 0}
            scopeFilter={scopeFilter}
            onScopeFilterChange={setScopeFilter}
            onNew={() => { startCompose().catch(() => {}) }}
            onSelectNote={selectNote}
            onNameChange={(value) => { saveGenerationRef.current += 1; setNoteName(value); setDirty(true) }}
            onNameBlur={() => persistState({ noteName })}
            onStorageChange={(kind) => { switchStorage(kind).catch(() => {}) }}
            onSave={() => save().catch(() => {})}
            onClose={() => closeNote().catch(() => {})}
            onRefresh={() => loadNotes().catch(() => {})}
            onToggleDirectory={() => setShowDirectory(value => !value)}
            onDirectoryChange={setDirectory}
            onDirectoryBlur={() => { directoryRef.current = directory; persistState({ directory }); loadNotes('disk', directory).catch(() => {}) }}
            onEditNote={(options) => {
              if (!noteId) return
              renameNote({ id: noteId, name: noteName, scope }, options).catch(() => {})
            }}
          />
          <div className="flex-1 min-h-0 relative">
            <div className="absolute inset-0 notes-editor" ref={editorHostRef} />
          </div>
          <StatusBar
            storage={storage}
            status={status}
            error={error}
            dirty={dirty}
            saving={saving}
            noteCount={filteredNotes.length}
            content={content}
            backlinks={backlinks}
          />
        </>
      )}
    </div>
    </NotesSettingsProvider>
  )
}

export const markdownNotesLaunchSchema: PaneLaunchSchema = {
  fields: [{ type: 'select', key: 'storage', label: 'Storage', description: 'Where new notes are saved', value: 'database', options: [{ value: 'database', label: 'Database' }, { value: 'disk', label: 'Disk' }], onChange: () => {} }, { type: 'text', key: 'directory', label: 'Disk directory', description: 'Defaults to the project directory', value: '', placeholder: '/path/to/notes', onChange: () => {} }],
}

export function register(): void {
  paneRegistry.register({
    kind: 'notes',
    title: 'Markdown Notes',
    description: 'Write and organize Markdown notes with vim-style navigation',
    icon: ({ className }: { className?: string }) => <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h6"/></svg>,
    component: MarkdownNotesPane,
    launchSchema: markdownNotesLaunchSchema,
    settingsSchema: notesSettingsSchema,

    contextMenuActions: (paneId: number) => [{ label: 'Save note', shortcut: '⌘S', action: () => window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'save' } })) }, { label: 'Toggle checkbox', shortcut: '⌘L', action: () => window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'toggle-checkbox' } })) }, { label: 'New note', shortcut: 'n', action: () => window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'new-note' } })) }],
    registerBindings() { return [{ id: 'new-notes', keys: [{ key: 'n', meta: true, shift: true }], description: 'New Markdown Notes pane', action: () => window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'notes' } })) }] },
  })
}

export function unregister(): void { paneRegistry.unregister('notes') }
export const registerMarkdownNotesPane = register
