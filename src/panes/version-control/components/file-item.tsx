import { useState } from 'react'
import { Plus, Minus, X } from '@mynaui/icons-react'
import { FileIcon } from '@react-symbols/icons/utils'
import type { ChangedFile } from '../types'
import { Button } from './ui/button'

interface FileItemProps {
  file: ChangedFile
  depth: number
  multiSelected: boolean
  onSelect: (path: string) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onShowDiff: (path: string, staged: boolean) => void
}

// Filename colors based on file state
const nameColors: Record<string, string | undefined> = {
  modified: 'hsl(198, 78%, 63%)',
  added: 'hsl(168, 49%, 57%)',
  staged: 'hsl(168, 49%, 57%)',
  untracked: 'hsl(4, 79%, 67%)',
  deleted: 'hsl(4, 79%, 67%)',
  renamed: 'hsl(4, 79%, 67%)',
  conflict: 'hsl(4, 79%, 67%)',
  ignored: undefined, // inherits muted styling
}

// Status indicator: letter + color (displayed on the right side before actions)
const statusIndicators: Record<string, { label: string; color: string }> = {
  modified: { label: 'M', color: 'hsl(198, 78%, 63%)' },
  added: { label: 'A', color: 'hsl(168, 49%, 57%)' },
  staged: { label: 'A', color: 'hsl(168, 49%, 57%)' },
  deleted: { label: 'D', color: 'hsl(4, 79%, 67%)' },
  renamed: { label: 'R', color: 'hsl(4, 79%, 67%)' },
  untracked: { label: 'U', color: 'hsl(4, 79%, 67%)' },
  conflict: { label: 'C', color: 'hsl(4, 79%, 67%)' },
}

export function FileItem({
  file,
  depth,
  multiSelected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onShowDiff,
}: FileItemProps) {
  const [isHovered, setIsHovered] = useState(false)

  const handleClick = () => {
    onSelect(file.path)
    onShowDiff(file.path, file.staged)
  }

  const isStaged = file.staged
  const effectiveStatus = isStaged && file.status === 'modified' ? 'staged' : file.status
  const nameColor = nameColors[effectiveStatus]
  const indicator = statusIndicators[effectiveStatus]
  const fileName = file.path.split('/').pop() || file.path

  return (
    <div
      data-path={file.path}
      style={{ paddingLeft: `${depth * 12 + 14}px` }}
      className={`flex items-center gap-1.5 pr-3 py-1 cursor-pointer transition-colors ${multiSelected ? 'bg-accent/30' : isHovered ? 'bg-accent/30' : ''
        }`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <FileIcon fileName={file.path} width={14} height={14} autoAssign />

      <span
        className="text-xs truncate flex-1"
        title={file.path}
        style={{ color: nameColor }}
      >
        {fileName}
      </span>

      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {file.additions !== undefined && file.additions > 0 && (
            <span className="text-green-500">+{file.additions}</span>
          )}
          {file.deletions !== undefined && file.deletions > 0 && (
            <span className="text-red-500">-{file.deletions}</span>
          )}
        </span>
      )}

      <div className="flex items-center gap-2 shrink-0">
        {/* Action buttons: visible on hover */}
        <span
          className={`inline-flex items-center gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
        >
          {isStaged ? (
            <Button
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path) }}
              variant={"outline"}
              size={"icon-sm"}
              title="Unstage"
            >
              <Minus className="size-3.5" />
            </Button>
          ) : (
            <Button
              onClick={(e) => { e.stopPropagation(); onStage(file.path) }}
              variant={"outline"}
              size={"icon-sm"}
              title="Stage"
            >
              <Plus className="size-3.5" />
            </Button>
          )}
          {file.status !== 'untracked' && (
            <Button
              onClick={(e) => { e.stopPropagation(); onDiscard(file.path) }}
              variant={"outline"}
              size={"icon-sm"}
              title="Discard changes"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </span>
        {/* Status indicator: always visible, last element */}
        <span
          className="font-mono text-[11px] font-semibold w-4 text-center"
          style={{ color: indicator?.color, visibility: indicator ? 'visible' : 'hidden' }}
        >
          {indicator?.label ?? 'M'}
        </span>
      </div>
    </div>
  )
}
