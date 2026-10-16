import { useState, useCallback, useEffect } from 'react'
import { X, Minimize, Copy, Cog, ChevronLeft, Plus } from '@mynaui/icons-react'
import type { DiffInfo, ChangedFile, FileContentsResult } from '../../types'
import { DiffSettings, type DiffSettings as DiffSettingsType } from './diff-settings'
import { CodemirrorDiff } from './codemirror-diff'
import { ConflictResolver } from './conflict-resolver'

interface DiffPageProps {
  diff: DiffInfo | null
  file?: ChangedFile | null
  onClose: () => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  onDiscard?: (path: string) => void
  onBack?: () => void
  getFileContents?: (filePath: string, staged: boolean) => Promise<FileContentsResult>
  onResolveConflict?: (filePath: string, content: string) => void | Promise<void>
}

const DEFAULT_SETTINGS: DiffSettingsType = {
  layout: 'stacked',
  showLineNumbers: true,
  wordWrap: false,
  showBackground: true,
  indicatorStyle: 'bars',
}

/** Confirm via the host app's custom dialog when bridged, else native confirm(). */
async function confirmDialog(opts: { title?: string; message: string }): Promise<boolean> {
  const bridge = (window as any).__zemConfirmDialog as
    | ((opts: { title?: string; message: string }) => Promise<boolean>)
    | undefined
  if (bridge) return bridge(opts)
  return window.confirm(opts.message)
}

export function DiffPage({
  diff,
  file,
  onClose,
  onStage,
  onUnstage,
  onDiscard,
  onBack,
  getFileContents,
  onResolveConflict,
}: DiffPageProps) {
  const [settings, setSettings] = useState<DiffSettingsType>(() => {
    const saved = localStorage.getItem('diff-view-settings')
    if (saved) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
      } catch {
        return DEFAULT_SETTINGS
      }
    }
    return DEFAULT_SETTINGS
  })
  const [showSettings, setShowSettings] = useState(false)
  const [contents, setContents] = useState<FileContentsResult | null>(null)

  // Persist settings
  useEffect(() => {
    localStorage.setItem('diff-view-settings', JSON.stringify(settings))
  }, [settings])

  // Fetch full old/new contents for the CodeMirror diff view.
  useEffect(() => {
    let cancelled = false
    setContents(null)
    if (!diff || diff.isConflict || !getFileContents) return
    getFileContents(diff.filePath, diff.staged ?? false).then((res) => {
      if (!cancelled) setContents(res)
    })
    return () => {
      cancelled = true
    }
  }, [diff, getFileContents])

  const handleCopyDiff = useCallback(async () => {
    if (diff?.rawPatch) {
      await navigator.clipboard.writeText(diff.rawPatch)
    }
  }, [diff?.rawPatch])

  const handleDiscard = useCallback(async () => {
    if (!diff || !onDiscard) return
    const ok = await confirmDialog({
      title: 'Discard changes',
      message: `Discard all changes to ${diff.filePath}?`,
    })
    if (ok) {
      onDiscard(diff.filePath)
    }
  }, [diff, onDiscard])

  if (!diff) return null

  const isStaged = file?.staged ?? false
  const isConflict = diff.isConflict && diff.conflictContent != null

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 rounded hover:bg-accent transition-colors shrink-0"
              title="Back to changes"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <span className="text-xs font-medium truncate">{diff.filePath}</span>
          {isConflict ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 shrink-0">Merge conflict</span>
          ) : (
            <>
              {diff.additions !== undefined && diff.deletions !== undefined && (
                <span className="text-[10px] flex items-center gap-1.5 shrink-0">
                  <span className="text-green-500">+{diff.additions}</span>
                  <span className="text-red-500">-{diff.deletions}</span>
                </span>
              )}
              {diff.isNew && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 shrink-0">New</span>
              )}
              {diff.isDeleted && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 shrink-0">Deleted</span>
              )}
              {diff.isRenamed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 shrink-0">Renamed</span>
              )}
              {file && (
                <span className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${isStaged ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {isStaged ? 'Staged' : 'Unstaged'}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Stage / Unstage / Discard */}
          {!isConflict && onStage && onUnstage && file && (
            <button
              onClick={() => (isStaged ? onUnstage(diff.filePath) : onStage(diff.filePath))}
              className="p-1 rounded hover:bg-accent transition-colors"
              title={isStaged ? 'Unstage' : 'Stage'}
            >
              {isStaged ? <Minimize className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          )}
          {!isConflict && onDiscard && (
            <button
              onClick={handleDiscard}
              className="p-1 rounded hover:bg-accent transition-colors text-red-400 hover:text-red-300"
              title="Discard changes"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={handleCopyDiff}
            className="p-1 rounded hover:bg-accent transition-colors"
            title="Copy diff"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          {!isConflict && (
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`p-1 rounded transition-colors ${showSettings ? 'bg-accent' : 'hover:bg-accent'}`}
              title="Settings"
            >
              <Cog className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent transition-colors"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && !isConflict && (
        <div className="border-b border-border bg-muted/10 px-3 py-2 shrink-0">
          <DiffSettings settings={settings} onChange={setSettings} />
        </div>
      )}

      {/* Diff content — full height */}
      <div className="flex-1 overflow-auto min-h-0">
        {isConflict ? (
          <ConflictResolver
            filePath={diff.filePath}
            content={diff.conflictContent!}
            onResolve={(content) => onResolveConflict?.(diff.filePath, content)}
            onResolved={onClose}
            onClose={onClose}
          />
        ) : contents && (contents.old != null || contents.new != null) ? (
          <CodemirrorDiff
            oldContent={contents.old ?? null}
            newContent={contents.new ?? null}
            filePath={diff.filePath}
            settings={settings}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground font-mono whitespace-pre overflow-x-auto">
            {(diff.lines || [])
              .map((line) => {
                const prefix =
                  line.type === 'added' ? '+' :
                  line.type === 'removed' ? '-' : line.type === 'header' ? '' : ' '
                return `${prefix}${line.content}`
              })
              .join('\n')}
          </div>
        )}
      </div>
    </div>
  )
}
