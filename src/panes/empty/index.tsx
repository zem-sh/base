import { useState, useEffect } from 'react'
import { type PaneComponentProps } from '@zem-sh/pane'

// Self-inject CSS so styles travel with the pane regardless of how it's loaded
import styles from './styles.css?inline'
if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="general"]')) {
  const s = document.createElement('style'); s.textContent = styles; s.setAttribute('data-pane-css', 'general'); document.head.appendChild(s)
}

// Access the shared paneRegistry via the global bridge
const paneRegistry = (window as any).__zemPaneRegistry

let addonApi: {
  runPaneQuery: (paneKind: string, query: string, params?: string) => Promise<unknown>
} = { runPaneQuery: async () => null }

export function setAddonApi(api: typeof addonApi) {
  addonApi = api
}

export function EmptyPane({ paneId }: PaneComponentProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    addonApi.runPaneQuery('general', 'is_ok').then((result) => {
      if (cancelled) return
      const r = result as { status?: string; success?: boolean } | null
      if (r?.status === 'ok' || r?.success === true) {
        setStatus('ready')
      } else {
        setError(`is_ok returned unexpected result: ${JSON.stringify(result)}`)
        setStatus('error')
      }
    }).catch((e) => {
      if (cancelled) return
      setError(String(e))
      setStatus('error')
    })
    return () => { cancelled = true }
  }, [paneId])

  if (status === 'loading') {
    return (
      <div className="w-full h-full flex items-center justify-center text-primary rounded-lg text-sm">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="w-full h-full flex items-center justify-center text-primary rounded-lg text-sm">
        <div className="flex flex-col items-center gap-2 text-destructive">
          <span>Error</span>
          <span className="text-xs text-muted-foreground">{error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center text-primary rounded-lg text-sm font-medium">
      <div className="flex flex-col items-center gap-2">
        <span>Empty Pane</span>
        <span className="text-xs text-muted-foreground/50">#{paneId}</span>
      </div>
    </div>
  )
}

export function register(): void {
  paneRegistry.register({
    kind: 'general',
    title: 'Empty',
    description: 'Blank placeholder pane',
    icon: ({ className }: { className?: string }) => (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    ),
    component: EmptyPane,
    contextMenuActions: (paneId: number) => [
      {
        label: 'Clear',
        action: () => {
          window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'clear' } }))
        }
      },
    ],
    registerBindings() {
      return [
        {
          id: 'new-empty',
          keys: [{ key: 'm', meta: true }],
          description: 'New Empty pane',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'general' } }))
          },
        },
      ]
    },
  })
}

export function unregister(): void {
  paneRegistry.unregister('general')
}

// Backward compatibility alias
export const registerEmptyPane = register
