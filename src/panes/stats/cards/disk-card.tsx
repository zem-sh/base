import { StatsCard } from '../components/ui/stats-card'
import { DiskIcon } from '../icons'
import { formatBytes, UsageBar } from '../utils'
import type { DiskStats } from '../types'

interface DiskCardProps {
  disk: DiskStats
}

export function DiskCard({ disk }: DiskCardProps) {
  return (
    <StatsCard
      title={`Disk ${disk.mount}`}
      icon={<DiskIcon />}
      number={disk.total > 0 ? (disk.used / disk.total) * 100 : 0}
      badges={[
        { text: formatBytes(disk.used), color: '#fbbf24' },
        { text: `/ ${formatBytes(disk.total)}` }
      ]}
      footer={[`Free: ${formatBytes(disk.free)}`]}
    >
      <UsageBar
        value={disk.used}
        max={disk.total}
        gradient="linear-gradient(90deg, #f59e0b, #f97316)"
      />
    </StatsCard>
  )
}
