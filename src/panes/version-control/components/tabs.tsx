import { GitBranch, Github } from '@mynaui/icons-react'
import { cn } from '../utils'
import type { VersionControlTab } from '../types'

interface TabsProps {
  active: VersionControlTab
  gitCount: number
  onChange: (tab: VersionControlTab) => void
}

export function Tabs({ active, gitCount, onChange }: TabsProps) {
  return (
    <div className="shrink-0 flex items-center gap-1 p-2 min-w-0">
      <TabButton active={active === 'git'} onClick={() => onChange('git')}>
        <GitBranch className="w-3.5 h-3.5" />
        <span>Git</span>
        {gitCount > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[9px] font-medium text-foreground/70">
            {gitCount}
          </span>
        )}
      </TabButton>
      <TabButton active={active === 'github'} onClick={() => onChange('github')}>
        <Github className="w-3.5 h-3.5" />
        <span>GitHub</span>
      </TabButton>
    </div>
  )
}

function TabButton({
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
        'flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      )}
    >
      {children}
    </button>
  )
}
