import { StatsCard } from '../components/ui/stats-card'
import { LiveLineChart, type LiveLinePoint } from '../components/charts/live-line-chart'
import { LiveLine } from '../components/charts/live-line'
import { MemIcon } from '../icons'
import { formatBytes } from '../utils'
import type { MemoryStats } from '../types'

interface MemoryCardProps {
  memory: MemoryStats
  history: LiveLinePoint[]
}

export function MemoryCard({ memory, history }: MemoryCardProps) {
  const memPct = memory.usage ?? 0

  return (
    <StatsCard
      title="Memory"
      icon={<MemIcon />}
      number={memPct}
      badges={[
        { text: formatBytes(memory.used), color: 'rgb(254, 61, 61)' },
        { text: `/ ${formatBytes(memory.total)}` }
      ]}
      footer={[`Free: ${formatBytes(memory.free)}`]}
    >
      <LiveLineChart
        data={history}
        value={memPct}
        dataKey="mem"
        window={30}
        exaggerate
        style={{ height: 100 }}
      >
        <LiveLine badge={false} dataKey="mem" stroke="rgb(254, 61, 61)" strokeWidth={1.5} />
      </LiveLineChart>
    </StatsCard>
  )
}
