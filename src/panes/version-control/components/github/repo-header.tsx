import { Github, Star, GitBranch, Inbox, Lock, Users, ExternalLink } from '@mynaui/icons-react'
import type { GithubStatus } from '../../types'

interface RepoHeaderProps {
  status: GithubStatus
}

export function RepoHeader({ status }: RepoHeaderProps) {
  const repo = status.repoInfo
  const owner = status.owner || repo?.owner || ''
  const name = status.repo || repo?.name || ''

  return (
    <div className="shrink-0 px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 min-w-0">
        <Github className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        {repo ? (
          <a
            className="text-xs font-medium truncate text-foreground hover:text-primary hover:underline flex items-center gap-1"
            href={repo.url}
            target="_blank"
            rel="noreferrer"
          >
            <span className="truncate">{owner}/{name}</span>
            <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          </a>
        ) : (
          <span className="text-xs font-medium truncate">{owner}/{name}</span>
        )}
        {repo?.private && (
          <span className="shrink-0 flex items-center gap-0.5 rounded px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground border border-border">
            <Lock className="w-2.5 h-2.5" />
            Private
          </span>
        )}
      </div>

      {repo && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {repo.default_branch && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="w-3 h-3" />
              {repo.default_branch}
            </span>
          )}
          <span className="flex items-center gap-0.5">
            <Star className="w-3 h-3" />
            {repo.stars}
          </span>
          <span className="flex items-center gap-0.5">
            <GitBranch className="w-3 h-3" />
            {repo.forks}
          </span>
          <span className="flex items-center gap-0.5">
            <Inbox className="w-3 h-3" />
            {repo.open_issues}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        {status.user ? (
          <span className="flex items-center gap-1 min-w-0">
            <Users className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">@{status.user.login}</span>
          </span>
        ) : (
          <span>Not authenticated</span>
        )}
        {status.rate && (
          <span className="shrink-0">
            Rate limit {status.rate.remaining}/{status.rate.limit}
          </span>
        )}
      </div>
    </div>
  )
}
