import { useRef, useState, useEffect, useCallback } from 'react'
import { type PaneComponentProps } from '@zem-sh/pane'

// Access the shared paneRegistry via the global bridge
const paneRegistry = (window as any).__zemPaneRegistry
import { StatsIcon } from './icons'
import { CpuCard, MemoryCard, GpuCard, DiskCard, NetworkCard, BatteryCard } from './cards'
import { ProcessesTable, ProcessDetailsModal } from './processes-table'
import { useStatsData } from './hooks/use-stats-data'
import type { ProcessInfo } from './types'
import { StatsCardSkeleton, ProcessTableSkeleton } from './components/ui/stats-card-skeleton'

// Self-inject CSS so styles travel with the pane regardless of how it's loaded
import styles from './styles.css?inline'
if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="stats"]')) {
  const s = document.createElement('style'); s.textContent = styles; s.setAttribute('data-pane-css', 'stats'); document.head.appendChild(s)
}

let addonApi: {
  runPaneQuery: (paneKind: string, query: string, params?: string) => Promise<unknown>
  runPaneMutation: (paneKind: string, mutation: string, params?: string) => Promise<unknown>
} = { runPaneQuery: async () => null, runPaneMutation: async () => null }

export function setAddonApi(api: typeof addonApi) {
  addonApi = api
}

const CARD_MIN_WIDTH = 280
const GAP = 8
const MAX_COLUMNS = 3

function useGridColumns(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [columns, setColumns] = useState(1)

  const recalc = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const w = el.clientWidth
    const cols = Math.min(MAX_COLUMNS, Math.max(1, Math.floor((w + GAP) / (CARD_MIN_WIDTH + GAP))))
    setColumns(cols)
  }, [containerRef])

  useEffect(() => {
    recalc()
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(recalc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [recalc])

  return columns
}

function StatsSkeleton() {
  const containerRef = useRef<HTMLDivElement>(null)
  const columns = useGridColumns(containerRef)

  return (
    <div className="stats-pane-root w-full h-dvh flex flex-col gap-2 p-2 overflow-y-auto text-[11px] font-mono text-foreground scrollbar-thin">
      <div ref={containerRef} className="grid gap-2" style={{
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridAutoRows: 'minmax(200px, auto)',
        gap: `${GAP}px`,
      }}>
        <StatsCardSkeleton />
        <StatsCardSkeleton />
        <StatsCardSkeleton />
        <StatsCardSkeleton />
        <StatsCardSkeleton />
        <StatsCardSkeleton />
      </div>
      <div className="flex-1 min-h-0">
        <ProcessTableSkeleton />
      </div>
    </div>
  )
}

export function StatsPane({ paneId }: PaneComponentProps) {
  const {
    stats,
    cpuHistory,
    gpuHistory,
    memHistory,
    netHistory,
    processes,
    loading,
    error,
    killProcess,
    getProcessDetails,
  } = useStatsData(addonApi)

  const [detailsPid, setDetailsPid] = useState<number | null>(null)
  const [detailsData, setDetailsData] = useState<any>(null)

  const handleDetails = async (pid: number) => {
    setDetailsPid(pid)
    setDetailsData(null)
    const data = await getProcessDetails(pid)
    setDetailsData(data)
  }

  if (loading) {
    return <StatsSkeleton />
  }

  if (error) {
    return (
      <div className="stats-pane-root w-full h-dvh flex items-center justify-center gap-2 text-destructive text-sm font-mono">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span>{error}</span>
      </div>
    )
  }

  const visibleCards = [
    stats.cpu && cpuHistory.length > 0 && <CpuCard key="cpu" cpu={stats.cpu} load={stats.load} />,
    stats.memory && memHistory.length > 0 && <MemoryCard key="mem" memory={stats.memory} history={memHistory} />,
    stats.gpu && gpuHistory.length > 0 && <GpuCard key="gpu" gpu={stats.gpu} history={gpuHistory} />,
    stats.disk && <DiskCard key="disk" disk={stats.disk} />,
    stats.network && netHistory.length > 0 && <NetworkCard key="net" network={stats.network} history={netHistory} />,
    stats.battery && stats.battery.has_battery && <BatteryCard key="bat" battery={stats.battery} uptime={stats.uptime} />,
  ].filter(Boolean)

  return (
    <>
      <StatsPaneInner
        cards={visibleCards}
        processes={processes}
        onKill={killProcess}
        onDetails={handleDetails}
      />
      {detailsPid && (
        <ProcessDetailsModal
          pid={detailsPid}
          details={detailsData}
          onClose={() => setDetailsPid(null)}
        />
      )}
    </>
  )
}

function StatsPaneInner({
  cards,
  processes,
  onKill,
  onDetails,
}: {
  cards: React.ReactNode[]
  processes: ProcessInfo[]
  onKill: (pid: number, force: boolean) => Promise<boolean>
  onDetails: (pid: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const columns = useGridColumns(containerRef)

  return (
    <div className="stats-pane-root w-full h-dvh flex flex-col gap-2 p-2 overflow-y-auto text-[11px] font-mono text-foreground scrollbar-thin">
      <div ref={containerRef} className="grid gap-2" style={{
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridAutoRows: 'minmax(200px, auto)',
        gap: `${GAP}px`,
      }}>
        {cards}
      </div>

      <div className="flex-1 min-h-0">
        <ProcessesTable
          processes={processes}
          onKill={onKill}
          onDetails={onDetails}
        />
      </div>
    </div>
  )
}

export function register(): void {
  paneRegistry.register({
    kind: 'stats',
    title: 'Stats',
    description: 'Live system and process statistics',
    icon: StatsIcon,
    component: StatsPane,
    contextMenuActions: (paneId: number) => [
      {
        label: 'Refresh',
        action: () => {
          window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'refresh' } }))
        }
      },
    ],
    registerBindings() {
      return [
        {
          id: 'new-stats',
          keys: [{ key: 's', meta: true, shift: true }],
          description: 'New Stats pane',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'stats' } }))
          },
        },
      ]
    },
  })
}

export function unregister(): void {
  paneRegistry.unregister('stats')
}

// Backward compatibility alias
export const registerStatsPane = register
