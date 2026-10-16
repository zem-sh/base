import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { usePane, type PaneComponentProps } from '@zem-sh/pane'
import { GitBranch } from '@mynaui/icons-react'
import { useStore } from './store'
import { useGit, setAddonApi } from './hooks/use-git'
import { useGitHub } from './hooks/use-github'
import { useVCKeyboard } from './hooks/use-vc-keyboard'
import { useVCSettings } from './settings-store'
import { vcSettingsSchema } from './settings-schema'
import { Tabs } from './components/tabs'
import { Toolbar } from './components/toolbar'
import { ChangesList } from './components/changes-list'
import { CommitPanel } from './components/commit-panel'
import { DiffView } from './components/diff-view'
import { StatusBar } from './components/status-bar'
import { GithubTab } from './components/github/github-tab'
import type { DiffInfo } from './types'
import { versionControlLaunchSchema } from './launch-schema'

// Self-inject CSS
// @ts-ignore
import styles from './styles.css?inline'
if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="version-control"]')) {
  const s = document.createElement('style')
  s.textContent = styles
  s.setAttribute('data-pane-css', 'version-control')
  document.head.appendChild(s)
}

const paneRegistry = (window as any).__zemPaneRegistry

function normalizeTreePaths(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length)
  return unique.filter((path, index) => !unique
    .slice(0, index)
    .some((parent) => path.startsWith(`${parent}/`)))
}

// Export setAddonApi for the app to inject the API
export { setAddonApi }

