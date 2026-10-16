import { StatsCard } from '../components/ui/stats-card'
import { BatteryIcon } from '../icons'
import { formatUptime, UsageBar } from '../utils'
import type { BatteryStats } from '../types'

interface BatteryCardProps {
  battery: BatteryStats
  uptime?: number
}

export function BatteryCard({ battery, uptime }: BatteryCardProps) {
  if (!battery.has_battery) return null

  return (
    <StatsCard
      title="Battery"
      icon={<BatteryIcon />}
      number={battery.percent ?? 0}
      badges={[
        { text: battery.temperature != null ? `${battery.temperature.toFixed(1)}°C` : '' },
        { text: battery.state || 'Unknown', color: '#4ade80' },
        ...(battery.vendor && battery.vendor !== 'Unknown' ? [{ text: battery.vendor }] : [])
      ]}
      footer={[
        battery.cycle_count != null ? `Cycles: ${battery.cycle_count}` : '',
        uptime ? `Uptime: ${formatUptime(uptime)}` : ''
      ].filter(Boolean)}
    >
      <UsageBar
        value={battery.percent ?? 0}
        max={100}
        gradient="linear-gradient(90deg, #22c55e, #4ade80)"
      />
    </StatsCard>
  )
}
