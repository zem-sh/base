import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import type { GitStatus, BranchInfo, StashInfo, FileContentsResult, ConflictFileResult } from '../types'
import { getAddonApi } from './addon-api'

// Re-export for the app to inject the API
export { setAddonApi } from './addon-api'

export function useGit() {
  const {
    setStatus,
    setLoading,
    setError,
    setBranches,
    setStashes,
  } = useStore()

  const pollingInterval = useRef<number | null>(null)

  // Store the pane ID to use for addon commands
  const paneIdRef = useRef<number | null>(null)

  const setPaneId = useCallback((id: number) => {
    paneIdRef.current = id
  }, [])

  const callPaneQuery = useCallback(async (method: string, payload?: any) => {
    try {
      const params = JSON.stringify(payload || {})
      const result = await getAddonApi().runPaneQuery('version-control', method, params, paneIdRef.current ?? undefined)
      return result
    } catch (err) {
      console.error(`Git query ${method} failed:`, err)
      throw err
    }
  }, [])

  const callPaneMutation = useCallback(async (method: string, payload?: any) => {
    try {
      const params = JSON.stringify(payload || {})
      const result = await getAddonApi().runPaneMutation('version-control', method, params, paneIdRef.current ?? undefined)
      return result
    } catch (err) {
      console.error(`Git mutation ${method} failed:`, err)
      throw err
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await callPaneQuery('get_status')
      setStatus(result as GitStatus)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [callPaneQuery, setStatus, setLoading, setError])

  const fetchBranches = useCallback(async () => {
    try {
      const result = await callPaneQuery('list_branches')
      setBranches(Array.isArray(result) ? result as BranchInfo[] : [])
      return result
    } catch (err) {
      console.error('Failed to fetch branches:', err)
      return []
    }
  }, [callPaneQuery, setBranches])

  const fetchStashes = useCallback(async () => {
    try {
      const result = await callPaneQuery('get_stashes')
      setStashes(Array.isArray(result) ? result as StashInfo[] : [])
      return result
    } catch (err) {
      console.error('Failed to fetch stashes:', err)
      return []
    }
  }, [callPaneQuery, setStashes])

  const stageFile = useCallback(async (filePath: string) => {
    try {
      await callPaneMutation('stage_file', { file: filePath })
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const unstageFile = useCallback(async (filePath: string) => {
    try {
      await callPaneMutation('unstage_file', { file: filePath })
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const stageAll = useCallback(async () => {
    try {
      await callPaneMutation('stage_all', {})
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const unstageAll = useCallback(async () => {
    try {
      await callPaneMutation('unstage_all', {})
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const discardFile = useCallback(async (filePath: string) => {
    try {
      await callPaneMutation('discard_file', { file: filePath })
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const commit = useCallback(async (message: string) => {
    try {
      await callPaneMutation('commit', { message })
      await fetchStatus()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStatus, setError])

  const fetchDiff = useCallback(async (filePath: string, staged = false) => {
    try {
      const result = await callPaneQuery('get_diff', { file: filePath, staged })
      return result
    } catch (err) {
      console.error('Failed to fetch diff:', err)
      return null
    }
  }, [callPaneQuery])

  const getFileContents = useCallback(async (filePath: string, staged = false): Promise<FileContentsResult> => {
    try {
      const result = await callPaneQuery('get_file_contents', { file: filePath, staged })
      return result as FileContentsResult
    } catch (err) {
      console.error('Failed to fetch file contents:', err)
      return { old: null, new: null }
    }
  }, [callPaneQuery])

  const fetchConflictFile = useCallback(async (filePath: string): Promise<ConflictFileResult | null> => {
    try {
      const result = await callPaneQuery('get_conflict_file', { file: filePath })
      return result as ConflictFileResult
    } catch (err) {
      console.error('Failed to fetch conflict file:', err)
      return null
    }
  }, [callPaneQuery])

  const resolveConflictFile = useCallback(async (filePath: string, content: string) => {
    try {
      await callPaneMutation('resolve_conflict', { file: filePath, content })
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callPaneMutation, fetchStatus, setError])

  const createBranch = useCallback(async (branchName: string, startPoint?: string) => {
    try {
      await callPaneMutation('create_branch', { name: branchName, from: startPoint })
      await fetchBranches()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchBranches, setError])

  const checkoutBranch = useCallback(async (branchName: string) => {
    try {
      await callPaneMutation('checkout_branch', { branch: branchName })
      await fetchStatus()
      await fetchBranches()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStatus, fetchBranches, setError])

  const deleteBranch = useCallback(async (branchName: string) => {
    try {
      await callPaneMutation('delete_branch', { branch: branchName })
      await fetchBranches()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchBranches, setError])

  const push = useCallback(async (sshPassphrase?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await callPaneMutation('push', sshPassphrase ? { ssh_passphrase: sshPassphrase } : {})
      await fetchStatus()
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return { success: false, error: msg }
    }
  }, [callPaneMutation, fetchStatus, setError])

  const pull = useCallback(async (sshPassphrase?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await callPaneMutation('pull', sshPassphrase ? { ssh_passphrase: sshPassphrase } : {})
      await fetchStatus()
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return { success: false, error: msg }
    }
  }, [callPaneMutation, fetchStatus, setError])

  const fetch = useCallback(async (sshPassphrase?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await callPaneMutation('fetch', sshPassphrase ? { ssh_passphrase: sshPassphrase } : {})
      await fetchStatus()
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return { success: false, error: msg }
    }
  }, [callPaneMutation, fetchStatus, setError])

  const createStash = useCallback(async (message?: string) => {
    try {
      await callPaneMutation('create_stash', { message })
      await fetchStatus()
      await fetchStashes()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStatus, fetchStashes, setError])

  const popStash = useCallback(async (index: number) => {
    try {
      await callPaneMutation('pop_stash', { index })
      await fetchStatus()
      await fetchStashes()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStatus, fetchStashes, setError])

  const dropStash = useCallback(async (index: number) => {
    try {
      await callPaneMutation('drop_stash', { index })
      await fetchStashes()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStashes, setError])

  // Auto-refresh on interval
  const startPolling = useCallback((intervalMs: number = 3000) => {
    if (pollingInterval.current) {
      clearInterval(pollingInterval.current)
    }
    pollingInterval.current = setInterval(() => {
      fetchStatus()
    }, intervalMs) as unknown as number
  }, [fetchStatus])

  const stopPolling = useCallback(() => {
    if (pollingInterval.current) {
      clearInterval(pollingInterval.current)
      pollingInterval.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  return {
    fetchStatus,
    fetchBranches,
    fetchStashes,
    fetchDiff,
    getFileContents,
    fetchConflictFile,
    resolveConflictFile,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardFile,
    commit,
    createBranch,
    checkoutBranch,
    deleteBranch,
    push,
    pull,
    fetch,
    createStash,
    popStash,
    dropStash,
    startPolling,
    stopPolling,
    setPaneId,
  }
}