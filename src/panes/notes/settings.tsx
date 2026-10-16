import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export interface NotesSettings {
  vimMode: boolean
  autoClose: boolean
  fontSize: number
  fontFamily: string
  autoSave: boolean
  yankEnabled: boolean
}

const defaults: NotesSettings = {
  vimMode: true,
  autoClose: true,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  autoSave: true,
  yankEnabled: true,
}

type Listener = () => void
type ChangeListener = (key: string, value: unknown) => void

class NotesSettingsStore {
  private settings: NotesSettings = { ...defaults }
  private listeners = new Set<Listener>()
  private changeListeners = new Set<ChangeListener>()

  get(): NotesSettings {
    return this.settings
  }

  set(partial: Partial<NotesSettings>): void {
    this.settings = { ...this.settings, ...partial }
    for (const fn of this.listeners) fn()
  }

  /** Called when any setting changes — provides key/value for persistence. */
  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn)
    return () => { this.changeListeners.delete(fn) }
  }

  /** Update a single key and notify both UI + persistence listeners. */
  setKey<K extends keyof NotesSettings>(key: K, value: NotesSettings[K]): void {
    if (this.settings[key] === value) return
    this.settings = { ...this.settings, [key]: value }
    for (const fn of this.listeners) fn()
    for (const fn of this.changeListeners) fn(key as string, value)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Bulk-load settings from persisted config (does NOT trigger change listeners). */
  loadPersisted(data: Record<string, unknown>): void {
    const partial: Partial<NotesSettings> = {}
    for (const key of Object.keys(defaults) as Array<keyof NotesSettings>) {
      if (key in data && typeof data[key] === typeof defaults[key]) {
        (partial as Record<string, unknown>)[key] = data[key]
      }
    }
    this.settings = { ...this.settings, ...partial }
    for (const fn of this.listeners) fn()
  }
}

export const settingsStore = new NotesSettingsStore()

const SettingsContext = createContext<NotesSettings>(defaults)

export function NotesSettingsProvider({ children }: { children: ReactNode }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = settingsStore.subscribe(() => setTick((n) => n + 1))
    return unsub
  }, [])

  return (
    <SettingsContext.Provider value={settingsStore.get()}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useNotesSettings(): NotesSettings {
  return useContext(SettingsContext)
}
