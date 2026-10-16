import { useState, useEffect, useCallback } from 'react'
import { Servers, Cloud, Trash, Plus, Folder, ChevronLeft } from '@mynaui/icons-react'
import type { RemoteConnectionConfig, SftpConnectionConfig, S3ConnectionConfig, LocalConnectionConfig } from '../types'
import { addonQuery, addonMutation } from '../hooks/use-remote-connection'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Button } from './ui/button'

interface WelcomeScreenProps {
  onConnect: (config: RemoteConnectionConfig, rootPath: string) => void
}

export function WelcomeScreen({ onConnect }: WelcomeScreenProps) {
  const [tab, setTab] = useState<'local' | 'sftp' | 's3' | null>(null)
  const [savedConnections, setSavedConnections] = useState<RemoteConnectionConfig[]>([])
  const [editing, setEditing] = useState<RemoteConnectionConfig | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc goes back from the connection form to the connections list.
  useEffect(() => {
    if (!tab) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      setTab(null)
      setEditing(null)
      setError(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tab])
  const [homeDir, setHomeDir] = useState<string>('')
  const [localLabel, setLocalLabel] = useState('')
  const [localPath, setLocalPath] = useState('')

  const [sftpLabel, setSftpLabel] = useState('')
  const [sftpHost, setSftpHost] = useState('')
  const [sftpPort, setSftpPort] = useState('22')
  const [sftpUser, setSftpUser] = useState('')
  const [sftpKeyPath, setSftpKeyPath] = useState('')
  const [sftpPassword, setSftpPassword] = useState('')

  const [s3Label, setS3Label] = useState('')
  const [s3Bucket, setS3Bucket] = useState('')
  const [s3Region, setS3Region] = useState('us-east-1')
  const [s3Endpoint, setS3Endpoint] = useState('')
  const [s3AccessKey, setS3AccessKey] = useState('')
  const [s3SecretKey, setS3SecretKey] = useState('')
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const home = await addonQuery<{ path: string }>('get_home_dir', {})
        const homeDirPath = home.path
        setHomeDir(homeDirPath)
        setLocalPath(homeDirPath)

        const res = await addonQuery<{ connections: RemoteConnectionConfig[] }>('get_saved_connections', {})
        let list = res.connections || []
        if (list.length === 0) {
          const defaultConn: LocalConnectionConfig = {
            type: 'local',
            id: 'default',
            label: 'Local',
            path: homeDirPath,
          }
          list = [defaultConn]
          await addonMutation('save_connections', { connections: list })
        }
        setSavedConnections(list)
      } catch {
        setSavedConnections([])
        setHomeDir('/')
        setLocalPath('/')
      }
    })()
  }, [])



  const resetSftpForm = () => {
    setSftpLabel('')
    setSftpHost('')
    setSftpPort('22')
    setSftpUser('')
    setSftpKeyPath('')
    setSftpPassword('')
    setEditing(null)
  }

  const resetS3Form = () => {
    setS3Label('')
    setS3Bucket('')
    setS3Region('us-east-1')
    setS3Endpoint('')
    setS3AccessKey('')
    setS3SecretKey('')
    setS3ForcePathStyle(false)
    setEditing(null)
  }

  const loadSftpConfig = (config: SftpConnectionConfig) => {
    setSftpLabel(config.label)
    setSftpHost(config.host)
    setSftpPort(String(config.port))
    setSftpUser(config.user)
    setSftpKeyPath(config.key_path || '')
    setSftpPassword(config.password || '')
    setEditing(config)
  }

  const loadS3Config = (config: S3ConnectionConfig) => {
    setS3Label(config.label)
    setS3Bucket(config.bucket)
    setS3Region(config.region)
    setS3Endpoint(config.endpoint || '')
    setS3AccessKey(config.access_key)
    setS3SecretKey(config.secret_key)
    setS3ForcePathStyle(config.force_path_style)
    setEditing(config)
  }

  const generateId = () => crypto.randomUUID()

  const saveConnections = useCallback(async (configs: RemoteConnectionConfig[]) => {
    await addonMutation('save_connections', { connections: configs })
    setSavedConnections(configs)
    // Other explorer panes may already be connected to one of these saved
    // connections. Notify them after the global list is persisted so the addon
    // can resolve the new label on their next save_state call.
    window.dispatchEvent(new CustomEvent('explorer-connections-updated'))
  }, [])

  const handleConnectSftp = async () => {
    setConnecting(true)
    setError(null)
    try {
      const id = editing?.type === 'sftp' ? editing.id : generateId()
      const config: SftpConnectionConfig = {
        type: 'sftp',
        id,
        label: sftpLabel || sftpHost,
        host: sftpHost,
        port: parseInt(sftpPort, 10) || 22,
        user: sftpUser,
        key_path: sftpKeyPath || undefined,
        password: sftpPassword || undefined,
      }

      const exists = savedConnections.findIndex(c => c.type === 'sftp' && c.id === id)
      const updated = [...savedConnections]
      if (exists >= 0) {
        updated[exists] = config
      } else {
        updated.push(config)
      }
      await saveConnections(updated)

      onConnect(config, '/')
    } catch (e) {
      setError(String(e))
    } finally {
      setConnecting(false)
    }
  }

  const handleConnectS3 = async () => {
    setConnecting(true)
    setError(null)
    try {
      const id = editing?.type === 's3' ? editing.id : generateId()
      const config: S3ConnectionConfig = {
        type: 's3',
        id,
        label: s3Label || s3Bucket,
        bucket: s3Bucket,
        region: s3Region,
        endpoint: s3Endpoint || undefined,
        access_key: s3AccessKey,
        secret_key: s3SecretKey,
        force_path_style: s3ForcePathStyle,
      }

      const exists = savedConnections.findIndex(c => c.type === 's3' && c.id === id)
      const updated = [...savedConnections]
      if (exists >= 0) {
        updated[exists] = config
      } else {
        updated.push(config)
      }
      await saveConnections(updated)

      onConnect(config, '/')
    } catch (e) {
      setError(String(e))
    } finally {
      setConnecting(false)
    }
  }

  const handleConnectLocal = async () => {
    setConnecting(true)
    setError(null)
    try {
      const id = editing?.type === 'local' ? editing.id : generateId()
      const config: LocalConnectionConfig = {
        type: 'local',
        id,
        label: localLabel || 'Local',
        path: localPath || homeDir,
      }

      const exists = savedConnections.findIndex(c => c.type === 'local' && c.id === id)
      const updated = [...savedConnections]
      if (exists >= 0) {
        updated[exists] = config
      } else {
        updated.push(config)
      }
      await saveConnections(updated)

      onConnect(config, config.path)
    } catch (e) {
      setError(String(e))
    } finally {
      setConnecting(false)
    }
  }

  const handleDeleteSaved = async (config: RemoteConnectionConfig) => {
    const updated = savedConnections.filter(c => c.id !== config.id)
    try {
      await saveConnections(updated)
    } catch (e) {
      setError(String(e))
      return
    }
    if (editing?.id === config.id) {
      if (config.type === 'sftp') resetSftpForm()
      else if (config.type === 's3') resetS3Form()
      else {
        setLocalLabel('')
        setLocalPath(homeDir)
        setEditing(null)
      }
    }
  }

  const handleConnectSaved = async (config: RemoteConnectionConfig) => {
    const rootPath = config.type === 'local' ? config.path : '/'
    onConnect(config, rootPath)
  }

  return (
    <div className="h-full p-4 max-w-lg mx-auto mt-12">
      <div className='flex relative justify-between mb-4'>
        {tab &&
          <Button
            onClick={() => setTab(null)}
            variant={"outline"}
            className="absolute -top-0.5 -left-9"
            size={"icon-sm"}
          >
            <ChevronLeft strokeWidth={2.5} />
          </Button>
        }
        <h2 className="text-sm font-semibold">Connections</h2>
        <DropdownMenu>
          <DropdownMenuTrigger >
            <Plus className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={"w-40 gap-4"}>
            <DropdownMenuItem className="py-2" onClick={() => { setTab('local'); setError(null); setEditing(null); setLocalLabel(''); setLocalPath(homeDir) }}>
              <Folder className="size-4" />
              Local Explorer
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2" onClick={() => { setTab('sftp'); setError(null); setEditing(null) }}>
              <Servers className="size-4" />
              SFTP Connection
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2" onClick={() => { setTab('s3'); setError(null); setEditing(null) }}>
              <Cloud className="size-4" />
              S3 Connection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <div className="mb-3 p-2 text-xs text-red-400">
          {error}
        </div>
      )}
      {!tab && (
        <div className="space-y-4 overflow-y-auto overflow-x-hidden">
          {savedConnections.length > 0 ? (
            <div className='-mr-1'>
              <div className="space-y-1">
                {savedConnections.map((config) => (
                  <div
                    key={config.id}
                    className="flex items-center gap-2  py-2 rounded hover:bg-accent/20 group"
                  >
                    <button
                      onClick={() => handleConnectSaved(config)}
                      disabled={connecting}
                      className="flex-1 flex items-center gap-2 text-xs text-left min-w-0"
                    >
                      {config.type === 'sftp' ? (
                        <Servers size={14} />
                      ) : config.type === 's3' ? (
                        <Cloud size={14} />
                      ) : (
                        <Folder size={14} />
                      )}
                      <span className="truncate">{config.label}</span>
                      <span className="text-muted-foreground truncate">
                        {config.type === 'sftp'
                          ? `${config.user}@${config.host}:${config.port}`
                          : config.type === 's3'
                            ? `${config.bucket}/${config.region}`
                            : config.path}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        if (config.type === 'sftp') loadSftpConfig(config)
                        else if (config.type === 's3') loadS3Config(config)
                        else {
                          setLocalLabel(config.label)
                          setLocalPath(config.path)
                          setEditing(config)
                        }
                        setTab(config.type)
                      }}
                      className="p-1 text-muted-foreground hover:text-foreground"
                    >
                      edit
                    </button>

                    <Button
                      onClick={() => handleDeleteSaved(config)}
                      variant="ghost"
                      className="p-1 text-red-400"
                    >
                      <Trash className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-8">
              No saved connections. Click the + button to create one.
            </p>
          )}
        </div>
      )}

      {tab === 'local' && (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Label</label>
            <input
              type="text"
              value={localLabel}
              onChange={(e) => setLocalLabel(e.target.value)}
              placeholder="My Projects"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Starting Path</label>
            <input
              type="text"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="/Users/username"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            onClick={() => handleConnectLocal()}
            disabled={connecting}
            className="w-full px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {connecting ? 'Opening...' : 'Open Explorer'}
          </button>
        </div>
      )}

      {tab === 'sftp' && (
        <div className="space-y-3">
          <button
            onClick={() => { setTab(null); setEditing(null) }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back
          </button>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Label</label>
            <input type="text" value={sftpLabel} onChange={(e) => setSftpLabel(e.target.value)} placeholder="My Server"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Host</label>
              <input type="text" value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} placeholder="192.168.1.100"
                className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Port</label>
              <input type="number" value={sftpPort} onChange={(e) => setSftpPort(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">User</label>
            <input type="text" value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} placeholder="root"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Key Path (optional)</label>
            <input type="text" value={sftpKeyPath} onChange={(e) => setSftpKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Password (optional, if no key)</label>
            <input type="password" value={sftpPassword} onChange={(e) => setSftpPassword(e.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <button
            onClick={handleConnectSftp}
            disabled={connecting || !sftpHost || !sftpUser}
            className="w-full px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {connecting ? 'Connecting...' : editing ? 'Update & Connect' : 'Connect'}
          </button>
        </div>
      )}

      {tab === 's3' && (
        <div className="space-y-3">
          <button
            onClick={() => { setTab(null); setEditing(null) }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back
          </button>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Label</label>
            <input type="text" value={s3Label} onChange={(e) => setS3Label(e.target.value)} placeholder="My Bucket"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Bucket Name</label>
            <input type="text" value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} placeholder="my-bucket"
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Region</label>
              <input type="text" value={s3Region} onChange={(e) => setS3Region(e.target.value)} placeholder="us-east-1"
                className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Endpoint (optional)</label>
              <input type="text" value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} placeholder="s3.amazonaws.com"
                className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Access Key</label>
            <input type="text" value={s3AccessKey} onChange={(e) => setS3AccessKey(e.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Secret Key</label>
            <input type="password" value={s3SecretKey} onChange={(e) => setS3SecretKey(e.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-input border border-border rounded outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={s3ForcePathStyle} onChange={(e) => setS3ForcePathStyle(e.target.checked)} className="rounded border-border" />
            Force path style (for MinIO, DigitalOcean Spaces, etc.)
          </label>
          <button
            onClick={handleConnectS3}
            disabled={connecting || !s3Bucket || !s3AccessKey || !s3SecretKey}
            className="w-full px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {connecting ? 'Connecting...' : editing ? 'Update & Connect' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  )
}
