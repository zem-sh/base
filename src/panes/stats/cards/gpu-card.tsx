import { StatsCard } from '../components/ui/stats-card'
import { LiveLineChart, type LiveLinePoint } from '../components/charts/live-line-chart'
import { LiveLine } from '../components/charts/live-line'
import { GpuIcon } from '../icons'
import type { GpuStats } from '../types'

interface GpuCardProps {
  gpu: GpuStats
  history: LiveLinePoint[]
}

export function GpuCard({ gpu, history }: GpuCardProps) {
  return (
    <StatsCard
      title="GPU"
      icon={<GpuIcon />}
      number={gpu.utilization ?? 0}
      badges={[
        { text: gpu.vram && gpu.vram !== 'Unknown' ? gpu.vram : '', color: '#c084fc' },
        { text: gpu.temperature != null ? `${gpu.temperature.toFixed(1)}°C` : '', color: '#fdba74' }
      ]}
      footer={[gpu.model]}
    >
      <LiveLineChart
        data={history}
        value={gpu.utilization ?? 0}
        dataKey="gpu"
        window={30}
        exaggerate
        style={{ height: 100 }}
      >
        <LiveLine badge={false} dataKey="gpu" stroke="#a855f7" strokeWidth={1.5} />
      </LiveLineChart>
    </StatsCard>
  )
}
