export type FileStatus = 'modified' | 'staged' | 'untracked' | 'deleted' | 'renamed' | 'conflict'

export interface ChangedFile {
  path: string
  status: FileStatus
  staged: boolean
  additions?: number
  deletions?: number
}

export interface ChangedFileNode {
  name: string
  path: string
  isDir: boolean
  status?: FileStatus
  staged: boolean
  children: ChangedFileNode[]
}

export interface GitStatus {
  branch: string
  upstream?: string
  ahead?: number
  behind?: number
  files: ChangedFile[]
  tree: ChangedFileNode[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
}

export interface CommitInfo {
  hash: string
  message: string
  author: string
  date: string
}

export interface DiffInfo {
  filePath: string
  oldPath?: string
  newPath?: string
  isNew?: boolean
  isDeleted?: boolean
  isRenamed?: boolean
  isBinary?: boolean
  isImage?: boolean
  oldBlobBase64?: string
  newBlobBase64?: string
  lines: DiffLine[]
  rawPatch?: string
  staged?: boolean
  additions?: number
  deletions?: number
  isTruncated?: boolean
  /** True when the file has unresolved merge conflict markers. */
  isConflict?: boolean
  /** Raw working-tree contents (contains conflict markers) for conflict files. */
  conflictContent?: string
}

export interface FileContentsResult {
  old?: string | null
  new?: string | null
}

export interface ConflictFileResult {
  filePath: string
  isConflict: boolean
  content: string
}

export interface DiffLine {
  type: 'added' | 'removed' | 'context' | 'header'
  content: string
  oldLine?: number
  newLine?: number
}

export interface BranchInfo {
  name: string
  current: boolean
  tracking?: string
}

export interface StashInfo {
  index: number
  message: string
}

export interface PaneState {
  status: GitStatus | null
  loading: boolean
  error: string | null
  selectedFile: string | null
  commitMessage: string
  showDiff: boolean
  diffContent: DiffInfo | null
  branches: BranchInfo[]
  stashes: StashInfo[]
}

export type VersionControlTab = 'git' | 'github'

export interface GithubRepoInfo {
  owner: string
  name: string
  url: string
  description?: string
  default_branch: string
  private: boolean
  stars: number
  forks: number
  open_issues: number
  pushed_at?: string
}

export interface GithubUser {
  login: string
  name?: string
  avatar_url?: string
  url: string
}

export interface GithubRateLimit {
  remaining: number
  limit: number
  reset_at?: string
}

export interface GithubStatus {
  owner: string
  repo: string
  configured: boolean
  error?: string
  repoInfo?: GithubRepoInfo
  user?: GithubUser
  rate?: GithubRateLimit
}

export interface GithubPullRequest {
  number: number
  title: string
  state: string
  draft: boolean
  body?: string
  author?: string
  head: string
  base: string
  html_url: string
  updated_at?: string
  additions?: number
  deletions?: number
  changed_files?: number
}

export interface GithubIssue {
  number: number
  title: string
  state: string
  author?: string
  created_at?: string
  updated_at?: string
  comments: number
  labels: string[]
  is_pull_request: boolean
  html_url: string
}

export interface GithubReview {
  user?: string
  state: string
  submitted_at?: string
}

export type GithubSegment = 'pulls' | 'issues'