interface StatusBarProps {
  showHidden: boolean
  notif: string | null
  selectedCount: number
  fileCount: number
  folderCount: number
}

export function StatusBar({
  showHidden,
  notif,
  selectedCount,
  fileCount,
  folderCount,
}: StatusBarProps) {
  return (
    <div className="shrink-0 p-2 font-medium text-muted-foreground flex items-center gap-2 border-t border-border">
      {showHidden && (
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          Show hidden
        </span>
      )}
      <div className="flex items-center gap-2 shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
        {fileCount > 0 && (
          <span className="shrink-0">
            <span className="text-green-400">{fileCount}</span> files
          </span>
        )}
        {folderCount > 0 && (
          <span className="shrink-0">
            <span className="text-blue-400">{folderCount}</span> folders
          </span>
        )}
      </div>
      {notif && (
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          {notif}
        </span>
      )}
      {selectedCount > 0 && (
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          <span className="font-semibold text-primary">{selectedCount}</span> selected
        </span>
      )}
    </div>
  )
}