export function VersionControlPane({ paneId, isFocused }: PaneComponentProps) {
  const {
    status,
    loading,
    error,
    setError,
    selectedFile,
    visualSelection,
    commitMessage,
    showDiff,
    diffContent,
    activeTab,
    branches,
    stashes,
    setActiveTab,
    setSelectedFile,
    setCommitMessage,
    setShowDiff,
    setDiffContent,
    setVisualSelection,
  } = useStore()

  const git = useGit()
  const github = useGitHub()
  const { confirmDiscard } = useVCSettings()
  const [batchBusy, setBatchBusy] = useState(false)
  const [sshDialog, setSshDialog] = useState<{ operation: string; passphrase: string } | null>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const changesContainerRef = useRef<HTMLDivElement>(null)
  const refreshingRef = useRef(false)

  // Set the pane ID so the addon knows which pane to use
  useEffect(() => {
    git.setPaneId(paneId)
    github.setPaneId(paneId)
  }, [paneId])

  // Guard against overlapping refresh cycles. On page load the initial
  // useEffect and a WebSocket addon_action_updated event can fire back-to-back,
  // spawning concurrent fetchStatus/fetchBranches/fetchStashes calls. When the
  // first fetchStatus completes it sets loading=false while the second is still
  // in flight, which can briefly show stale or empty data.
  const refreshGit = () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    Promise.all([
      git.fetchStatus(),
      git.fetchBranches(),
      git.fetchStashes(),
    ]).finally(() => {
      refreshingRef.current = false
    })
  }

  const { rootRef } = usePane(
    paneId,
    isFocused,
    () => { /* focus handling */ },
    (action, path) => {
      if (action === 'refresh') {
        refreshGit()
      } else if (action === 'stage' && path) {
        git.stageFile(path)
      } else if (action === 'unstage' && path) {
        git.unstageFile(path)
      } else if (action === 'discard' && path) {
        git.discardFile(path)
      } else if (action === 'commit') {
        handleCommit()
      }
    }
  )

  const handleCommit = async () => {
    const success = await git.commit(commitMessage)
    if (success) {
      setCommitMessage('')
    }
  }

  // ── Batch actions over the visual selection ────────────────────────────────
  // A selected path is either a leaf file (present in status.files) or a folder
  // row (not in the flat list — staging/discarding its path covers the subtree).
  const handleStageSelected = async () => {
    if (batchBusy) return
    setBatchBusy(true)
    try {
      const files = useStore.getState().status?.files ?? []
      for (const path of normalizeTreePaths(visualSelection)) {
        const f = files.find((x) => x.path === path)
        if (f && f.staged) continue // already staged — skip
        await git.stageFile(path)
      }
      setVisualSelection([])
    } finally {
      setBatchBusy(false)
    }
  }

  const handleDiscardSelected = async () => {
    if (batchBusy) return
    const files = useStore.getState().status?.files ?? []
    const paths = normalizeTreePaths(visualSelection).filter((path) => {
      const f = files.find((x) => x.path === path)
      return !f || f.status !== 'untracked'
    })
    if (paths.length === 0) {
      setVisualSelection([])
      return
    }
    if (confirmDiscard && !window.confirm(`Discard changes to ${paths.length} item(s)?`)) return
    setBatchBusy(true)
    try {
      for (const path of paths) {
        await git.discardFile(path)
      }
      setVisualSelection([])
    } finally {
      setBatchBusy(false)
    }
  }

  const handleClearSelection = () => {
    if (!batchBusy) setVisualSelection([])
  }

  const handleShowDiff = async (filePath: string, staged = false) => {
    const file = (status?.files ?? []).find((f) => f.path === filePath)
    if (file?.status === 'conflict') {
      const conflict = await git.fetchConflictFile(filePath)
      if (conflict) {
        setDiffContent({
          filePath,
          lines: [],
          isConflict: true,
          conflictContent: conflict.content,
        } as DiffInfo)
        setShowDiff(true)
      }
      return
    }
    const diff = await git.fetchDiff(filePath, staged)
    if (diff) {
      setDiffContent(diff as DiffInfo)
      setShowDiff(true)
    }
  }

  // ── Auto-select the first change once status loads ───────────────────────
  // Without this the indicator is hidden until the first J/K press. Uses the
  // same DOM rows the keyboard navigates, so the selection lands on a real row.
  useEffect(() => {
    if (loading || !status || selectedFile) return
    const container = changesContainerRef.current
    const first = container?.querySelector<HTMLElement>('[data-path]')
    if (first?.dataset.path) setSelectedFile(first.dataset.path)
  }, [status, loading, selectedFile, setSelectedFile])

  // ── Selection indicator bar ─────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = indicatorRef.current
    if (!el) return
    if (!selectedFile) { el.style.display = 'none'; return }
    const container = changesContainerRef.current
    if (!container || !container.isConnected) { el.style.display = 'none'; return }
    const escaped = selectedFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const row = container.querySelector<HTMLElement>(`[data-path="${escaped}"]`)
    if (!row) { el.style.display = 'none'; return }
    el.style.display = 'block'
    el.style.top = `${row.offsetTop}px`
    el.style.height = `${row.offsetHeight}px`
    row.scrollIntoView({ block: 'nearest' })
  }, [selectedFile, status])

  // ── Vim-style keyboard navigation ────────────────────────────────────────
  useVCKeyboard({
    paneId,
    isFocused,
    containerRef: changesContainerRef,
    onStage: git.stageFile,
    onUnstage: git.unstageFile,
    onDiscard: git.discardFile,
    onShowDiff: handleShowDiff,
    onSwitchTab: (tab) => setActiveTab(tab),
  })

  // Initial load
  useEffect(() => {
    refreshGit()

    // Refresh when the addon's git watcher detects actual changes. The watcher
    // updates the git actions (git_branch/git_changes/git_remote_status) which
    // broadcasts an `addon_action_updated` event. No polling needed.
    const handler = (e: Event) => {
      const payload = (e as CustomEvent).detail
      if (payload?.addon_id === 'com.zem.core') {
        refreshGit()
        // Push/fetch can change PR state; keep GitHub data fresh when connected.
        if (useStore.getState().githubStatus?.configured) {
          github.fetchStatus()
        }
      }
    }
    window.addEventListener('addon_action_updated', handler)

    return () => {
      window.removeEventListener('addon_action_updated', handler)
      git.stopPolling()
    }
  }, [])

  const files = status?.files || []
  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged && f.status !== 'untracked' && f.status !== 'deleted')
  const untrackedFiles = files.filter((f) => f.status === 'untracked')
  const deletedFiles = files.filter((f) => !f.staged && f.status === 'deleted')
  const totalChanges = stagedFiles.length + unstagedFiles.length + untrackedFiles.length + deletedFiles.length

  return (
    <div ref={rootRef} className="relative w-full h-full flex flex-col text-xs min-h-0">
      <div className='flex justify-between'>
        <Tabs
          active={activeTab}
          gitCount={totalChanges}
          onChange={setActiveTab}
        />

        {status && (
          <Toolbar
            branch={status.branch}
            loading={loading}
            ahead={status.ahead}
            behind={status.behind}
            branches={branches}
            stashes={stashes}
            onRefresh={refreshGit}
            onPush={async () => {
              const r = await git.push()
              if (!r.success && r.error && /publickey|Permission denied/i.test(r.error)) {
                setError(null)
                setSshDialog({ operation: 'push', passphrase: '' })
              }
            }}
            onPull={async () => {
              const r = await git.pull()
              if (!r.success && r.error && /publickey|Permission denied/i.test(r.error)) {
                setError(null)
                setSshDialog({ operation: 'pull', passphrase: '' })
              }
            }}
            onFetch={async () => {
              const r = await git.fetch()
              if (!r.success && r.error && /publickey|Permission denied/i.test(r.error)) {
                setError(null)
                setSshDialog({ operation: 'fetch', passphrase: '' })
              }
            }}
            onStash={() => git.createStash()}
            onCheckoutBranch={git.checkoutBranch}
            onStageAll={git.stageAll}
            onUnstageAll={git.unstageAll}
            onPopStash={git.popStash}
            onDropStash={git.dropStash}
          />
        )}
      </div>

      {/* SSH passphrase dialog */}
      {sshDialog && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-popover border border-border rounded-lg p-4 shadow-lg w-72">
            <div className="text-sm font-medium mb-3">
              SSH passphrase required for <span className="text-primary">{sshDialog.operation}</span>
            </div>
            <input
              autoFocus
              type="password"
              value={sshDialog.passphrase}
              onChange={(e) => setSshDialog({ ...sshDialog, passphrase: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const op = sshDialog.operation
                  const pass = sshDialog.passphrase
                  setSshDialog(null)
                  if (op === 'push') git.push(pass)
                  else if (op === 'pull') git.pull(pass)
                  else if (op === 'fetch') git.fetch(pass)
                } else if (e.key === 'Escape') {
                  setSshDialog(null)
                }
              }}
              placeholder="Enter your SSH passphrase"
              className="w-full bg-card border border-border rounded px-2 py-1.5 text-xs outline-none focus:border-primary mb-3"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSshDialog(null)}
                className="px-3 py-1 text-xs rounded bg-muted hover:bg-muted/80"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const op = sshDialog.operation
                  const pass = sshDialog.passphrase
                  setSshDialog(null)
                  if (op === 'push') git.push(pass)
                  else if (op === 'pull') git.pull(pass)
                  else if (op === 'fetch') git.fetch(pass)
                }}
                className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'github' ? (
        <GithubTab currentBranch={status?.branch || ''} />
      ) : (
        <>
          <div ref={changesContainerRef} className="flex-1 overflow-y-auto vcs-scroll min-h-0 relative">
            <div
              ref={indicatorRef}
              className="absolute left-0 rounded-r-sm pointer-events-none z-10"
              style={{ display: 'none', backgroundColor: 'var(--primary)', width: 3 }}
            />
            {loading && !status ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Loading repository status...
              </div>
            ) : error ? (
              <div className="p-4 text-red-400 text-xs">{error}</div>
            ) : !status ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Not a git repository
              </div>
            ) : (
              <div>

                <CommitPanel
                  message={commitMessage}
                  onChange={setCommitMessage}
                  onCommit={handleCommit}
                  loading={loading}
                  disabled={totalChanges === 0}
                />

                <ChangesList
                  status={status}
                  visualSelection={visualSelection}
                  onSelect={setSelectedFile}
                  onStage={git.stageFile}
                  onUnstage={git.unstageFile}
                  onDiscard={git.discardFile}
                  onShowDiff={handleShowDiff}
                />
              </div>
            )}
          </div>

          {showDiff && diffContent && (
            <DiffView
              diff={diffContent}
              file={selectedFile ? (status?.files ?? []).find(f => f.path === selectedFile) ?? null : null}
              onClose={() => {
                setShowDiff(false)
                setDiffContent(null)
              }}
              onStage={git.stageFile}
              onUnstage={git.unstageFile}
              onDiscard={git.discardFile}
              getFileContents={git.getFileContents}
              onResolveConflict={git.resolveConflictFile}
            />
          )}


          {status && (
            <StatusBar
              stagedCount={stagedFiles.length}
              unstagedCount={unstagedFiles.length}
              untrackedCount={untrackedFiles.length}
              deletedCount={deletedFiles.length}
              loading={loading}
              selectedCount={visualSelection.length}
              busy={batchBusy}
              onStageSelected={() => void handleStageSelected()}
              onDiscardSelected={() => void handleDiscardSelected()}
              onClearSelection={handleClearSelection}
            />
          )}
        </>
      )}
    </div>
  )
}

export function register(): void {
  paneRegistry.register({
    kind: 'version-control',
    title: 'Version Control',
    description: 'Git status, diffs, staging and commits — plus GitHub',
    icon: ({ className }: { className?: string }) => (
      <GitBranch className={className} />
    ),
    component: VersionControlPane,
    settingsSchema: vcSettingsSchema,
    launchSchema: versionControlLaunchSchema,
    contextMenuActions: (paneId: number, targetPath?: string) => {
      return [
        {
          label: 'Refresh',
          shortcut: 'r',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'refresh' } }))
          }
        },
        ...(targetPath ? [
          {
            label: 'Stage',
            shortcut: 's',
            action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'stage', path: targetPath } }))
            }
          },
          {
            label: 'Discard',
            shortcut: 'd',
            danger: true,
            action: () => {
              window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'discard', path: targetPath } }))
            }
          }
        ] : [])
      ]
    },
    registerBindings() {
      return [
        {
          id: 'new-version-control',
          keys: [{ key: 'g', meta: true, shift: true }],
          description: 'Open Version Control pane',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'version-control' } }))
          },
        },
      ]
    },
  })
}

export function unregister(): void {
  paneRegistry.unregister('version-control')
}

export const registerVersionControlPane = register
