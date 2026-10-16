import { Plus, Trash, X, Spinner } from '@mynaui/icons-react'
import { cn } from '../utils'
import { Button } from './ui/button'

interface StatusBarProps {
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  deletedCount: number
  loading: boolean
  selectedCount: number
  busy: boolean
  onStageSelected: () => void
  onDiscardSelected: () => void
  onClearSelection: () => void
}

export function StatusBar({
  stagedCount,
  unstagedCount,
  untrackedCount,
  deletedCount,
  loading,
  selectedCount,
  busy,
  onStageSelected,
  onDiscardSelected,
  onClearSelection,
}: StatusBarProps) {
  const totalChanges = stagedCount + unstagedCount + untrackedCount + deletedCount

  return (
    <div className="shrink-0 p-2 font-medium text-muted-foreground flex items-center gap-2 border-t border-border">
      <div className="flex items-center gap-2 shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
        {stagedCount > 0 && (
          <span className={cn('shrink-0')}>
            <span className="text-green-400">{stagedCount}</span> staged
          </span>
        )}
        {unstagedCount > 0 && (
          <span className={cn('shrink-0')}>
            <span className="text-yellow-400">{unstagedCount}</span> modified
          </span>
        )}
        {deletedCount > 0 && (
          <span className={cn('shrink-0')}>
            <span className="text-red-400">{deletedCount}</span> deleted
          </span>
        )}
        {untrackedCount > 0 && (
          <span className={cn('shrink-0')}>
            <span className="text-blue-400">{untrackedCount}</span> untracked
          </span>
        )}
      </div>
      {!loading && totalChanges > 0 && (
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          {totalChanges} file{totalChanges !== 1 ? 's' : ''}
        </span>
      )}
      {selectedCount > 0 && (
        <div className="flex items-center gap-1.5 shrink-0 pl-2 pr-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          <span className="whitespace-nowrap">
            <span className="font-semibold text-primary">{selectedCount}</span> selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onStageSelected}
            disabled={busy}
            title="Stage all selected items"
          >
            <Plus className="size-3" /> Stage
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDiscardSelected}
            className="text-destructive"
            disabled={busy}
            title="Discard all selected items"
          >
            <Trash className="size-3" /> Discard
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClearSelection}
            disabled={busy}
            title="Clear selection"
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
      <div className="flex-1" />
      {loading && (
        <Spinner className="shrink-0 w-4 h-4 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}
