import { useMemo, useState } from 'react'
import { X, Check } from '@mynaui/icons-react'
import {
  parseConflictContent,
  resolveSegment,
  segmentsToContent,
  type Resolution,
  type ConflictSegment,
} from './conflict-parse'

interface ConflictResolverProps {
  filePath: string
  content: string
  onResolve: (content: string) => void | Promise<void>
  onResolved: () => void
  onClose?: () => void
}

const RESOLUTIONS: Array<{ value: Resolution; label: string }> = [
  { value: 'current', label: 'Accept current' },
  { value: 'incoming', label: 'Accept incoming' },
  { value: 'both', label: 'Accept both' },
]

export function ConflictResolver({ filePath, content, onResolve, onResolved, onClose }: ConflictResolverProps) {
  const initial = useMemo(() => parseConflictContent(content), [content])
  const [segments, setSegments] = useState<ConflictSegment[]>(initial)

  const resolved = !segments.some((s) => s.type === 'conflict')

  const handleResolve = async (index: number, resolution: Resolution) => {
    const seg = segments[index]
    if (!seg || seg.type !== 'conflict') return
    const resolvedText = resolveSegment(seg, resolution)
    const next = segments.map((s, i) =>
      i === index ? { type: 'text' as const, content: resolvedText } : s,
    )
    setSegments(next)
    await onResolve(segmentsToContent(next))
  }

  if (resolved) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15 text-green-500">
          <Check className="h-5 w-5" />
        </span>
        <p className="text-xs font-medium">All conflicts resolved</p>
        <p className="max-w-full truncate text-[10px] text-muted-foreground">{filePath}</p>
        <button
          onClick={onResolved}
          className="mt-2 rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <pre
            key={index}
            className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground"
          >
            {segment.content}
          </pre>
        ) : (
          <div key={index} className="rounded border border-red-500/30 bg-red-500/5 overflow-hidden">
            <div className="flex items-center justify-between px-2 py-1 border-b border-red-500/20 bg-red-500/10">
              <span className="text-[10px] font-medium text-red-400">Merge conflict</span>
              <span className="text-[10px] text-muted-foreground">
                Accept current / incoming / both
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-border">
              <div className="bg-background/60">
                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
                  Current changes
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed p-2 text-foreground max-h-48 overflow-auto">
                  {segment.current || <span className="text-muted-foreground italic">(empty)</span>}
                </pre>
              </div>
              <div className="bg-background/60">
                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
                  Incoming changes
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed p-2 text-foreground max-h-48 overflow-auto">
                  {segment.incoming || <span className="text-muted-foreground italic">(empty)</span>}
                </pre>
              </div>
            </div>
            <div className="flex items-center gap-1 px-2 py-1.5 border-t border-red-500/20 bg-red-500/10">
              <span className="mr-1 text-[10px] font-medium text-muted-foreground">Resolve</span>
              {RESOLUTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => void handleResolve(index, value)}
                  className="rounded bg-background px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent transition-colors"
                >
                  {label}
                </button>
              ))}
              {onClose && (
                <button
                  onClick={onClose}
                  className="ml-auto p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  title="Close conflict resolver"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  )
}
