import { X, Maximize, Minimize, Copy, ChevronRight } from '@mynaui/icons-react'
import { useState, useCallback, useEffect } from 'react'
import type { DiffInfo, ChangedFile, FileContentsResult } from '../types'
import { ConflictResolver } from './diff/conflict-resolver'
import { CodemirrorDiff, type DiffViewSettings } from './diff/codemirror-diff'
import { DiffPage } from './diff/diff-page'

const INLINE_DIFF_SETTINGS: DiffViewSettings = {
  layout: 'stacked',
  showLineNumbers: true,
  wordWrap: false,
  showBackground: true,
  indicatorStyle: 'bars',
}

interface DiffViewProps {
  diff: DiffInfo | null
  file?: ChangedFile | null
  onClose: () => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  onDiscard?: (path: string) => void
  /** Fetches full file contents used to hydrate collapsed unchanged context. */
  getFileContents?: (filePath: string, staged: boolean) => Promise<FileContentsResult>
  /** Persists resolved conflict content back to disk (write + stage). */
  onResolveConflict?: (filePath: string, content: string) => void | Promise<void>
}

export function DiffView({
  diff,
  file,
  onClose,
  onStage,
  onUnstage,
  onDiscard,
  getFileContents,
  onResolveConflict,
}: DiffViewProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [contents, setContents] = useState<FileContentsResult | null>(null)

  const handleCopyDiff = useCallback(async () => {
    if (diff?.rawPatch) {
      await navigator.clipboard.writeText(diff.rawPatch)
    }
  }, [diff?.rawPatch])

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

  if (!diff) return null

  // Full-page immersive view
  if (isExpanded) {
    return (
      <DiffPage
        diff={diff}
        file={file}
        onClose={() => {
          setIsExpanded(false)
          onClose()
        }}
        onBack={() => setIsExpanded(false)}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
        getFileContents={getFileContents}
        onResolveConflict={onResolveConflict}
      />
    )
  }

  const isConflict = diff.isConflict && diff.conflictContent != null

  return (
    <div className="bg-muted/20 border-t border-border">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium truncate">{diff.filePath}</span>
          {isConflict ? (
            <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 shrink-0">
              Merge conflict
            </span>
          ) : (
            <>
              {diff.additions !== undefined && diff.deletions !== undefined && (
                <span className="text-[10px] flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{diff.additions}</span>
                  <span className="text-red-500">-{diff.deletions}</span>
                </span>
              )}
              {file && (
                <span className={`text-[10px] px-1 py-0.5 rounded ${file.staged ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {file.staged ? 'Staged' : 'Unstaged'}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {!isConflict && onStage && onUnstage && onDiscard && file && (
            <>
              {file.staged ? (
                <button
                  onClick={() => onUnstage(file.path)}
                  className="p-0.5 rounded hover:bg-accent transition-colors"
                  title="Unstage"
                >
                  <Minimize className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => onStage(file.path)}
                  className="p-0.5 rounded hover:bg-accent transition-colors"
                  title="Stage"
                >
                  <Maximize className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          )}
          {diff.rawPatch && (
            <button
              onClick={handleCopyDiff}
              className="p-0.5 rounded hover:bg-accent transition-colors"
              title="Copy diff"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          )}
          {!isConflict && (
            <button
              onClick={() => setIsExpanded(true)}
              className="p-0.5 rounded hover:bg-accent transition-colors"
              title="Open full page"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-auto max-h-96">
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
            settings={INLINE_DIFF_SETTINGS}
          />
        ) : (
          <div className="p-3 text-[10px] text-muted-foreground font-mono whitespace-pre overflow-x-auto">
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
