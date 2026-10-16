import { useEffect, useState } from 'react'
import { Refresh, Key, GitPullRequest, GitCommit } from '@mynaui/icons-react'
import { cn } from '../../utils'
import { useStore } from '../../store'
import { useGitHub } from '../../hooks/use-github'
import { Button } from '../ui/button'
import { TokenForm } from './token-form'
import { RepoHeader } from './repo-header'
import { PrItem } from './pr-item'
import { IssueItem } from './issue-item'
import { CreatePrForm } from './create-pr-form'

export function GithubTab({ currentBranch }: { currentBranch: string }) {
  const {
    githubStatus,
    githubLoading,
    githubError,
    githubPulls,
    githubIssues,
    githubSegment,
    setGithubSegment,
  } = useStore()

  const github = useGitHub()
  const [creating, setCreating] = useState(false)
  const [busyPr, setBusyPr] = useState<number | null>(null)

  useEffect(() => {
    github.fetchStatus()
  }, [])

  const status = githubStatus
  const repo = status?.repoInfo
  const head = currentBranch
  const defaultBase = repo?.default_branch || 'main'

  const handleCheckout = async (number: number) => {
    setBusyPr(number)
    await github.checkoutPr(number)
    setBusyPr(null)
  }

  const handleMerge = async (number: number) => {
    setBusyPr(number)
    await github.mergePr(number)
    setBusyPr(null)
  }

  const handleClose = async (number: number) => {
    setBusyPr(number)
    await github.updatePr(number, 'closed')
    setBusyPr(null)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 p-2 border-b border-border min-w-0">
        <Button
          variant="outline"
          size="icon-lg"
          onClick={() => github.fetchStatus()}
          disabled={githubLoading}
          title="Refresh GitHub data"
        >
          <Refresh className={cn('w-4 h-4', githubLoading && 'animate-spin')} />
        </Button>
        {status?.configured ? (
          <Button
            variant="outline"
            size="lg"
            onClick={() => github.clearToken()}
            title="Disconnect GitHub"
          >
            <Key className="w-3.5 h-3.5" />
            <span>Disconnect</span>
          </Button>
        ) : null}
        <div className="flex-1" />
        {status?.configured && (
          <Button
            variant="outline"
            size="lg"
            onClick={() => setCreating((c) => !c)}
            className={cn(creating && 'text-green-400')}
            title="Create a pull request"
          >
            <GitPullRequest className="w-3.5 h-3.5" />
            <span>New PR</span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto vcs-scroll min-h-0">
        {githubLoading && !status ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            Contacting GitHub...
          </div>
        ) : githubError && !status ? (
          <div className="p-3 text-xs text-red-400">{githubError}</div>
        ) : !status ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            No git remote detected
          </div>
        ) : (
          <>
            {!status.configured ? (
              <TokenForm
                loading={githubLoading}
                onSave={github.setToken}
              />
            ) : (
              <>
                <RepoHeader status={status} />
                {creating && (
                  <CreatePrForm
                    head={head}
                    defaultBase={defaultBase}
                    loading={githubLoading}
                    onSubmit={async (title, body, base) => {
                      const pr = await github.createPr(title, body, base)
                      return pr !== null
                    }}
                    onCancel={() => setCreating(false)}
                  />
                )}

                <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/20">
                  <SegmentButton
                    active={githubSegment === 'pulls'}
                    onClick={() => {
                      setGithubSegment('pulls')
                      if (status.configured) github.fetchPulls('open')
                    }}
                  >
                    <GitPullRequest className="w-3 h-3" />
                    Pull Requests
                  </SegmentButton>
                  <SegmentButton
                    active={githubSegment === 'issues'}
                    onClick={() => {
                      setGithubSegment('issues')
                      if (status.configured) github.fetchIssues('open')
                    }}
                  >
                    <GitCommit className="w-3 h-3" />
                    Issues
                  </SegmentButton>
                </div>

                {githubError && (
                  <div className="px-3 py-1.5 text-[10px] text-red-400 border-b border-border">
                    {githubError}
                  </div>
                )}

                {githubSegment === 'pulls' ? (
                  <div className="divide-y divide-border/50">
                    {githubPulls.length === 0 && !githubLoading ? (
                      <div className="px-3 py-6 text-center text-muted-foreground text-xs">
                        No pull requests
                      </div>
                    ) : (
                      githubPulls.map((pr) => (
                        <PrItem
                          key={pr.number}
                          pr={pr}
                          busy={busyPr === pr.number}
                          onCheckout={handleCheckout}
                          onMerge={handleMerge}
                          onClose={handleClose}
                        />
                      ))
                    )}
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {githubIssues.length === 0 && !githubLoading ? (
                      <div className="px-3 py-6 text-center text-muted-foreground text-xs">
                        No issues
                      </div>
                    ) : (
                      githubIssues.map((issue) => (
                        <IssueItem key={issue.number} issue={issue} />
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      )}
    >
      {children}
    </button>
  )
}
