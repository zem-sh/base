export type StorageKind = 'database' | 'disk'

/** Database notes are scoped to the whole workspace or to the project they
 *  were created in. Disk notes are files in a directory and carry no scope. */
export type NoteScope = 'workspace' | 'project'

/** Client-side view filter over scoped database notes. */
export type ScopeFilter = 'all' | NoteScope

export interface NoteSummary {
  id: string
  name: string
  updated_at?: number
  path?: string
  scope?: NoteScope
}
