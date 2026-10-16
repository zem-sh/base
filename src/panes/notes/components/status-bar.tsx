import { useMemo } from 'react'
import { AlertCircle, Database, HardDrive, LoaderCircle, PenLine } from 'lucide-react'
import { cn } from '../utils'
import type { StorageKind } from '../types'

interface StatusBarProps {
  storage: StorageKind
  status: string
  error: string | null
  dirty: boolean
  saving: boolean
  noteCount: number
  content: string
  backlinks: number
}

function countWords(content: string): number {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  return body ? body.split(/\s+/).length : 0
}

function documentMetrics(content: string, backlinks: number) {
  const words = countWords(content)
  return {
    words,
    characters: content.length,
    backlinks,
    minutes: Math.max(1, Math.round(words / 200)),
  }
}

const pillClass = 'inline-flex shrink-0 items-center gap-1.5 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20'

export function StatusBar({ storage, status, error, dirty, saving, noteCount, content, backlinks }: StatusBarProps) {
  const metrics = useMemo(() => documentMetrics(content, backlinks), [content, backlinks])

  return (
    <div className="shrink-0 p-2 font-medium text-muted-foreground flex items-center justify-between border-t border-border min-w-0 overflow-x-auto notes-status-bar">
      <div className='flex items-center gap-2'>
        <div className={cn(pillClass, 'gap-2')}>
          <span className="shrink-0" title="Total words">
            <span className="text-yellow-400">{metrics.words}</span> words
          </span>
          <span className="shrink-0" title="Total characters">
            <span className="text-blue-400">{metrics.characters}</span> characters
          </span>
          <span className="shrink-0" title="Estimated reading time">
            <span className="text-red-400">{metrics.minutes}</span> min read
          </span>
        </div>

        <div className={cn(pillClass, 'gap-2')}>
          <span className="shrink-0" title="Incoming backlinks">
            <span className="text-green-400">{metrics.backlinks}</span> backlink{metrics.backlinks === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className='flex items-center gap-2 shrink-0 min-w-0'>
        {error ? (
          <span className="shrink-0 text-red-400 flex items-center gap-1" title={error}>
            <AlertCircle className="size-3.5" />
            <span className="notes-status-message max-w-[12rem]">{error}</span>
          </span>
        ) : saving ? (
          <span className="shrink-0 flex items-center gap-1.5">
            <LoaderCircle className="size-3.5 animate-spin" />
          </span>
        ) : <></>}

        <div className={cn(pillClass, 'gap-2')}>
          {storage === 'database' ? <Database className="size-3.5" /> : <HardDrive className="size-3.5" />}
          <span className="text-foreground/50">·</span>
          <span><span className="text-primary">{noteCount}</span> note{noteCount === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}
