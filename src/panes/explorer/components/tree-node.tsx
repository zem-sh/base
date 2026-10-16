import { useState, useEffect, useRef } from 'react'
import { Spinner, ChevronRight } from '@mynaui/icons-react'
import type { FileEntry, ColWidths } from '../types'
import { cn, formatFileSize, formatRelativeTime, sortEntries } from '../utils'
import { EntryIcon } from './entry-icon'
import { setGlobalDragState } from '../hooks/global-drag-state'
import { addonQuery } from '../hooks/use-remote-connection'

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  isSelected: boolean
  isMultiSelected: boolean
  showHidden: boolean
  treeKey: number
  colWidths: ColWidths
  paneId: number
  connectionType: string
  onSelect: (path: string, isDir: boolean) => void
  onNavigate: (path: string) => void
  onOpenFile?: (path: string, entry: FileEntry) => void
  listDirectory?: (path: string) => Promise<FileEntry[]>
}

export function TreeNode({
  entry,
  depth,
  isSelected,
  isMultiSelected,
  showHidden,
  treeKey,
  colWidths,
  paneId,
  connectionType,
  onSelect,
  onNavigate,
  onOpenFile,
  listDirectory,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const treeKeyRef = useRef(treeKey)

  const loadDir = listDirectory || ((path: string) =>
    addonQuery<{ items: FileEntry[] }>('list_directory', { path, show_hidden: true }).then(r => r.items)
  )

  useEffect(() => {
    if (!expanded) return
    treeKeyRef.current = treeKey
    setChildren(null)
    setLoading(true)
    setError(null)
    loadDir(entry.path)
      .then((result) => setChildren(sortEntries(result)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [treeKey])

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(entry.path, entry.is_dir)
    if (entry.is_dir) {
      onNavigate(entry.path)
    } else if (onOpenFile) {
      onOpenFile(entry.path, entry)
    }
  }

  const handleContextMenu = (_e: React.MouseEvent) => {
    onSelect(entry.path, entry.is_dir)
  }

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!entry.is_dir) return
    onSelect(entry.path, entry.is_dir)
    if (expanded) {
      setExpanded(false)
    } else {
      setExpanded(true)
      if (treeKeyRef.current === treeKey && children !== null) return
      treeKeyRef.current = treeKey
      setLoading(true)
      setError(null)
      loadDir(entry.path)
        .then((result) => setChildren(sortEntries(result)))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false))
    }
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', entry.path)
    setGlobalDragState({
      paths: [entry.path],
      sourcePaneId: paneId,
      sourceConnectionType: connectionType,
    })
  }

  const handleDragEnd = () => {
    setGlobalDragState(null)
  }

  const indent = depth * 16
  const isHidden = entry.name.startsWith('.')

  return (
    <div>
      <div
        data-path={entry.path}
        data-is-dir={entry.is_dir ? 'true' : undefined}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={cn(
          'flex items-center py-2 pr-2 pl-1 cursor-pointer rounded mx-1 transition-colors duration-150',
          isHidden && 'opacity-50'
        )}
        style={{ paddingLeft: `${4 + indent}px`, backgroundColor: isMultiSelected ? 'rgba(0,180,255,0.07)' : "" }}
        onMouseEnter={(e) => {
          if (!isMultiSelected && !isSelected) {
            e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--sidebar-accent) 60%, transparent)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isMultiSelected && !isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent'
          }
        }}
      >
        <span
          data-chevron
          onClick={handleChevronClick}
          className="pr-2 flex items-center justify-center shrink-0"
        >
          {entry.is_dir && (
            <ChevronRight
              className={cn(
                'size-4 text-muted-foreground opacity-50 transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
          )}
        </span>
        <EntryIcon entry={entry} expanded={expanded} />
        <span className="flex-1 px-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
        <span className="text-right pl-1 pr-1 text-muted-foreground shrink-0" style={{ width: colWidths.size }}>
          {entry.is_dir ? '\u2014' : formatFileSize(entry.size)}
        </span>
        <span className="text-right pl-1 pr-1 text-muted-foreground shrink-0 whitespace-nowrap" style={{ width: colWidths.perms }}>
          {entry.permissions || '\u2014'}
        </span>
        <span className="text-right pl-1 pr-1 text-muted-foreground shrink-0" style={{ width: colWidths.modified }}>
          {entry.modified > 0 ? formatRelativeTime(entry.modified) : '\u2014'}
        </span>
      </div>

      {entry.is_dir && expanded && (
        <div>
          {loading && (
            <div
              className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"
              style={{ paddingLeft: `${24 + (depth + 1) * 16}px` }}
            >
              <Spinner className="w-3 h-3 animate-spin" />
              loading...
            </div>
          )}
          {error && (
            <div
              className="py-0.5 text-xs text-red-400"
              style={{ paddingLeft: `${24 + (depth + 1) * 16}px` }}
            >
              {error}
            </div>
          )}
          {children && (
            <div>
              {children
                .filter((e) => showHidden || !e.name.startsWith("."))
                .map((child) => (
                  <TreeNode
                    key={child.path}
                    entry={child}
                    depth={depth + 1}
                    isSelected={false}
                    isMultiSelected={false}
                    showHidden={showHidden}
                    treeKey={treeKey}
                    colWidths={colWidths}
                    paneId={paneId}
                    connectionType={connectionType}
                    onSelect={onSelect}
                    onNavigate={onNavigate}
                    onOpenFile={onOpenFile}
                    listDirectory={listDirectory}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
