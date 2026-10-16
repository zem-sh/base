import { StatsCard } from '../components/ui/stats-card'
import { BarChart, Bar } from '../components/charts/bar-chart'
import { CpuIcon } from '../icons'
import type { CpuStats, LoadStats } from '../types'

interface CpuCardProps {
  cpu: CpuStats
  load?: LoadStats
}

export function CpuCard({ cpu, load }: CpuCardProps) {
  return (
    <StatsCard
      title="CPU"
      icon={<CpuIcon />}
      badges={[
        { text: cpu.temp != null ? `${cpu.temp.toFixed(1)}°C` : '', color: '#fdba74' }
      ]}
      number={cpu.usage != null ? Math.round(cpu.usage) : 0}
      footer={[`${load?.one.toFixed(2)} / ${cpu.cores} Cores`]}
    >
      {cpu.per_core && cpu.per_core.length > 0 && (
        <BarChart
          data={cpu.per_core.map((usage, i) => ({ core: `C${i}`, usage }))}
          xDataKey="core"
          height={80}
        >
          <Bar dataKey="usage" fill="#3b82f6" radius={2} />
        </BarChart>
      )}
    </StatsCard>
  )
}
