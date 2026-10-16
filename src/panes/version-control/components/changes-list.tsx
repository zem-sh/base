import { useState } from 'react'
import { ChevronRight, ChevronDown, Plus, Minus, X } from '@mynaui/icons-react'
import { FolderIcon, DefaultFolderOpenedIcon } from '@react-symbols/icons/utils'
import type { GitStatus, ChangedFile, ChangedFileNode } from '../types'
import { FileItem } from './file-item'
import { Button } from './ui/button'

interface ChangesListProps {
  status: GitStatus
  visualSelection: string[]
  onSelect: (path: string | null) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onShowDiff: (path: string, staged: boolean) => void
}

function hasStaged(node: ChangedFileNode): boolean {
  if (!node.isDir) return node.staged
  return node.children.some(hasStaged)
}

function hasUnstaged(node: ChangedFileNode): boolean {
  if (!node.isDir) return !node.staged
  return node.children.some(hasUnstaged)
}

function hasTrackedChanges(node: ChangedFileNode): boolean {
  if (!node.isDir) return node.status !== 'untracked'
  return node.children.some(hasTrackedChanges)
}

interface TreeNodeProps {
  node: ChangedFileNode
  depth: number
  visualSelection: string[]
  onSelect: (path: string | null) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onShowDiff: (path: string, staged: boolean) => void
}

function TreeNode({
  node,
  depth,
  visualSelection,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onShowDiff,
}: TreeNodeProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [expanded, setExpanded] = useState(depth === 0)

  if (!node.isDir) {
    const file: ChangedFile = {
      path: node.path,
      status: node.status ?? 'modified',
      staged: node.staged,
    }
    // Indentation lives on the row itself (not a wrapper) so the selected
    // background spans the full width, matching folder rows.
    return (
      <FileItem
        file={file}
        depth={depth}
        multiSelected={visualSelection.includes(node.path)}
        onSelect={onSelect}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
        onShowDiff={onShowDiff}
      />
    )
  }

  const staged = hasStaged(node)
  const unstaged = hasUnstaged(node)

  return (
    <div>
      <div
        data-path={node.path}
        data-is-dir
        onClick={() => onSelect(node.path)}
        className={`flex items-center gap-1.5 pr-2 py-1 cursor-pointer transition-colors ${visualSelection.includes(node.path)
            ? 'bg-accent/30'
            : isHovered ? 'bg-accent/30' : ''
          }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          data-chevron
          onClick={() => setExpanded((e) => !e)}
          className="p-0.5 rounded hover:bg-accent transition-colors flex-shrink-0"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
        <span className="flex-shrink-0">
          {expanded ? (
            <DefaultFolderOpenedIcon width={14} height={14} />
          ) : (
            <FolderIcon folderName={node.name} width={14} height={14} />
          )}
        </span>
        <span className="text-xs truncate flex-1">{node.name}</span>

        <div className="flex items-center gap-2 shrink-0">
          {/* Action buttons: visible on hover */}
          <span
            className={`inline-flex items-center gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
          >
            {staged ? (
              <Button
                onClick={(e) => { e.stopPropagation(); onUnstage(node.path) }}
                variant="outline"
                size="icon-sm"
                title="Unstage folder"
              >
                <Minus className="size-3.5" />
              </Button>
            ) : unstaged ? (
              <Button
                onClick={(e) => { e.stopPropagation(); onStage(node.path) }}
                variant="outline"
                size="icon-sm"
                title="Stage folder"
              >
                <Plus className="size-3.5" />
              </Button>
            ) : null}
            {hasTrackedChanges(node) && (
              <Button
                onClick={(e) => { e.stopPropagation(); onDiscard(node.path) }}
                variant="outline"
                size="icon-sm"
                title="Discard folder changes"
              >
                <X className="size-3.5" />
              </Button>
            )}
            <div className='bg-primary w-[16px]'>
            </div>
          </span>
        </div>
      </div>

      {expanded &&
        node.children.map((child) => (            <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            visualSelection={visualSelection}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            onShowDiff={onShowDiff}
          />
        ))}
    </div>
  )
}

function buildTree(files: ChangedFile[]): ChangedFileNode[] {
  const root: ChangedFileNode[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    let nodes = root
    let path = ''
    parts.forEach((part, i) => {
      path = path ? `${path}/${part}` : part
      const isLast = i === parts.length - 1
      let node = nodes.find((n) => n.path === path)
      if (!node) {
        node = {
          name: part,
          path,
          isDir: !isLast,
          status: isLast ? file.status : undefined,
          staged: isLast ? file.staged : false,
          children: [],
        }
        nodes.push(node)
      }
      if (!isLast) nodes = node.children
    })
  }
  const sortNodes = (list: ChangedFileNode[]) => {
    list.sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name))
    list.forEach((n) => sortNodes(n.children))
  }
  sortNodes(root)

  // Mirror the backend's compress_node: collapse a directory into its single
  // directory child when it holds no direct file changes itself — e.g. when
  // only src/components/button.tsx changed, show one "src/components" folder
  // instead of nesting src -> components.
  const compressNode = (node: ChangedFileNode) => {
    for (const child of node.children) compressNode(child)
    while (node.children.length === 1 && node.children[0].isDir) {
      const child = node.children[0]
      node.path = child.path
      node.name = `${node.name}/${child.name}`
      node.children = child.children
    }
  }
  root.forEach(compressNode)
  return root
}

export function ChangesList({
  status,
  visualSelection,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onShowDiff,
}: ChangesListProps) {
  const files = status.files || []
  const tree = status.tree && status.tree.length > 0 ? status.tree : buildTree(files)

  const hasChanges = tree.length > 0

  return (
    <div>
      {hasChanges ? (
        tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            visualSelection={visualSelection}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            onShowDiff={onShowDiff}
          />
        ))
      ) : (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
          No changes — work tree clean
        </div>
      )}
    </div>
  )
}
