import { ChevronRight, Home, Refresh, ArrowUp, Unlink, Servers, Cloud } from '@mynaui/icons-react'
import { cn } from '../utils'
import type { RemoteConnectionType } from '../types'
import { Button } from './ui/button'

interface ToolbarProps {
  currentPath: string | null
  loading: boolean
  historyIndex: number
  historyLength: number
  canGoUp: boolean
  remoteType?: RemoteConnectionType
  remoteLabel?: string
  onBack: () => void
  onForward: () => void
  onUp: () => void
  onHome: () => void
  onRefresh: () => void
  onDisconnect?: () => void
}

export function Toolbar({
  currentPath,
  loading,
  historyIndex,
  historyLength,
  canGoUp,
  remoteType = 'local',
  remoteLabel,
  onBack,
  onForward,
  onUp,
  onHome,
  onRefresh,
  onDisconnect,
}: ToolbarProps) {
  const isRemote = remoteType !== 'local'

  return (
    <div className="flex items-center gap-1 p-2 shrink-0 min-w-0">
      <Button
        onClick={onBack}
        disabled={historyIndex <= 0}
        variant="outline"
        size="icon-lg"
        title="Back"
      >
        <ChevronRight className="size-4 rotate-180" />
      </Button>
      <Button
        onClick={onForward}
        disabled={historyIndex >= historyLength - 1}
        variant="outline"
        size="icon-lg"
        title="Forward"
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
      <Button
        onClick={onUp}
        disabled={!canGoUp}
        variant="outline"
        size="icon-lg"
        title="Go up"
      >
        <ArrowUp className="w-4 h-4" />
      </Button>
      <Button
        onClick={onHome}
        variant="outline"
        size="icon-lg"
        title="Home"
      >
        <Home className="w-4 h-4" />
      </Button>


      <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs p-2 rounded-lg border border-border hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/20">
        {currentPath || 'Loading...'}
      </div>

      <Button
        onClick={onRefresh}
        variant="outline"
        size="icon-lg"
        title="Refresh"
      >
        <Refresh className={cn("w-4 h-4", loading && "animate-spin")} />
      </Button>

      {onDisconnect && (
        <Button
          onClick={onDisconnect}
          variant="outline"
          size={isRemote ? "lg" : "icon-lg"}
          className={cn(
            isRemote && "text-green-400")}
          title="Disconnect"
        >
          <Unlink className="size-4" strokeWidth={2.5} />
          {isRemote && (
            <span>{remoteLabel || remoteType.toUpperCase()}</span>
          )}
        </Button>
      )}
    </div>
  )
}
