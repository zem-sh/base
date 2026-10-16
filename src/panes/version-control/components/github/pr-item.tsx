import { useState } from 'react'
import { GitPullRequest, GitMerge, Check, Circle, ArrowRight, ExternalLink } from '@mynaui/icons-react'
import { cn } from '../../utils'
import type { GithubPullRequest } from '../../types'

interface PrItemProps {
  pr: GithubPullRequest
  busy: boolean
  onCheckout: (number: number) => void
  onMerge: (number: number) => void
  onClose: (number: number) => void
}

function StateBadge({ state, draft }: { state: string; draft: boolean }) {
  const isMerged = state === 'merged'
  const isClosed = state === 'closed'
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide border',
        isMerged && 'border-purple-400/30 text-purple-400',
        isClosed && 'border-red-400/30 text-red-400',
        !isMerged && !isClosed && draft && 'border-muted-foreground/30 text-muted-foreground',
        !isMerged && !isClosed && !draft && 'border-green-400/30 text-green-400'
      )}
    >
      {isMerged ? (
        <GitMerge className="w-2.5 h-2.5" />
      ) : isClosed ? (
        <Check className="w-2.5 h-2.5" />
      ) : (
        <Circle className="w-2.5 h-2.5 fill-current" />
      )}
      {isMerged ? 'Merged' : isClosed ? 'Closed' : draft ? 'Draft' : 'Open'}
    </span>
  )
}

export function PrItem({ pr, busy, onCheckout, onMerge, onClose }: PrItemProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors hover:bg-accent/30"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <GitPullRequest className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-foreground truncate">{pr.title}</span>
          <StateBadge state={pr.state} draft={pr.draft} />
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="text-muted-foreground/70">#{pr.number}</span>
          {pr.author && <span>by {pr.author}</span>}
          <ArrowRight className="w-2.5 h-2.5" />
          <span className="truncate">{pr.head} → {pr.base}</span>
        </div>
      </div>

      {pr.additions !== undefined && (
        <span className="flex-shrink-0 text-[10px]">
          {pr.additions > 0 && <span className="text-green-500">+{pr.additions}</span>}
          {pr.deletions !== undefined && pr.deletions > 0 && (
            <span className="text-red-500"> -{pr.deletions}</span>
          )}
        </span>
      )}

      {hovered && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {pr.state === 'open' && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onCheckout(pr.number) }}
                disabled={busy}
                className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
                title={`Checkout PR #${pr.number} locally`}
              >
                Checkout
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMerge(pr.number) }}
                disabled={busy}
                className="px-1.5 py-0.5 rounded text-[10px] text-purple-400 hover:bg-accent transition-colors disabled:opacity-50"
                title={`Merge PR #${pr.number}`}
              >
                Merge
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(pr.number) }}
                disabled={busy}
                className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:bg-accent transition-colors disabled:opacity-50"
                title={`Close PR #${pr.number}`}
              >
                Close
              </button>
            </>
          )}
          <a
            href={pr.html_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Open on GitHub"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  )
}
