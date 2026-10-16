import { useState, useEffect, useCallback, useRef } from 'react'
import type { SystemStats, LiveLinePoint, NetHistoryPoint, ProcessInfo } from '../types'

const HISTORY_LENGTH = 60

export function useStatsData(addonApi: { runPaneQuery: (paneKind: string, query: string, params?: string) => Promise<unknown>; runPaneMutation: (paneKind: string, mutation: string, params?: string) => Promise<unknown> }) {
  const [stats, setStats] = useState<SystemStats>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cpuHistory, setCpuHistory] = useState<LiveLinePoint[]>([])
  const [gpuHistory, setGpuHistory] = useState<LiveLinePoint[]>([])
  const [memHistory, setMemHistory] = useState<LiveLinePoint[]>([])
  const [netHistory, setNetHistory] = useState<NetHistoryPoint[]>([])
  const [processes, setProcesses] = useState<ProcessInfo[]>([])

  const cpuHistoryRef = useRef<LiveLinePoint[]>([])
  const gpuHistoryRef = useRef<LiveLinePoint[]>([])
  const memHistoryRef = useRef<LiveLinePoint[]>([])
  const netHistoryRef = useRef<NetHistoryPoint[]>([])
  const mountedRef = useRef(true)

  const pushToHistory = useCallback(<T,>(ref: React.MutableRefObject<T[]>, set: (v: T[]) => void, item: T) => {
    ref.current.push(item)
    if (ref.current.length > HISTORY_LENGTH) ref.current.shift()
    set([...ref.current])
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const result = await addonApi.runPaneQuery('stats', 'get_stats')
      if (!mountedRef.current) return
      if (!result) return

      const raw = (result as any).data ?? result
      const r = raw as SystemStats
      const newStats: SystemStats = {}
      const now = Date.now() / 1000

      if (r.cpu) {
        newStats.cpu = r.cpu
        pushToHistory(cpuHistoryRef, setCpuHistory, { time: now, value: r.cpu.usage })
      }

      if (r.memory) {
        newStats.memory = r.memory
        pushToHistory(memHistoryRef, setMemHistory, { time: now, value: r.memory.usage })
      }

      if (r.disk) newStats.disk = r.disk

      if (r.network) {
        newStats.network = r.network
        pushToHistory(netHistoryRef, setNetHistory, { time: now, sent: r.network.bytes_sent, recv: r.network.bytes_recv })
      }

      if (r.uptime) newStats.uptime = r.uptime
      if (r.load) newStats.load = r.load

      if (r.gpu) {
        newStats.gpu = r.gpu
        pushToHistory(gpuHistoryRef, setGpuHistory, { time: now, value: r.gpu.utilization ?? 0 })
      }

      if (r.battery) newStats.battery = r.battery

      setStats(newStats)
      setLoading(false)
      setError(null)
    } catch (e) {
      if (!mountedRef.current) return
      setError(String(e))
      setLoading(false)
    }
  }, [addonApi, pushToHistory])

  const fetchProcesses = useCallback(async () => {
    try {
      const result = await addonApi.runPaneQuery('stats', 'get_processes')
      if (!mountedRef.current) return
      if (result) {
        const raw = (result as any).data ?? result
        const r = Array.isArray(raw) ? raw as ProcessInfo[] : []
        setProcesses(r)
      }
    } catch (e) {
      console.error('Failed to fetch processes:', e)
    }
  }, [addonApi])

  const killProcess = useCallback(async (pid: number, force: boolean = false): Promise<boolean> => {
    try {
      const command = force ? 'force_kill_process' : 'kill_process'
      const result = await addonApi.runPaneMutation('stats', command, JSON.stringify({ pid }))
      const data = (result as any)?.data ?? result
      const killed = (data as any)?.killed ?? data?.success ?? false
      return killed
    } catch (e) {
      console.error('Failed to kill process:', e)
      return false
    }
  }, [addonApi])

  const getProcessDetails = useCallback(async (pid: number): Promise<any> => {
    try {
      const result = await addonApi.runPaneQuery('stats', 'process_details', JSON.stringify({ pid }))
      const data = (result as any)?.data ?? result
      return data
    } catch (e) {
      console.error('Failed to get process details:', e)
      return null
    }
  }, [addonApi])

  useEffect(() => {
    mountedRef.current = true
    fetchStats()
    fetchProcesses()

    const statsInterval = setInterval(fetchStats, 5000)
    const processInterval = setInterval(fetchProcesses, 10000)

    return () => {
      mountedRef.current = false
      clearInterval(statsInterval)
      clearInterval(processInterval)
    }
  }, [fetchStats, fetchProcesses])

  return {
    stats,
    cpuHistory,
    gpuHistory,
    memHistory,
    netHistory,
    processes,
    loading,
    error,
    refetch: fetchStats,
    killProcess,
    getProcessDetails,
  }
}
