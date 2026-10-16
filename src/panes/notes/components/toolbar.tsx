import { useState } from 'react'
import { Check, ChevronDown, Database, FilePlus, FileText, Folder, HardDrive, Pencil, RefreshCw, Save, Settings2, Unlink, X } from 'lucide-react'
import type { NoteScope, NoteSummary, ScopeFilter, StorageKind } from '../types'
import { cn } from '../utils'
import { Button, buttonVariants } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from './ui/dropdown-menu'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { ComposeForm, ScopeFilterControl, type ComposeOptions } from './welcome-screen'

interface ToolbarProps {
  noteId: string
  noteName: string
  storage: StorageKind
  notes: NoteSummary[]
  loading: boolean
  saving: boolean
  dirty: boolean
  showDirectory: boolean
  directory: string
  /** Scope of the currently open note (database storage). */
  scope: NoteScope
  inProject: boolean
  /** Active view filter applied to the `notes` list (database storage only). */
  scopeFilter: ScopeFilter
  onScopeFilterChange: (filter: ScopeFilter) => void
  onNew: () => void
  onSelectNote: (id: string) => void
  onNameChange: (name: string) => void
  onNameBlur: () => void
  onStorageChange: (storage: StorageKind) => void
  onSave: () => void
  onClose: () => void
  onRefresh: () => void
  onToggleDirectory: () => void
  onDirectoryChange: (directory: string) => void
  onDirectoryBlur: () => void
  onEditNote: (options: ComposeOptions) => void
}

export function Toolbar({
  noteId,
  noteName,
  storage,
  notes,
  loading,
  saving,
  dirty,
  showDirectory,
  directory,
  scope,
  inProject,
  scopeFilter,
  onScopeFilterChange,
  onNew,
  onSelectNote,
  onSave,
  onClose,
  onRefresh,
  onToggleDirectory,
  onDirectoryChange,
  onDirectoryBlur,
  onEditNote,
}: ToolbarProps) {
  const [editOpen, setEditOpen] = useState(false)
  const editingNote = noteId ? { id: noteId, name: noteName, scope } : null
  return (
    <>
      <div className="flex items-center gap-1 p-2 shrink-0 min-w-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-w-0 max-w-44 justify-start')}
            disabled={loading || notes.length === 0}
            title="Select note"
          >
            <FileText className="size-3.5 flex-shrink-0" />
            <span className="truncate text-xs">
              {notes.find(n => n.id === noteId)?.name ?? (noteId ? noteName : 'New note')}
            </span>
            <ChevronDown className="size-3 flex-shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Notes</DropdownMenuLabel>
              {notes.length === 0 ? (
                <DropdownMenuItem disabled>No notes yet</DropdownMenuItem>
              ) : (
                notes.map(note => (
                  <DropdownMenuItem
                    key={note.id}
                    onClick={() => onSelectNote(note.id)}
                    className="justify-between"
                  >
                    <span className="min-w-0 truncate">{note.name}</span>
                    {note.scope && (
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 px-1 py-0.5 rounded bg-muted/70 shrink-0">
                        {note.scope === 'project' ? 'Project' : 'Workspace'}
                      </span>
                    )}
                    {note.id === noteId && <Check className="flex-shrink-0" />}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover open={editOpen} onOpenChange={setEditOpen}>
          <PopoverTrigger
            render={<Button variant="outline" size="icon-lg" disabled={!editingNote} title="Edit note" />}
          >
            <Pencil className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3">
            {editingNote && (
              <ComposeForm
                storage={storage}
                directory={directory}
                editing={editingNote}
                inProject={inProject}
                compact
                onCreate={(options) => {
                  setEditOpen(false)
                  onEditNote(options)
                }}
                onCancel={() => setEditOpen(false)}
              />
            )}
          </PopoverContent>
        </Popover>
        <div className="flex-1" />
        <Button variant="outline" size="icon-lg" onClick={onNew} title="New note">
          <FilePlus className="size-4" />
        </Button>

        {storage === 'disk' && (
          <Button
            variant="outline"
            size="icon-lg"
            onClick={onToggleDirectory}
            aria-expanded={showDirectory}
            title="Edit notes directory"
          >
            <Folder className="size-4" />
          </Button>
        )}

        <Button
          onClick={onSave}
          disabled={saving || !dirty}
          title="Save note"
        >
          <Save className="size-4" />
          <span>{saving ? 'Saving…' : 'Save'}</span>
        </Button>

        <Button
          variant="outline"
          size="icon-lg"
          onClick={onClose}
          title="Close note"
        >
          <Unlink strokeWidth={2.5} className="size-3.5" />
        </Button>
      </div>

      {storage === 'disk' && showDirectory && (
        <div className="notes-directory-row">
          <Folder className="size-3.5 shrink-0" />
          <span className="notes-directory-label">Directory</span>
          <input
            value={directory}
            onChange={event => onDirectoryChange(event.target.value)}
            onBlur={onDirectoryBlur}
            placeholder="Project directory"
            aria-label="Disk notes directory"
            className="notes-directory-input"
          />
          <Settings2 className="size-3.5 text-muted-foreground shrink-0" />
        </div>
      )}
    </>
  )
}
