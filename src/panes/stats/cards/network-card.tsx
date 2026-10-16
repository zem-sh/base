import { StatsCard } from '../components/ui/stats-card'
import { LineChart, Line } from '../components/charts/line-chart'
import { Grid } from '../components/charts/grid'
import { NetIcon } from '../icons'
import { formatSpeed } from '../utils'
import type { NetworkStats, NetHistoryPoint } from '../types'

interface NetworkCardProps {
  network: NetworkStats
  history: NetHistoryPoint[]
}

export function NetworkCard({ network, history }: NetworkCardProps) {
  return (
    <StatsCard
      title="Network"
      icon={<NetIcon />}
      badges={[
        { text: `↑ ${formatSpeed(network.bytes_sent)}`, color: '#60a5fa' },
        { text: `↓ ${formatSpeed(network.bytes_recv)}`, color: '#34d399' }
      ]}
    >
      <LineChart
        data={history.map(d => ({ date: new Date(d.time * 1000), sent: d.sent, recv: d.recv }))}
        xDataKey="date"
        style={{ height: 120 }}
      >
        <Grid horizontal />
        <Line dataKey="sent" stroke="#60a5fa" />
        <Line dataKey="recv" stroke="#34d399" />
      </LineChart>
    </StatsCard>
  )
}
