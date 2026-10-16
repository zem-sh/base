import { useState, type Ref } from 'react'
import { Check, ChevronDown, ChevronLeft, Database, FilePlus, FileText, Folder, FolderKanban, Globe, HardDrive, Trash } from 'lucide-react'
import type { NoteScope, NoteSummary, ScopeFilter, StorageKind } from '../types'
import { cn, formatRelativeTime } from '../utils'
import { Button, buttonVariants } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './ui/dropdown-menu'

export interface ComposeOptions {
  name: string
  storage: StorageKind
  directory: string
  /** Database notes only — disk notes are files in a directory. */
  scope: NoteScope
}

const SCOPE_FILTER_OPTIONS: { value: ScopeFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'All notes' },
  { value: 'project', label: 'Project', title: 'Project notes only' },
  { value: 'workspace', label: 'Workspace', title: 'Workspace notes only' },
]

/** Segmented All / Project / Workspace toggle shared by the toolbar and the
 *  welcome screen. Only meaningful for database storage (disk notes have no
 *  scope). */
export function ScopeFilterControl({
  value,
  onChange,
}: {
  value: ScopeFilter
  onChange: (value: ScopeFilter) => void
}) {
  return (
    <div
      className="flex items-center rounded-md bg-muted/70 p-0.5 shrink-0"
      role="group"
      aria-label="Filter notes by scope"
    >
      {SCOPE_FILTER_OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          title={option.title}
          className={cn(
            'px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded transition-colors',
            value === option.value
              ? 'bg-popover text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface WelcomeScreenProps {
  notes: NoteSummary[]
  loading: boolean
  composing: boolean
  /** When set, the compose form edits this note instead of creating a new one. */
  editing?: NoteSummary | null
  storage: StorageKind
  directory: string
  inProject: boolean
  scopeFilter: ScopeFilter
  /** Currently keyboard-selected note id (cursor position). */
  selectedId: string | null
  onScopeFilterChange: (filter: ScopeFilter) => void
  onStartCompose: () => void
  onCancelCompose: () => void
  onCreate: (options: ComposeOptions) => void
  onEdit: (note: NoteSummary) => void
  onDelete: (note: NoteSummary) => void
  onSelect: (id: string) => void
  className?: string
  ref?: Ref<HTMLDivElement>
}

export function ComposeForm({
  storage,
  directory,
  editing,
  onCreate,
  onCancel,
  compact = false,
  inProject = true,
}: {
  storage: StorageKind
  directory: string
  editing?: NoteSummary | null
  onCreate: (options: ComposeOptions) => void
  onCancel: () => void
  /** Popover variant: no welcome-screen chrome, just the fields + button. */
  compact?: boolean
  /** False when the pane has no project context; "Project" scope is then disabled. */
  inProject?: boolean
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [kind, setKind] = useState<StorageKind>(storage)
  const [dir, setDir] = useState(directory)
  const [scope, setScope] = useState<NoteScope>(editing?.scope ?? (inProject ? 'project' : 'workspace'))

  const submit = () => {
    const trimmedName = name.trim()
    const trimmedDir = kind === 'disk' ? dir.trim() : ''
    if (!trimmedName) return
    // Editing keeps storage and location: rename derives the location from the
    // note's own path, so a stale/empty directory must not block the rename.
    if (!editing && kind === 'disk' && !trimmedDir) return
    onCreate({ name: trimmedName, storage: kind, directory: trimmedDir, scope })
  }

  return (
    <div className={compact ? 'space-y-3' : 'p-4 max-w-lg mx-auto'} style={compact ? undefined : { paddingTop: '3.5rem' }}>
      {!compact && (
        <div className="flex relative justify-between mb-4">
          <Button
            onClick={onCancel}
            variant="outline"
            size="icon-sm"
            className="absolute -top-0.5 -left-9"
            title="Back to notes"
          >
            <ChevronLeft strokeWidth={2.5} />
          </Button>
          <h2 className="text-sm font-semibold">{editing ? 'Edit Note' : 'New Note'}</h2>
          <div className="w-6" />
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
            placeholder="My note"
            autoFocus
            className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div>
          <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Where to save
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full justify-between', editing && 'opacity-60 cursor-not-allowed')}
              title="Storage"
              disabled={!!editing}
            >
              <span className="flex items-center gap-2">
                {kind === 'database' ? (
                  <Database className="size-3.5" />
                ) : (
                  <HardDrive className="size-3.5" />
                )}
                {kind === 'database' ? 'Database' : 'Disk'}
              </span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem
                onClick={() => setKind('database')}
                className="justify-between"
              >
                <span className="flex items-center gap-2">
                  <Database className="size-3.5" />
                  Database
                </span>
                {kind === 'database' && <Check className="flex-shrink-0" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setKind('disk')}
                className="justify-between"
              >
                <span className="flex items-center gap-2">
                  <HardDrive className="size-3.5" />
                  Disk
                </span>
                {kind === 'disk' && <Check className="flex-shrink-0" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {editing && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Storage and location stay the same when editing; only the name and scope change.
            </p>
          )}
        </div>

        {kind === 'database' && (
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Scope
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full justify-between')}
                title="Who can see this note"
              >
                <span className="flex items-center gap-2">
                  {scope === 'workspace' ? (
                    <Globe className="size-3.5" />
                  ) : (
                    <FolderKanban className="size-3.5" />
                  )}
                  {scope === 'workspace' ? 'Workspace' : 'Project'}
                </span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem
                  onClick={() => setScope('workspace')}
                  className="justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Globe className="size-3.5" />
                    Workspace
                  </span>
                  {scope === 'workspace' && <Check className="flex-shrink-0" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setScope('project')}
                  disabled={!inProject}
                  className="justify-between"
                >
                  <span className="flex items-center gap-2">
                    <FolderKanban className="size-3.5" />
                    Project
                  </span>
                  {scope === 'project' && <Check className="flex-shrink-0" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {scope === 'workspace'
                ? 'Visible in every project of this workspace.'
                : 'Visible only in the current project.'}
            </p>
          </div>
        )}

        {kind === 'disk' && (
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Directory
            </label>
            <div className="flex items-center gap-2">
              <Folder className="size-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={dir}
                onChange={event => setDir(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') submit() }}
                placeholder="Project directory"
                aria-label="Disk notes directory"
                disabled={!!editing}
                className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!name.trim() || (!editing && kind === 'disk' && !dir.trim())}
          className="w-full px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {editing ? 'Save Changes' : 'Create Note'}
        </button>
      </div>
    </div>
  )
}

export function WelcomeScreen({
  notes,
  loading,
  composing,
  editing,
  storage,
  directory,
  inProject,
  scopeFilter,
  selectedId,
  onScopeFilterChange,
  onStartCompose,
  onCancelCompose,
  onCreate,
  onEdit,
  onDelete,
  onSelect,
  className,
  ref,
}: WelcomeScreenProps) {
  return (
    <div ref={ref} tabIndex={-1} className={cn('h-full overflow-y-auto outline-none', className)}>
      {composing ? (
        <ComposeForm
          storage={storage}
          directory={directory}
          editing={editing}
          inProject={inProject}
          onCreate={onCreate}
          onCancel={onCancelCompose}
        />
      ) : (
        <div className="p-4 max-w-lg mx-auto" style={{ paddingTop: '3.5rem' }}>
          <div className="flex relative justify-between items-center gap-2 mb-4">
            <h2 className="text-sm font-semibold">Notes</h2>
            <div className="flex items-center gap-2">
              {storage === 'database' && (
                <ScopeFilterControl value={scopeFilter} onChange={onScopeFilterChange} />
              )}
              <Button variant="outline" size="sm" onClick={onStartCompose} title="Create a new note">
                <FilePlus className="size-3.5" />
                New Note
              </Button>
            </div>
          </div>

          <div className="space-y-4 overflow-y-auto overflow-x-hidden">
          {notes.length > 0 ? (
            <div className="-mr-1">
              <div className="space-y-1">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    data-note-id={note.id}
                    className={cn(
                      'flex items-center gap-2 py-2 rounded hover:bg-accent/20 group',
                      selectedId === note.id && 'bg-accent/20',
                    )}
                  >
                    <button
                      onClick={() => onSelect(note.id)}
                      className="flex-1 flex items-center gap-2 text-xs text-left min-w-0"
                    >
                      <FileText size={14} className="shrink-0" />
                      <span className="truncate">{note.name}</span>
                      {note.scope && (
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 px-1 py-0.5 rounded bg-muted/70 shrink-0">
                          {note.scope === 'project' ? 'Project' : 'Workspace'}
                        </span>
                      )}
                      {note.updated_at ? (
                        <span className="text-muted-foreground truncate">
                          {formatRelativeTime(note.updated_at)}
                        </span>
                      ) : null}
                    </button>
                    <button
                      onClick={() => onEdit(note)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                    >
                      edit
                    </button>
                    <Button
                      onClick={() => onDelete(note)}
                      variant="ghost"
                      className="p-1 text-red-400"
                      title="Delete note"
                    >
                      <Trash className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-6 space-y-3">
              <p>{loading ? 'Loading notes…' : 'No notes yet.'}</p>
              <div className="text-[10px] space-y-1 leading-relaxed">
                <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">n</kbd> New note</p>
                <p><kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">j</kbd> / <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">k</kbd> Navigate &nbsp; <kbd className="px-1 py-0.5 rounded bg-muted/70 text-[9px] font-mono">r</kbd> Refresh</p>
              </div>
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  )
}
