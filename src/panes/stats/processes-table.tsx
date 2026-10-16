import { useState, useRef, useEffect } from 'react'
import { formatBytes } from './utils'
import type { ProcessInfo } from './types'

interface ProcessesTableProps {
  processes: ProcessInfo[]
  onKill?: (pid: number, force: boolean) => Promise<boolean>
  onDetails?: (pid: number) => void
}

export function ProcessesTable({ processes, onKill, onDetails }: ProcessesTableProps) {
  const [sort, setSort] = useState<'pid' | 'cpu' | 'memory' | 'name'>('cpu')
  const ref = useRef<HTMLDivElement>(null)
  const [atTop, setAtTop] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  const [killing, setKilling] = useState<number | null>(null)
  const [treeMode, setTreeMode] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      setAtTop(el.scrollTop <= 2)
      setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    if (openMenu === null) return
    const close = () => setOpenMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenu])

  const handleKill = async (pid: number, force: boolean) => {
    if (!onKill) return
    setKilling(pid)
    setOpenMenu(null)
    try {
      await onKill(pid, force)
    } finally {
      setKilling(null)
    }
  }

  if (!Array.isArray(processes) || processes.length === 0) return null

  const sorted = [...processes].sort((a, b) => {
    if (sort === 'pid') return a.pid - b.pid
    if (sort === 'cpu') return (b.cpu_usage ?? 0) - (a.cpu_usage ?? 0)
    if (sort === 'memory') return b.memory_kb - a.memory_kb
    return a.name.localeCompare(b.name)
  })

  const rows: (ProcessInfo & { depth?: number })[] = treeMode ? buildProcessTree(sorted) : sorted.slice(0, 50)

  const topFade = atTop ? "black 0%" : "transparent 0%"
  const topEnd = atTop ? "black 0px" : "black 40px"
  const botStart = atBottom ? "black calc(100% - 0px)" : "black calc(100% - 32px)"
  const botFade = atBottom ? "black 100%" : "transparent 100%"
  const mask = `linear-gradient(to bottom, ${topFade}, ${topEnd}, ${botStart}, ${botFade})`

  const thClass = "h-8 sm:h-10 p-2 sm:p-4 text-left font-medium cursor-pointer select-none whitespace-nowrap"

  return (
    <div
      ref={ref}
      className="rounded-md overflow-y-auto scrollbar-thin flex-1 min-h-0"
      style={{ backgroundColor: "var(--card)", maskImage: mask, WebkitMaskImage: mask }}
    >
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted rounded-t-md">
          <tr>
            <th
              className={thClass}
              onClick={() => setSort('pid')}
            >
              PID {sort === 'pid' && '↑'}
            </th>
            <th
              className={thClass}
              onClick={() => setSort('name')}
            >
              Name {sort === 'name' && '↑'}
            </th>
            <th
              className={`${thClass} text-right`}
              onClick={() => setSort('cpu')}
            >
              CPU {sort === 'cpu' && '↑'}
            </th>
            <th
              className={`${thClass} text-right`}
              onClick={() => setSort('memory')}
            >
              Mem {sort === 'memory' && '↑'}
            </th>
            <th className="h-8 sm:h-10 p-2 sm:p-4 w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((proc) => (
            <tr key={proc.pid} className="border-none hover:bg-muted/50">
              <td className="p-2 sm:p-4 tabular-nums text-muted-foreground">
                {proc.pid}
              </td>
              <td className="p-2 sm:p-4 font-medium truncate max-w-[100px] sm:max-w-[200px]" title={proc.exe}>
                <span className="flex items-center gap-2" style={{ paddingLeft: treeMode ? `${(proc.depth ?? 0) * 14}px` : undefined }}>
                  {(proc.depth ?? 0) > 0 && (
                    <span className="text-muted-foreground/60 shrink-0 select-none">
                      {'└'}
                    </span>
                  )}
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    proc.status === 'Run' ? 'bg-green-400' :
                    proc.status === 'Sleep' ? 'bg-yellow-400' :
                    'bg-muted-foreground'
                  }`} />
                  {killing === proc.pid ? (
                    <span className="text-destructive italic">Killing...</span>
                  ) : (
                    proc.name
                  )}
                </span>
              </td>
              <td className="p-2 sm:p-4 text-right tabular-nums">
                {(proc.cpu_usage ?? 0).toFixed(1)}%
              </td>
              <td className="p-2 sm:p-4 text-right tabular-nums">
                {formatBytes(proc.memory_kb * 1024)}
              </td>
              <td className="p-2 sm:p-4 text-right relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenMenu(openMenu === proc.pid ? null : proc.pid)
                  }}
                  className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="12" cy="19" r="2" />
                  </svg>
                </button>
                {openMenu === proc.pid && (
                  <div className="absolute right-0 top-full mt-1 z-10 bg-popover border border-border rounded-md shadow-md py-1 min-w-[120px]">
                    {onDetails && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDetails(proc.pid)
                          setOpenMenu(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                      >
                        Details
                      </button>
                    )}
                    {treeMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setTreeMode(false)
                          setOpenMenu(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-muted transition-colors"
                      >
                        List View
                      </button>
                    )}
                    {!treeMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setTreeMode(true)
                          setOpenMenu(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                      >
                        Tree
                      </button>
                    )}
                    {onKill && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleKill(proc.pid, false)
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-destructive hover:bg-muted transition-colors"
                      >
                        Kill
                      </button>
                    )}
                    {onKill && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleKill(proc.pid, true)
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-destructive font-medium hover:bg-muted transition-colors"
                      >
                        Force Kill
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ProcessDetailsModal({ pid, details, onClose }: { pid: number; details: any; onClose: () => void }) {
  if (!details) return null
  const d = details
  const runTimeHrs = d.run_time_secs ? Math.floor(d.run_time_secs / 3600) : 0
  const runTimeMins = d.run_time_secs ? Math.floor((d.run_time_secs % 3600) / 60) : 0
  const runTimeSec = d.run_time_secs ? d.run_time_secs % 60 : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-sm">Process Details — PID {pid}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-3 text-xs">
          <DetailRow label="Name" value={d.name ?? '-'} />
          <DetailRow label="Executable" value={d.exe ?? '-'} />
          <DetailRow label="Status" value={d.status ?? '-'} />
          <DetailRow label="CPU Usage" value={d.cpu_usage != null ? `${d.cpu_usage.toFixed(1)}%` : '-'} />
          <DetailRow label="Memory" value={d.memory_kb != null ? formatBytes(d.memory_kb * 1024) : '-'} />
          <DetailRow label="Virtual Memory" value={d.virtual_memory_kb != null ? formatBytes(d.virtual_memory_kb * 1024) : '-'} />
          <DetailRow label="User ID" value={d.uid || '-'} />
          {d.start_time && <DetailRow label="Start Time" value={new Date(d.start_time * 1000).toLocaleString()} />}
          <DetailRow label="Run Time" value={`${runTimeHrs}h ${runTimeMins}m ${runTimeSec}s`} />
          {d.disk_read_kb != null && <DetailRow label="Disk Read" value={formatBytes(d.disk_read_kb * 1024)} />}
          {d.disk_written_kb != null && <DetailRow label="Disk Written" value={formatBytes(d.disk_written_kb * 1024)} />}
          {d.cwd && <DetailRow label="Working Dir" value={d.cwd} />}
          {d.cmd && Array.isArray(d.cmd) && d.cmd.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">Command Line</div>
              <pre className="bg-muted rounded-md p-2 overflow-x-auto text-[10px] whitespace-pre-wrap break-all">{d.cmd.join(' ')}</pre>
            </div>
          )}
          {d.environ && Array.isArray(d.environ) && d.environ.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">Environment ({d.environ.length} vars)</div>
              <pre className="bg-muted rounded-md p-2 overflow-x-auto text-[10px] max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                {d.environ.map(([k, v]: [string, string]) => `${k}=${v}`).join('\n')}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface ProcessNode extends ProcessInfo {
  children: ProcessNode[]
  depth: number
}

function buildProcessTree(procs: ProcessInfo[]): ProcessNode[] {
  const byPid = new Map<number, ProcessNode>()
  procs.forEach((p) => byPid.set(p.pid, { ...p, children: [], depth: 0 }))
  const roots: ProcessNode[] = []
  byPid.forEach((node) => {
    const parentId = node.parent ?? 0
    if (parentId !== node.pid && byPid.has(parentId)) {
      byPid.get(parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  })
  const flatten = (nodes: ProcessNode[], depth: number): ProcessNode[] => {
    const out: ProcessNode[] = []
    nodes.forEach((n) => {
      n.depth = depth
      out.push(n, ...flatten(n.children, depth + 1))
    })
    return out
  }
  return flatten(roots, 0)
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-mono truncate" title={value}>{value}</span>
    </div>
  )
}