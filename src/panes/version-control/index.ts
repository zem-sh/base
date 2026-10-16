export { VersionControlPane, register, unregister, registerVersionControlPane, setAddonApi } from './index.tsx'
export type { 
  GitStatus, 
  ChangedFile, 
  DiffInfo, 
  DiffLine,
  BranchInfo,
  StashInfo,
  FileStatus 
} from './types'
export { useStore } from './store'
export { useGit } from './hooks/use-git'
export { versionControlLaunchSchema } from './launch-schema'