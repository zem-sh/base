import { useState } from 'react'
import { Circle, Check, GitPullRequest, Chat, ExternalLink } from '@mynaui/icons-react'
import { cn } from '../../utils'
import type { GithubIssue } from '../../types'

interface IssueItemProps {
  issue: GithubIssue
}

export function IssueItem({ issue }: IssueItemProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors hover:bg-accent/30"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {issue.is_pull_request ? (
        <GitPullRequest className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
      ) : (
        <Circle
          className={cn(
            'w-3.5 h-3.5 flex-shrink-0',
            issue.state === 'open' ? 'text-green-500 fill-current' : 'text-red-400'
          )}
        />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-foreground truncate">{issue.title}</span>
          {issue.state === 'closed' && <Check className="w-3 h-3 text-red-400 flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="text-muted-foreground/70">#{issue.number}</span>
          {issue.author && <span>opened by {issue.author}</span>}
          {issue.labels.length > 0 && (
            <span className="flex items-center gap-0.5 min-w-0">
              {issue.labels.slice(0, 2).map((label) => (
                <span key={label} className="rounded px-1 py-px bg-accent text-[9px] text-foreground/70 max-w-24 truncate">
                  {label}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>

      {issue.comments > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground flex-shrink-0">
          <Chat className="w-3 h-3" />
          {issue.comments}
        </span>
      )}

      {hovered && issue.html_url && (
        <a
          href={issue.html_url}
          target="_blank"
          rel="noreferrer"
          className="p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex-shrink-0"
          title="Open on GitHub"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  )
}
