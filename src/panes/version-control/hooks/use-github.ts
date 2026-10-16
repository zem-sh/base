import { useCallback, useRef } from 'react'
import { useStore } from '../store'
import type {
  GithubStatus,
  GithubPullRequest,
  GithubIssue,
  GithubSegment,
} from '../types'
import { getAddonApi } from './addon-api'

export function useGitHub() {
  const {
    setGithubStatus,
    setGithubLoading,
    setGithubError,
    setGithubPulls,
    setGithubIssues,
    setGithubSegment,
  } = useStore()

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
      console.error(`GitHub query ${method} failed:`, err)
      throw err
    }
  }, [])

  const callPaneMutation = useCallback(async (method: string, payload?: any) => {
    try {
      const params = JSON.stringify(payload || {})
      const result = await getAddonApi().runPaneMutation('version-control', method, params, paneIdRef.current ?? undefined)
      return result
    } catch (err) {
      console.error(`GitHub mutation ${method} failed:`, err)
      throw err
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    setGithubLoading(true)
    setGithubError(null)
    try {
      const result = await callPaneQuery('github_status')
      const status = result as GithubStatus
      setGithubStatus(status)
      if (status.configured) {
        await fetchPulls('open')
        await fetchIssues('open')
      }
      return status
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setGithubError(msg)
      return null
    } finally {
      setGithubLoading(false)
    }
  }, [callPaneQuery, setGithubStatus, setGithubLoading, setGithubError])

  const fetchPulls = useCallback(async (state: string = 'open') => {
    try {
      const result = await callPaneQuery('github_pulls', { state })
      setGithubPulls(result as GithubPullRequest[])
      return result as GithubPullRequest[]
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return []
    }
  }, [callPaneQuery, setGithubPulls, setGithubError])

  const fetchIssues = useCallback(async (state: string = 'open') => {
    try {
      const result = await callPaneQuery('github_issues', { state })
      setGithubIssues(result as GithubIssue[])
      return result as GithubIssue[]
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return []
    }
  }, [callPaneQuery, setGithubIssues, setGithubError])

  const setToken = useCallback(async (token: string) => {
    try {
      await callPaneMutation('github_set_token', { token })
      await fetchStatus()
      return true
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchStatus, setGithubError])

  const clearToken = useCallback(async () => {
    try {
      await callPaneMutation('github_clear_token', {})
      setGithubStatus({ owner: '', repo: '', configured: false })
      setGithubPulls([])
      setGithubIssues([])
      return true
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, setGithubStatus, setGithubPulls, setGithubIssues, setGithubError])

  const createPr = useCallback(async (title: string, body?: string, base?: string) => {
    try {
      const result = await callPaneMutation('github_create_pr', { title, body, base })
      await fetchPulls('open')
      return result as GithubPullRequest
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [callPaneMutation, fetchPulls, setGithubError])

  const checkoutPr = useCallback(async (number: number) => {
    try {
      await callPaneMutation('github_checkout_pr', { number })
      return true
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, setGithubError])

  const updatePr = useCallback(async (number: number, state: string) => {
    try {
      await callPaneMutation('github_update_pr', { number, state })
      await fetchPulls('open')
      return true
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchPulls, setGithubError])

  const mergePr = useCallback(async (number: number, method?: string) => {
    try {
      await callPaneMutation('github_merge_pr', { number, method })
      await fetchPulls('open')
      return true
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [callPaneMutation, fetchPulls, setGithubError])

  const setSegment = useCallback((segment: GithubSegment) => {
    setGithubSegment(segment)
  }, [setGithubSegment])

  return {
    fetchStatus,
    fetchPulls,
    fetchIssues,
    setToken,
    clearToken,
    createPr,
    checkoutPr,
    updatePr,
    mergePr,
    setSegment,
    setPaneId,
  }
}
