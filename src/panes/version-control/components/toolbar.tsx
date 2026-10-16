import {
  GitBranch,
  Refresh,
  RefreshAlt,
  Cloud,
  CloudOff,
  Package,
  Dots,
  Check,
  Trash,
  Plus,
  Minus,
} from '@mynaui/icons-react'
import { cn } from '../utils'
import type { BranchInfo, StashInfo } from '../types'
import { Button, buttonVariants } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from './ui/dropdown-menu'

interface ToolbarProps {
  branch: string
  loading: boolean
  ahead?: number
  behind?: number
  branches: BranchInfo[]
  stashes: StashInfo[]
  onRefresh: () => void
  onPush: () => void
  onPull: () => void
  onFetch: () => void
  onStash: () => void
  onCheckoutBranch: (name: string) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onPopStash: (index: number) => void
  onDropStash: (index: number) => void
}

export function Toolbar({
  branch,
  loading,
  ahead,
  behind,
  branches,
  stashes,
  onRefresh,
  onPush,
  onPull,
  onFetch,
  onStash,
  onCheckoutBranch,
  onStageAll,
  onUnstageAll,
  onPopStash,
  onDropStash,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1 p-2 shrink-0 min-w-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-w-0 max-w-48 justify-start')}
          title="Switch branch"
        >
          <GitBranch className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate text-xs">{branch || 'detached'}</span>
          {(ahead !== undefined || behind !== undefined) && (
            <span className="flex-shrink-0 text-[10px]">
              {ahead !== undefined && ahead > 0 && <span className="text-green-500">↑{ahead}</span>}
              {behind !== undefined && behind > 0 && <span className="text-red-500">↓{behind}</span>}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Branches</DropdownMenuLabel>
            {(Array.isArray(branches) ? branches : []).length === 0 ? (
              <DropdownMenuItem disabled>No branches</DropdownMenuItem>
            ) : (
              (Array.isArray(branches) ? branches : []).map((b) => (
                <DropdownMenuItem
                  key={b.name}
                  onClick={() => onCheckoutBranch(b.name)}
                  className="justify-between"
                >
                  <span className="truncate">{b.name}</span>
                  {b.current && <Check className="ml-auto flex-shrink-0" />}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuGroup>
          {stashes.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Stashes</DropdownMenuLabel>
                {stashes.map((s) => (
                  <div key={s.index} className="flex items-center gap-0.5 pr-1">
                    <DropdownMenuItem
                      className="flex-1 min-w-0"
                      onClick={() => onPopStash(s.index)}
                      title={`Pop stash@{${s.index}}`}
                    >
                      <span className="truncate">stash@{s.index}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDropStash(s.index)}
                      title={`Drop stash@{${s.index}}`}
                      className="px-1.5"
                    >
                      <Trash className="w-3 h-3" />
                    </DropdownMenuItem>
                  </div>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <Button
        variant="outline"
        size="icon-lg"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh status"
      >
        <Refresh className={cn('w-4 h-4', loading && 'animate-spin')} />
      </Button>
      <Button variant="outline" size="icon-lg" onClick={onFetch} title="Fetch">
        <RefreshAlt className="w-4 h-4" />
      </Button>
      <Button variant="outline" size="icon-lg" onClick={onPull} title="Pull">
        <Cloud className="w-4 h-4" />
      </Button>
      <Button variant="outline" size="icon-lg" onClick={onPush} title="Push">
        <CloudOff className="w-4 h-4" />
      </Button>
      <Button variant="outline" size="icon-lg" onClick={onStash} title="Stash changes">
        <Package className="w-4 h-4" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(buttonVariants({ variant: 'outline', size: 'icon-lg' }))}
          title="More actions"
        >
          <Dots className="w-4 h-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onStageAll}>
            <Plus className="w-3.5 h-3.5" />
            Stage All Changes
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onUnstageAll}>
            <Minus className="w-3.5 h-3.5" />
            Unstage All
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
