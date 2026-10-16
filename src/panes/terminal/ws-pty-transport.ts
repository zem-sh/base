import type { PtyTransport } from '@zem-sh/terminal'

// ─── Shared server URL state ───────────────────────────────────────────────

let _serverUrl: string = ''

export function setServerUrl(url: string) {
  _serverUrl = url.replace(/^http/, 'ws')
}

export function getServerUrl(): string {
  return _serverUrl
}

// ─── Token provider ─────────────────────────────────────────────────────────

let _tokenProvider: ((kind: string, resourceId?: number) => Promise<string>) | null = null

export function setTokenProvider(provider: (kind: string, resourceId?: number) => Promise<string>) {
  _tokenProvider = provider
}

// ─── Control message types (JSON text frames) ──────────────────────────────

interface PaneControlMessage {
  pane_id: number
  data: number[]
  kind: string
}

interface PaneInput {
  pane_id: number
  data: number[]
  kind: string
}

// ─── Self-contained WsConnection (binary-capable) ──────────────────────────

type WsMessageHandler = (data: string | ArrayBuffer) => void

class WsConnection {
  private ws: WebSocket | null = null
  private path: string

  constructor(path: string) {
    this.path = path
  }

  private getUrl(token: string): string {
    const url = new URL(`${_serverUrl}${this.path}`)
    url.searchParams.set('token', token)
    return url.toString()
  }

  connect(
    token: string,
    onMessage: WsMessageHandler,
    onOpen?: () => void,
    onClose?: () => void,
    onError?: (e: Event) => void,
  ) {
    const url = this.getUrl(token)
    this.ws = new WebSocket(url)
    // Binary frames carry raw terminal output; text frames are JSON control.
    this.ws.binaryType = 'arraybuffer'
    this.ws.onmessage = (e) => onMessage(e.data as string | ArrayBuffer)
    this.ws.onopen = () => onOpen?.()
    this.ws.onclose = () => onClose?.()
    this.ws.onerror = (e) => onError?.(e)
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  close() {
    this.ws?.close()
    this.ws = null
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

// State for WebSocket PTY connection
interface WsPtyState {
  paneId: number | null
  connected: boolean
  ws: WsConnection | null
}

// Track all active transports for cleanup on app close
const activeTransports = new Map<number, WsPtyState>()

// Global cleanup on app close
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const [, state] of activeTransports) {
      if (state.connected && state.ws) {
        state.ws.close()
      }
    }
    activeTransports.clear()
  })
}

// ─── Create PTY transport ──────────────────────────────────────────────────

/**
 * Create a PtyTransport backed by WebSocket bidirectional streaming.
 * Binary WebSocket frames carry raw terminal output (no JSON overhead);
 * text frames carry JSON control messages (exit, error).
 */
