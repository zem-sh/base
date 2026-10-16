import { useState, useCallback } from 'react'
import type {
  RemoteConnectionType,
  RemoteConnectionConfig,
  RemoteFileEntry,
} from '../types'

let _serverUrl = ''
let _userUuid = ''
let _workspaceId: number | null = null

export function setServerUrl(url: string) {
  _serverUrl = url
}

export function setUserUuid(uuid: string) {
  _userUuid = uuid
}

export function setWorkspaceId(workspaceId: number | null) {
  _workspaceId = workspaceId
}

function getCurrentUserUuid(): string {
  return _userUuid
}

async function addonOperation<T>(
  kind: 'queries' | 'mutations',
  name: string,
  params: Record<string, unknown>,
  paneId?: number,
): Promise<T> {
  const res = await fetch(`${_serverUrl}/api/addon/com.zem.core/${kind}/${name}`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      params: JSON.stringify({ ...params, user_uuid: getCurrentUserUuid() }),
      pane: 'explorer',
      pane_id: paneId,
      workspace_id: _workspaceId,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`addon error ${res.status}: ${text}`)
  }
  const body = await res.json()
  const data = body.data || body
  if (data.error) {
    throw new Error(data.error)
  }
  const raw = data.result || '{}'
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`failed to parse addon response: raw="${raw}" body=${JSON.stringify(body)}`)
  }
}

export async function addonQuery<T>(
  query: string,
  params: Record<string, unknown>,
  paneId?: number,
): Promise<T> {
  return addonOperation<T>('queries', query, params, paneId)
}

export async function addonMutation<T>(
  mutation: string,
  params: Record<string, unknown>,
  paneId?: number,
): Promise<T> {
  return addonOperation<T>('mutations', mutation, params, paneId)
}

export async function fetchHomeDir(): Promise<string> {
  const res = await addonQuery<{ path: string }>('get_home_dir', {})
  return res.path
}

export interface RemoteState {
  type: RemoteConnectionType
  connectionId: string | null
  config: RemoteConnectionConfig | null
  rootPath: string
}

const EMPTY_REMOTE: RemoteState = {
  type: 'local',
  connectionId: null,
  config: null,
  rootPath: '',
}

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(_userUuid ? { 'X-User-UUID': _userUuid } : {}),
  }
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${_serverUrl}${path}`, {
    headers: { ...apiHeaders(), ...opts?.headers as Record<string, string> },
    ...opts,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error ${res.status}: ${text}`)
  }
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text)
}

export function useRemoteConnection() {
  const [remote, setRemote] = useState<RemoteState>(EMPTY_REMOTE)

  const connect = useCallback((config: RemoteConnectionConfig, rootPath: string): RemoteState => {
    const next: RemoteState = {
      type: config.type,
      connectionId: config.id,
      config,
      rootPath,
    }
    setRemote(next)
    return next
  }, [])

  const disconnect = useCallback(async () => {
    setRemote(EMPTY_REMOTE)
  }, [])

  const withConnection = useCallback(
    (params: Record<string, unknown>, state: RemoteState = remote): Record<string, unknown> => {
      if (state.type === 'local' || !state.config) return params
      return { ...params, connection: state.config }
    },
    [remote],
  )

  const listDirectory = useCallback(
    async (path: string, state?: RemoteState) => {
      const res = await addonQuery<{ items: import('../types').FileEntry[] }>(
        'list_directory',
        withConnection({ path, show_hidden: true }, state),
      )
      return res.items
    },
    [remote, withConnection],
  )

  const readFile = useCallback(
    async (path: string) => {
      const res = await addonQuery<{ content: string; size: number }>(
        'read_file',
        withConnection({ path }),
      )
      return { data: res.content, encoding: 'utf8' as const }
    },
    [remote, withConnection],
  )

  const readFileBytes = useCallback(
    async (path: string) => {
      return addonQuery<{ data: string; encoding: 'base64' }>(
        'read_file_bytes',
        withConnection({ path }),
      )
    },
    [remote, withConnection],
  )

  const writeFile = useCallback(
    async (path: string, data: string) => {
      await addonMutation('write_file', withConnection({ path, content: data }))
    },
    [remote, withConnection],
  )

  const deleteEntry = useCallback(
    async (path: string) => {
      await addonMutation('delete_entry', withConnection({ path }))
    },
    [remote, withConnection],
  )

  const renameEntry = useCallback(
    async (oldPath: string, newPath: string) => {
      await addonMutation('rename_entry', withConnection({ from: oldPath, to: newPath }))
    },
    [remote, withConnection],
  )

  const createEntry = useCallback(
    async (path: string, isDir: boolean) => {
      if (isDir) {
        await addonMutation('create_directory', withConnection({ path }))
      } else {
        await addonMutation('write_file', withConnection({ path, content: '' }))
      }
    },
    [remote, withConnection],
  )

  return {
    remote,
    connect,
    disconnect,
    listDirectory,
    readFile,
    readFileBytes,
    writeFile,
    deleteEntry,
    renameEntry,
    createEntry,
  }
}
