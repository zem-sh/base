export interface CpuStats {
  usage: number
  cores: number
  per_core: number[]
  temp?: number
}

export interface MemoryStats {
  total: number
  used: number
  free: number
  usage: number
}

export interface DiskStats {
  total: number
  used: number
  free: number
  usage: number
  mount: string
}

export interface NetworkStats {
  bytes_sent: number
  bytes_recv: number
}

export interface LoadStats {
  one: number
  five: number
  fifteen: number
}

export interface GpuStats {
  model: string
  vram: string
  utilization?: number
  temperature?: number
}

export interface BatteryStats {
  has_battery: boolean
  percent?: number
  state?: string
  vendor?: string
  model?: string
  time_to_full?: number
  time_to_empty?: number
  cycle_count?: number
  temperature?: number
}

export interface ProcessInfo {
  pid: number
  name: string
  cpu_usage: number
  memory_kb: number
  status: string
  exe: string
  icon?: string
  parent?: number
}

export interface SystemStats {
  cpu?: CpuStats
  memory?: MemoryStats
  disk?: DiskStats
  network?: NetworkStats
  uptime?: number
  load?: LoadStats
  gpu?: GpuStats
  battery?: BatteryStats
}

export interface LiveLinePoint {
  time: number
  value: number
}

export interface NetHistoryPoint {
  time: number
  sent: number
  recv: number
}
