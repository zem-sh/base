import type { ColWidths } from '../types'

interface ColumnHeaderProps {
  colWidths: ColWidths
  onResize: (col: string, e: React.MouseEvent) => void
}

export function ColumnHeader({ colWidths, onResize }: ColumnHeaderProps) {
  return (
    <div className="flex items-center py-1.5 px-2 text-muted-foreground border-border sticky top-0 font-medium">
      <span className="w-5 shrink-0" />
      <span className="flex-1 min-w-[80px] pl-1 pr-2 overflow-hidden text-ellipsis whitespace-nowrap">Name</span>
      <div className="relative shrink-0">
        <span className="text-right pr-2 block" style={{ width: colWidths.size }}>Size</span>
        <span
          onMouseDown={(e) => onResize('size', e)}
          className="absolute left-[-4px] top-[-8px] bottom-[-8px] w-2 cursor-col-resize z-10"
        />
      </div>
      <div className="relative shrink-0">
        <span className="text-right pr-2 whitespace-nowrap block" style={{ width: colWidths.perms }}>Perms</span>
        <span
          onMouseDown={(e) => onResize('perms', e)}
          className="absolute left-[-4px] top-[-8px] bottom-[-8px] w-[3px] cursor-col-resize z-10"
        />
      </div>
      <div className="relative shrink-0">
        <span className="text-right pr-1 block" style={{ width: colWidths.modified }}>Modified</span>
        <span
          onMouseDown={(e) => onResize('modified', e)}
          className="absolute left-[-4px] top-[-8px] bottom-[-8px] w-2 cursor-col-resize z-10"
        />
      </div>
    </div>
  )
}
