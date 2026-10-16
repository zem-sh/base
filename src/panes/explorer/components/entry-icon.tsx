import { FolderIcon, FileIcon, DefaultFolderOpenedIcon } from '@react-symbols/icons/utils'
import type { FileEntry } from '../types'

interface EntryIconProps {
  entry: FileEntry
  expanded?: boolean
}

export function EntryIcon({ entry, expanded }: EntryIconProps) {
  const size = 14
  if (entry.is_dir) {
    if (expanded) {
      return <DefaultFolderOpenedIcon width={size} height={size} />
    }
    return <FolderIcon folderName={entry.name} width={size} height={size} />
  }
  return <FileIcon fileName={entry.name} width={size} height={size} autoAssign />
}