export function createGrpcPtyTransport(
  fixedPaneId?: number,
  state: WsPtyState = { paneId: null, connected: false, ws: null }
): PtyTransport {
  let onDataCallback: ((data: string) => void) | null = null
  let onExitCallback: ((code: number) => void) | null = null
  let onErrorCallback: ((message: string) => void) | null = null
  let onConnectCallback: (() => void) | null = null
  let onDisconnectCallback: (() => void) | null = null

  const textEncoder = new TextEncoder()

  // Pending input queue for messages before stream is ready
  let inputQueue: Array<{ kind: string; data: Uint8Array }> = []

  return {
    connect: async (options) => {
      const paneId = fixedPaneId ?? (options as any).paneId ?? 0
      const cwd = options.cwd

      // Store callbacks
      if (options.callbacks) {
        onDataCallback = options.callbacks.onData ?? null
        onExitCallback = options.callbacks.onExit ?? null
        onErrorCallback = options.callbacks.onError ?? null
        onConnectCallback = options.callbacks.onConnect ?? null
        onDisconnectCallback = options.callbacks.onDisconnect ?? null
      }

      // Close existing connection if any
      if (state.paneId !== null && state.paneId !== paneId && state.ws) {
        state.ws.close()
      }

      // Get token for pane stream
      if (!_tokenProvider) {
        onErrorCallback?.('Token provider not configured')
        return
      }

      let attempt = 0
      let lastError: string | null = null
      const maxAttempts = 4

      while (attempt < maxAttempts) {
        let token: string
        try {
          token = await _tokenProvider('pane', paneId)
        } catch (e) {
          onErrorCallback?.(`Failed to get token: ${e}`)
          return
        }

        const opened = await new Promise<boolean>((resolve) => {
          let settled = false
          let attemptError: string | null = null
          lastError = null

          const ws = new WsConnection(`/ws/panes/${paneId}/stream`)
          state.ws = ws
          state.paneId = paneId
          activeTransports.set(paneId, state)

          // Create a fresh decoder per connection — TextDecoder with
          // { stream: true } maintains internal state and must not be
          // shared across panes.
          const decoder = new TextDecoder()

          ws.connect(
            token,
            // onMessage — handles both binary (output) and text (control) frames
            (data) => {
              // Binary frame: raw terminal output — no JSON overhead
              if (data instanceof ArrayBuffer) {
                const text = decoder.decode(new Uint8Array(data), { stream: true })
                if (text) onDataCallback?.(text)
                return
              }

              // Text frame: JSON control message
              let msg: PaneControlMessage
              try {
                msg = JSON.parse(data as string) as PaneControlMessage
              } catch {
                return
              }
              if (!msg) return

              switch (msg.kind) {
                case 'output':
                  // Legacy: some scrollback replays may still arrive as text.
                  // Decode and feed to the terminal.
                  onDataCallback?.(decoder.decode(new Uint8Array(msg.data)))
                  break
                case 'exit': {
                  try {
                    const exitData = JSON.parse(decoder.decode(new Uint8Array(msg.data)))
                    onExitCallback?.(exitData.code ?? 0)
                  } catch {
                    onExitCallback?.(0)
                  }
                  break
                }
                case 'error': {
                  try {
                    const errData = JSON.parse(decoder.decode(new Uint8Array(msg.data)))
                    attemptError = errData.message ?? 'unknown error'
                  } catch {
                    attemptError = 'unknown error'
                  }
                  if (!settled) {
                    settled = true
                    lastError = attemptError ?? null
                    resolve(false)
                  }
                  break
                }
              }
            },
            // onOpen
            () => {
              state.connected = true

              // Send init message with initial grid size so the PTY is created
              // at the correct dimensions before the child process starts.
              const initPayload: Record<string, unknown> = { cwd }
              if (options.cols) initPayload.cols = options.cols
              if (options.rows) initPayload.rows = options.rows
              const initData = textEncoder.encode(JSON.stringify(initPayload))
              const initMsg: PaneInput = { pane_id: paneId, data: Array.from(initData), kind: 'init' }
              ws.send(JSON.stringify(initMsg))

              // Flush queued messages
              for (const msg of inputQueue) {
                const paneMsg: PaneInput = { pane_id: paneId, data: Array.from(msg.data), kind: msg.kind }
                ws.send(JSON.stringify(paneMsg))
              }
              inputQueue = []

              // Fire callbacks AFTER init is queued to prevent resize racing ahead
              onConnectCallback?.()
              options.callbacks?.onConnect?.()

              if (!settled) {
                settled = true
                resolve(true)
              }
            },
            // onClose
            () => {
              state.connected = false
              state.ws = null
              state.paneId = null
              activeTransports.delete(paneId)
              onDisconnectCallback?.()
              if (!settled) {
                settled = true
                lastError = attemptError ?? null
                resolve(false)
              }
            },
            // onError
            (e) => {
              if (state.connected) {
                onErrorCallback?.(String(e))
              }
            },
          )
        })

        if (opened) {
          return
        }

        lastError = lastError ?? 'Failed to connect to pane'
        attempt++
        if (attempt < maxAttempts) {
          const delay = 300 * Math.pow(2, attempt - 1)
          await new Promise(r => setTimeout(r, delay))
        }
      }

      onErrorCallback?.(lastError ?? 'Failed to connect to pane')
    },

    disconnect: () => {
      if (state.ws) {
        state.ws.close()
      }
      if (state.paneId !== null) {
        activeTransports.delete(state.paneId)
      }
      state.connected = false
      state.paneId = null
      state.ws = null
      onDisconnectCallback?.()
    },

    sendInput: (data: string) => {
      if (state.paneId === null || !state.connected || !state.ws) {
        inputQueue.push({ kind: 'input', data: textEncoder.encode(data) })
        return true
      }
      const msg: PaneInput = { pane_id: state.paneId, data: Array.from(textEncoder.encode(data)), kind: 'input' }
      state.ws.send(JSON.stringify(msg))
      return true
    },

    resize: (cols: number, rows: number, meta?: Record<string, unknown>) => {
      const resizeData = textEncoder.encode(JSON.stringify({
        cols,
        rows,
        width_px: (meta as any)?.widthPx ?? cols * 8,
        height_px: (meta as any)?.heightPx ?? rows * 16,
      }))
      if (state.paneId === null || !state.connected || !state.ws) {
        inputQueue.push({ kind: 'resize', data: resizeData })
        return true
      }
      const msg: PaneInput = { pane_id: state.paneId, data: Array.from(resizeData), kind: 'resize' }
      state.ws.send(JSON.stringify(msg))
      return true
    },

    isConnected: () => state.connected,

    destroy: () => {
      if (state.ws) {
        state.ws.close()
      }
      if (state.paneId !== null) {
        activeTransports.delete(state.paneId)
      }
      state.connected = false
      state.paneId = null
      state.ws = null
    },
  }
}
