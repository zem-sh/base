import { create } from 'zustand'
import {
  PaneState,
  GitStatus,
  DiffInfo,
  BranchInfo,
  StashInfo,
  VersionControlTab,
  GithubStatus,
  GithubPullRequest,
  GithubIssue,
  GithubSegment,
} from './types'

interface VersionControlStore extends PaneState {
  activeTab: VersionControlTab
  visualSelection: string[]
  githubStatus: GithubStatus | null
  githubLoading: boolean
  githubError: string | null
  githubPulls: GithubPullRequest[]
  githubIssues: GithubIssue[]
  githubSegment: GithubSegment
  setActiveTab: (tab: VersionControlTab) => void
  setVisualSelection: (sel: string[]) => void
  setStatus: (status: GitStatus | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setSelectedFile: (path: string | null) => void
  setCommitMessage: (message: string) => void
  setShowDiff: (show: boolean) => void
  setDiffContent: (diff: DiffInfo | null) => void
  setBranches: (branches: BranchInfo[]) => void
  setStashes: (stashes: StashInfo[]) => void
  setGithubStatus: (status: GithubStatus | null) => void
  setGithubLoading: (loading: boolean) => void
  setGithubError: (error: string | null) => void
  setGithubPulls: (pulls: GithubPullRequest[]) => void
  setGithubIssues: (issues: GithubIssue[]) => void
  setGithubSegment: (segment: GithubSegment) => void
  reset: () => void
}

export const useStore = create<VersionControlStore>((set) => ({
  status: null,
  loading: false,
  error: null,
  selectedFile: null,
  commitMessage: '',
  showDiff: false,
  diffContent: null,
  branches: [],
  stashes: [],
  activeTab: 'git',
  visualSelection: [] as string[],
  githubStatus: null,
  githubLoading: false,
  githubError: null,
  githubPulls: [],
  githubIssues: [],
  githubSegment: 'pulls',

  setActiveTab: (tab) => set({ activeTab: tab }),
  setVisualSelection: (visualSelection) => set({ visualSelection }),
  setStatus: (status) => set({ status }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSelectedFile: (path) => set({ selectedFile: path }),
  setCommitMessage: (message) => set({ commitMessage: message }),
  setShowDiff: (show) => set({ showDiff: show }),
  setDiffContent: (diff) => set({ diffContent: diff }),
  setBranches: (branches) => set({ branches }),
  setStashes: (stashes) => set({ stashes }),
  setGithubStatus: (status) => set({ githubStatus: status }),
  setGithubLoading: (loading) => set({ githubLoading: loading }),
  setGithubError: (error) => set({ githubError: error }),
  setGithubPulls: (pulls) => set({ githubPulls: pulls }),
  setGithubIssues: (issues) => set({ githubIssues: issues }),
  setGithubSegment: (segment) => set({ githubSegment: segment }),
  reset: () => set({
    status: null,
    loading: false,
    error: null,
    selectedFile: null,
    commitMessage: '',
    showDiff: false,
    diffContent: null,
    branches: [],
    stashes: [],
    activeTab: 'git',
    visualSelection: [] as string[],
    githubStatus: null,
    githubLoading: false,
    githubError: null,
    githubPulls: [],
    githubIssues: [],
    githubSegment: 'pulls',
  }),
}))
