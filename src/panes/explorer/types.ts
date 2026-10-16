export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  size: number
  modified: number
  permissions?: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}

export interface ColWidths {
  name: number
  size: number
  perms: number
  modified: number
}

export type InlineInput = {
  mode: 'create'
} | {
  mode: 'rename'
  path: string
  name: string
}

// ── Remote connection types ──────────────────────────────────────────────────

export type RemoteConnectionType = 'local' | 'sftp' | 's3'

export interface SftpConnectionConfig {
  type: 'sftp'
  id: string
  label: string
  host: string
  port: number
  user: string
  key_path?: string
  password?: string
}

export interface S3ConnectionConfig {
  type: 's3'
  id: string
  label: string
  bucket: string
  region: string
  endpoint?: string
  access_key: string
  secret_key: string
  force_path_style: boolean
}

export interface LocalConnectionConfig {
  type: 'local'
  id: string
  label: string
  path: string
}

export type RemoteConnectionConfig = SftpConnectionConfig | S3ConnectionConfig | LocalConnectionConfig

export interface ActiveRemoteConnection {
  id: string
  type: RemoteConnectionType
  label: string
  rootPath: string
}

// ── Persisted explorer state (survives page refreshes) ─────────────────────
// Stored server-side in the pane's `extra` (returned as `params.explorer` on
// mount) and in `panes.cwd` for local browsing. Only the connection *id* is
// persisted — credentials stay in the saved-connections store, and the config
// is looked up fresh on restore (so edits to a connection are picked up).
// `connectionId` is null when the user was browsing the local filesystem
// without an explicit connection.
export interface ExplorerPersistedState {
  type: RemoteConnectionType
  connectionId: string | null
  rootPath: string
  path: string
}
