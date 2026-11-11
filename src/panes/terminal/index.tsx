import {
  Terminal,
  type PtyTransport,
  type TerminalFontSource,
  createDemoController,
  createTerminalAppSession,
  prewarmTerminalCore,
  TERMINAL_WASM_URL,
  shaderStagesForPresets,
} from '@zem-sh/terminal'

// The pane ships its own faces (packages/terminal-pane/fonts) — @zem-sh/terminal
// carries no font binaries.
import {
  FONT_URL_JETBRAINS_MONO,
  FONT_URL_JETBRAINS_MONO_BOLD,
  FONT_URL_JETBRAINS_MONO_ITALIC,
  FONT_URL_JETBRAINS_MONO_BOLD_ITALIC,
  FONT_URL_NERD_SYMBOLS,
  FONT_URL_NOTO_SYMBOLS,
  FONT_URL_SYMBOLA,
  FONT_URL_NOTO_CANADIAN_ABORIGINAL,
  FONT_URL_OPENMOJI,
} from './font-urls'

// Self-inject CSS so styles travel with the pane regardless of how it's loaded
// @ts-ignore
import styles from './styles.css?inline'
if (typeof document !== 'undefined' && !document.querySelector('[data-pane-css="terminal"]')) {
  const s = document.createElement('style')
  s.textContent = styles
  s.setAttribute('data-pane-css', 'terminal')
  document.head.appendChild(s)
}

import { getBuiltinTheme, type GhosttyTheme, type ShaderPreset } from '@zem-sh/terminal'

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import { useTerminalSettings } from './settings-store'
import { terminalSettingsSchema } from './settings-schema'
import { terminalLaunchSchema } from './launch-schema'
import { TerminalSearchBar, type TerminalSearchState } from './search-ui'
import { usePane, paneMetaRegistry, type PaneComponentProps } from '@zem-sh/pane'
import { createGrpcPtyTransport } from './ws-pty-transport'
import { useTerminalVimMode } from './use-terminal-vim-mode'
import { installExternalLinkOpener } from './link-opening'

// Access the shared paneRegistry via the global bridge so CDN-loaded
// bundles and the host app all use the same singleton.
const paneRegistry = (window as any).__zemPaneRegistry

// Import addon API - will be provided by the app at runtime
let addonApi: {
  runPaneQuery: (paneKind: string, query: string, params?: string) => Promise<unknown>
  runPaneMutation: (paneKind: string, mutation: string, params?: string) => Promise<unknown>
} = { runPaneQuery: async () => null, runPaneMutation: async () => null }

export function setAddonApi(api: typeof addonApi) {
  addonApi = api
}

// OSC 7 PWD regex: ESC ] 7 ; file://hostname/path ST
// where ST can be ESC \ (string terminator) or BEL (\x07)
const OSC7_RE = /\x1b\]7;file:\/\/[^/]+([^\x1b\x07]+)(?:\x1b\\|\x07)/g

function resolveCssColorToRgb(raw: string): { r: number; g: number; b: number } | null {
  const el = document.createElement('div')
  el.style.color = raw
  document.body.appendChild(el)
  const rgb = getComputedStyle(el).color
  el.remove()
  const m = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return null
  return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) }
}

function patchPaneBg(theme: GhosttyTheme): GhosttyTheme {
  const paneVal = getComputedStyle(document.documentElement).getPropertyValue('--pane').trim()
  if (!paneVal) return theme
  const rgb = resolveCssColorToRgb(paneVal)
  if (!rgb) return theme
  // Built-in themes are cached, so return a copy instead of mutating the
  // source theme. This override applies uniformly to every theme while
  // transparent terminal backgrounds are enabled.
  return { ...theme, colors: { ...theme.colors, background: rgb } }
}

type FontPresetKey = 'jetbrains' | 'local'

// Locally-installed JetBrains Mono Nerd Font builds are preferred over the
// bundled faces so users who have the font installed get its full glyph set.
const JETBRAINS_LOCAL_VARIANTS: Array<{ suffix: string; matchers: string[] }> = [
  { suffix: '', matchers: ['jetbrains mono nl nerd font mono regular', 'jetbrains mono nl nerd font mono', 'jetbrains mono nl', 'jetbrains mono'] },
  { suffix: 'bold', matchers: ['jetbrains mono nl nerd font mono bold', 'jetbrains mono nl bold', 'jetbrains mono bold', 'jetbrainsmono nerd font mono bold'] },
  { suffix: 'italic', matchers: ['jetbrains mono nl nerd font mono italic', 'jetbrains mono nl italic', 'jetbrains mono italic', 'jetbrainsmono nerd font mono italic'] },
  { suffix: 'bold italic', matchers: ['jetbrains mono nl nerd font mono bold italic', 'jetbrains mono nl bold italic', 'jetbrains mono bold italic', 'jetbrains mono nl italic bold', 'jetbrains mono italic bold', 'jetbrainsmono nerd font mono bold italic'] },
]

function buildFontSourcesForSelection(value: FontPresetKey, localMatcher: string): TerminalFontSource[] {
  const sources: TerminalFontSource[] = []
  if (value === 'local' && localMatcher) {
    // "Local" mode: the chosen system font is the required primary source.
    sources.push({ type: 'local', label: `local:${localMatcher}`, matchers: [localMatcher], required: true })
  } else {
    // Default (JetBrains Mono): prefer a locally-installed Nerd Font build,
    // falling back to the bundled faces appended below.
    for (const variant of JETBRAINS_LOCAL_VARIANTS) {
      sources.push({ type: 'local', label: variant.suffix ? `local:jetbrains ${variant.suffix}` : 'local:jetbrains', matchers: variant.matchers })
    }
  }
  sources.push({ type: 'url', label: 'JetBrains Mono Regular', url: FONT_URL_JETBRAINS_MONO })
  sources.push({ type: 'url', label: 'JetBrains Mono Bold', url: FONT_URL_JETBRAINS_MONO_BOLD })
  sources.push({ type: 'url', label: 'JetBrains Mono Italic', url: FONT_URL_JETBRAINS_MONO_ITALIC })
  sources.push({ type: 'url', label: 'JetBrains Mono Bold Italic', url: FONT_URL_JETBRAINS_MONO_BOLD_ITALIC })
  sources.push({ type: 'url', label: 'Symbols Nerd Font Mono', url: FONT_URL_NERD_SYMBOLS })
  sources.push({ type: 'local', label: 'Apple Symbols', matchers: ['apple symbols', 'applesymbols', 'apple symbols regular'], required: true })
  // Heavy, rarely-used fallback faces load after the first frame so the
  // primary monospace chain paints immediately.
  sources.push({ type: 'url', label: 'Noto Sans Symbols 2', url: FONT_URL_NOTO_SYMBOLS, defer: true })
  sources.push({ type: 'url', label: 'Symbola', url: FONT_URL_SYMBOLA, defer: true })
  sources.push({ type: 'local', label: 'Noto Sans Canadian Aboriginal / Euphemia UCAS', matchers: ['noto sans canadian aboriginal', 'notosanscanadianaboriginal', 'euphemia ucas', 'euphemiaucas'] })
  sources.push({ type: 'url', label: 'Noto Sans Canadian Aboriginal', url: FONT_URL_NOTO_CANADIAN_ABORIGINAL, defer: true })
  // Emoji + CJK come from system fonts (Local Font Access opt-in); the bundled
  // 10MB emoji + 16MB CJK fallbacks were removed — OpenMoji covers emoji here.
  sources.push({ type: 'local', label: 'Color Emoji', matchers: ['apple color emoji', 'applecoloremoji', 'segoe ui emoji', 'noto color emoji'], required: true })
  sources.push({ type: 'url', label: 'OpenMoji', url: FONT_URL_OPENMOJI, defer: true })
  sources.push({ type: 'local', label: 'CJK', matchers: ['pingfang sc', 'pingfang', 'hiragino sans gb', 'microsoft yahei', 'noto sans cjk sc', 'wenquanyi', 'source han sans'], required: true })
  return sources
}

// OSC 0/2 title regex: ESC ] 0 ; title ST  or  ESC ] 2 ; title ST
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x1b\x07]+)(?:\x1b\\|\x07)/g

// Alt-screen enter/exit CSI sequences (no /g — only need one match per call)
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const ALT_SCREEN_EXIT = '\x1b[?1049l'

// Scrolling inside full-screen apps (pi, etc.).
//
// The terminal core forwards exactly one wheel notch to an app that owns the
// mouse (`MouseController.sendMouseEvent` encodes `Math.sign(deltaY)`), while
// its own scrollback path multiplies a discrete step by 3 before scrolling
// (`scrollbar-runtime.ts`). So the shell scrolls three times as far per
// mouse-wheel detent as a TUI does, which reads as "scrolling barely moves"
// once the app has a long transcript. Match the scrollback speed here.
const FULL_SCREEN_WHEEL_NOTCH_MULTIPLIER = 3
// Browsers report a mouse-wheel detent in pixels (typically 100-120, or line
// mode); trackpad deltas are much smaller and arrive continuously.
const DISCRETE_WHEEL_DELTA_PX = 40

// Upper bound for PTY output held while the renderer initializes. The server
// caps scrollback at 10 MB by default, so a little headroom keeps a reconnect
// replay intact while still bounding a runaway launch command.
const EARLY_PTY_OUTPUT_MAX_CHARS = 16 * 1024 * 1024

// All terminal panes share one session: the WASM module, WebGPU core and font
// resource store are then loaded/parsed once per app, not once per pane.
// Prewarming starts the WASM fetch during app startup so the first pane does
// not pay for download + compile when it mounts.
const terminalSession = createTerminalAppSession({ wasmUrl: TERMINAL_WASM_URL })
void prewarmTerminalCore(terminalSession).catch(() => {
  // The pane's own init retries via the same session and reports the error.
})

function TerminalPaneInner({ paneId, isFocused, sessionId = 'default' }: PaneComponentProps) {
  const terminalRef = useRef<Terminal | null>(null)
  const [ptyError, setPtyError] = useState<string | null>(null)
  const altScreenActiveRef = useRef(false)
  const [altScreenActive, setAltScreenActive] = useState(false)
  const currentTitleAppRef = useRef('')
  const [currentTitleApp, setCurrentTitleApp] = useState('')

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchState, setSearchState] = useState<TerminalSearchState>({
    query: '',
    active: false,
    pending: false,
    complete: false,
    total: 0,
    selectedIndex: null,
  })
  const onSearchStateRef = useRef(setSearchState)
  onSearchStateRef.current = setSearchState
  const onPtyErrorRef = useRef(setPtyError)
  onPtyErrorRef.current = setPtyError
  const demoRef = useRef<ReturnType<typeof createDemoController> | null>(null)
  const resizeRafRef = useRef(0)
  const ptyTransportRef = useRef<PtyTransport | null>(null)
  // Output held between "start the shell" and "the renderer can consume
  // bytes". The core's output pipeline flushes to sendInput() on a timer and
  // sendInput() silently drops data until the WASM terminal is ready, so
  // without this the shell's first prompt would be lost when the PTY is
  // started before init() — which is the whole point: boot the shell in
  // parallel with font/WASM/GPU initialization. `sink` is the core's own
  // onData callback, replayed on flush so its output filter still runs.
  const ptyGateRef = useRef({
    ready: false,
    chunks: [] as string[],
    bytes: 0,
    sink: null as ((data: string) => void) | null,
  })

  const renderer = useTerminalSettings(s => s.renderer)
  const fontSize = useTerminalSettings(s => s.fontSize)
  const fontFamily = useTerminalSettings(s => s.fontFamily)
  const ligatures = useTerminalSettings(s => s.ligatures)
  const fontHinting = useTerminalSettings(s => s.fontHinting)
  const fontHintTarget = useTerminalSettings(s => s.fontHintTarget)
  const selectedLocalFont = useTerminalSettings(s => s.selectedLocalFont)
  const activeTheme = useTerminalSettings(s => s.activeTheme)
  const mouseMode = useTerminalSettings(s => s.mouseMode)
  const transparentBackground = useTerminalSettings(s => s.transparentBackground)
  const vimModeEnabled = useTerminalSettings(s => s.vimModeEnabled)
  const jkTriggerMs = useTerminalSettings(s => s.jkTriggerMs)
  const vimTriggerSequence = useTerminalSettings(s => s.vimTriggerSequence)
  const yankExitsVimMode = useTerminalSettings(s => s.yankExitsVimMode)
  const vimDisabledInAltScreen = useTerminalSettings(s => s.vimDisabledInAltScreen)
  const vimDisabledApps = useTerminalSettings(s => s.vimDisabledApps)
  const activeShaders = useTerminalSettings(s => s.activeShaders)
  const lineHeight = useTerminalSettings(s => s.lineHeight)

  // The terminal core routes single printable keys through a hidden IME
  // textarea: it skips them in its window keydown handler and expects the
  // textarea to insert them (then reads them back from `beforeinput`/`input`).
  // That textarea is created `readOnly` and only its own "make it editable"
  // path clears the flag — but that path bails out as soon as the textarea is
  // already the active element, so a textarea that holds focus stays read-only
  // and swallows every plain keystroke. WebKit (the Tauri shell) keeps the
  // textarea focused where Chromium leaves the canvas focused, which is why the
  // browser build types fine and the Tauri build does not. Keys that bypass the
  // insertion path — auto-repeat, Ctrl chords, Backspace — keep working, which
  // is the signature of this bug. Re-arm the input whenever this pane takes
  // typing focus.
  const armTypingInput = useCallback(() => {
    try {
      const input = terminalRef.current?.imeInput
      if (input?.readOnly) input.readOnly = false
    } catch { /* terminal surface not mounted yet */ }
  }, [])

  const { rootRef } = usePane(
    paneId,
    isFocused,
    () => {
      terminalRef.current?.focus()
      armTypingInput()
    },
    (action) => {
      const app = terminalRef.current
      if (!app) return
      if (action === 'clear') app.clearScreen()
      else if (action === 'copy') app.copySelectionToClipboard()
      else if (action === 'paste') app.pasteFromClipboard()
    },
    // A focused terminal must keep DOM focus while it is the active pane;
    // once it loses focus, release the canvas so a stale terminal can't
    // swallow keystrokes meant for the pane the app now considers focused.
    () => terminalRef.current?.blur(),
  )

  // Latest focus state so async init completion and the vim hook can decide
  // whether claiming DOM focus is still appropriate when they resolve.
  const focusedRef = useRef(isFocused)
  focusedRef.current = isFocused

  const { vimActive, scrollbackPercent } = useTerminalVimMode({
    paneId,
    isFocused,
    terminalRef,
    setSearchOpen,
    vimModeEnabled,
    jkTriggerMs,
    vimTriggerSequence,
    yankExitsVimMode,
    vimDisabledInAltScreen,
    vimDisabledApps,
    altScreenActive,
    currentTitleApp,
  })

  const queueResize = useCallback(() => {
    if (resizeRafRef.current) return
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = 0
      terminalRef.current?.updateSize(true)
    })
  }, [])

  const getAdaptivePtyTransport = useCallback((): PtyTransport => {
    if (!ptyTransportRef.current) {
      // Use gRPC transport for direct server connection, pass paneId
      const inner = createGrpcPtyTransport(paneId)
      const gate = ptyGateRef.current
      // Buffer output until the renderer is ready, then hand it over in order.
      // See the main effect: connectPty() runs before init() finishes.
      ptyTransportRef.current = {
        ...inner,
        connect: (options) => {
          gate.sink = options.callbacks.onData ?? null
          return inner.connect({
            ...options,
            callbacks: {
              ...options.callbacks,
              onData: (data) => {
                if (!gate.ready) {
                  if (gate.bytes < EARLY_PTY_OUTPUT_MAX_CHARS) {
                    gate.chunks.push(data)
                    gate.bytes += data.length
                  }
                  return
                }
                options.callbacks.onData?.(data)
              },
            },
          })
        },
      }
    }
    return ptyTransportRef.current
  }, [paneId])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let disposed = false

    // Detected links are opened with `window.open`, which a desktop webview
    // ignores — send them to the system browser instead.
    installExternalLinkOpener()

    const meta = paneMetaRegistry.get(paneId) as { cwd?: string } | undefined

    // Hook into PTY output to detect OSC 7 PWD changes, alt-screen state,
    // and OSC title changes (for app detection).
    const beforeRenderOutput = (payload: { text: string; source: string }): string | null | void => {
      const text = payload.text
      if (text.includes('\x1b]7;')) {
        OSC7_RE.lastIndex = 0
        const match = OSC7_RE.exec(text)
        if (match?.[1]) {
          const cwd = decodeURIComponent(match[1])
          paneMetaRegistry.set(paneId, { cwd })
          window.dispatchEvent(new CustomEvent('pane-cwd', { detail: { paneId, cwd } }))
        }
      }
      // Detect alt-screen enter/exit
      if (text.includes(ALT_SCREEN_ENTER)) {
        altScreenActiveRef.current = true
        setAltScreenActive(true)
      } else if (text.includes(ALT_SCREEN_EXIT)) {
        altScreenActiveRef.current = false
        setAltScreenActive(false)
      }
      // Detect OSC title changes (OSC 0 or OSC 2)
      if (text.includes('\x1b]0;') || text.includes('\x1b]2;')) {
        OSC_TITLE_RE.lastIndex = 0
        const match = OSC_TITLE_RE.exec(text)
        if (match?.[1]) {
          // Strip user@host: prefix common in shell titles
          const title = match[1]
          // Extract likely app name: titles like "vim file.txt" or "nvim"
          // or ":q" -style prefixes
          const appName = title.replace(/^[\w.-]+@[\w.-]+:\s*/, '').split(/\s+/)[0] || ''
          currentTitleAppRef.current = appName
          setCurrentTitleApp(appName)
        }
      }
      return undefined // don't modify the output
    }

    const r = new Terminal({
      root: el,
      autoInit: false,
      session: terminalSession,
      appOptions: {
        renderer,
        fontSize,
        ligatures,
        fontHinting,
        fontHintTarget,
        fontSizeMode: 'em' as const,
        alphaBlending: 'native' as const,
        transparentBackground,
        fontSources: buildFontSourcesForSelection(fontFamily, selectedLocalFont),
        lineHeight,
        ptyTransport: getAdaptivePtyTransport(),
        beforeRenderOutput,
        callbacks: {
          onSearchState: (state: TerminalSearchState) => {
            onSearchStateRef.current(state)
          },
          onPtyError: (message: string) => {
            onPtyErrorRef.current(message)
          },
        },
      },
    })
    terminalRef.current = r
    paneMetaRegistry.set(paneId, { terminal: r })
    demoRef.current = createDemoController(r)

    // Full-screen apps take over the wheel once they enable mouse tracking, so
    // the core hands them a single notch per DOM event. Replay discrete notches
    // here to reach the shell's scrollback speed. The capture listener runs on
    // the pane root, before the core's canvas handler, and the replayed events
    // are tagged so this listener ignores them. Precision (trackpad) deltas and
    // Shift+wheel (scrollback/selection) are left untouched.
    const amplifyFullScreenWheel = (event: WheelEvent) => {
      if ((event as WheelEvent & { __zemWheelReplay?: boolean }).__zemWheelReplay) return
      if (!altScreenActiveRef.current || event.shiftKey || !event.deltaY) return
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const discrete = event.deltaMode === 1 || Math.abs(event.deltaY) >= DISCRETE_WHEEL_DELTA_PX
      if (!discrete) return
      const target = event.target
      if (!(target instanceof Element)) return
      for (let i = 1; i < FULL_SCREEN_WHEEL_NOTCH_MULTIPLIER; i++) {
        const replay = new WheelEvent('wheel', {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
        ;(replay as WheelEvent & { __zemWheelReplay?: boolean }).__zemWheelReplay = true
        target.dispatchEvent(replay)
      }
    }
    el.addEventListener('wheel', amplifyFullScreenWheel, { capture: true, passive: true })
    r.setMouseMode(mouseMode)
    r.setShaderStages(shaderStagesForPresets(activeShaders))

    // Start the shell before the renderer finishes initializing. The shell's
    // boot (rc files, prompt theme) overlaps font acquisition, WASM startup
    // and GPU context creation instead of waiting for all of it. Output that
    // lands in the meantime is buffered by the gated transport above and
    // replayed once init() resolves.
    const gate = ptyGateRef.current
    gate.ready = false
    gate.chunks = []
    gate.bytes = 0
    r.connectPty('', meta?.cwd)

    void (async () => {
      await r.init()
      if (disposed) return
      try {
        if (activeTheme) {
          const theme = getBuiltinTheme(activeTheme)
          if (theme) {
            // When transparent, the pane background shows through, so blend the
            // default themes' internal colors with the pane color; when opaque,
            // show the genuine theme background.
            r.applyTheme(transparentBackground ? patchPaneBg(theme) : theme, activeTheme)
          }
        }
      } catch { /* theme is cosmetic — never block first paint or the PTY flush */ }
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      if (disposed) return
      r.updateSize(true)

      // The WASM core can consume output now: replay the shell's startup
      // output through the core's own onData callback (so its query/clipboard
      // filter still runs), then let live data through.
      const pending = gate.chunks.join('')
      gate.chunks = []
      gate.bytes = 0
      gate.ready = true
      if (pending) gate.sink?.(pending)

      // Only claim DOM focus when this pane is still the focused pane — async
      // init can complete long after the user moved focus elsewhere (or the
      // pane simply started unfocused), and guessing wrong would steal keys
      // from whichever pane actually has focus.
      if (focusedRef.current) {
        r.focus()
        armTypingInput()
      }
    })()

    return () => {
      disposed = true
      el.removeEventListener('wheel', amplifyFullScreenWheel, true)
      // Don't kill addon session on tab switch — it persists until pane is closed
      paneMetaRegistry.delete(paneId)
      demoRef.current?.stop()
      r.destroy()
      ptyTransportRef.current?.destroy?.()
      ptyTransportRef.current = null
      ptyGateRef.current.ready = false
      ptyGateRef.current.chunks = []
      ptyGateRef.current.bytes = 0
      ptyGateRef.current.sink = null
      terminalRef.current = null
      onPtyErrorRef.current(null)
    }
  }, [paneId, sessionId, getAdaptivePtyTransport])

  // The Terminal is constructed with the current `renderer` already applied.
  // This effect only has to react to changes: running it on mount would call
  // setRenderer → init() a second time while the main effect's init() is still
  // in flight (double WASM handle, double GPU backend, double render loop).
  const appliedRendererRef = useRef(renderer)
  useEffect(() => {
    if (appliedRendererRef.current === renderer) return
    appliedRendererRef.current = renderer
    terminalRef.current?.setRenderer(renderer)
  }, [renderer])

  useEffect(() => {
    terminalRef.current?.setFontSize(fontSize)
  }, [fontSize])

  // Same story as the renderer: the terminal is constructed with these font
  // sources, and setFontSources releases and re-acquires the whole (16 MB)
  // font set. Skip the mount run so opening a pane doesn't load it twice.
  const appliedFontsRef = useRef({ fontFamily, selectedLocalFont })
  useEffect(() => {
    const r = terminalRef.current
    if (!r) return
    const applied = appliedFontsRef.current
    if (applied.fontFamily === fontFamily && applied.selectedLocalFont === selectedLocalFont) return
    appliedFontsRef.current = { fontFamily, selectedLocalFont }
    void (async () => {
      try {
        await r.setFontSources(buildFontSourcesForSelection(fontFamily, selectedLocalFont))
      } catch { /* ignore */ }
    })()
  }, [fontFamily, selectedLocalFont])

  useEffect(() => {
    const r = terminalRef.current
    if (!r) return
    r.setLigatures(ligatures)
    r.setFontHintTarget(fontHintTarget)
    r.setFontHinting(fontHinting)
  }, [ligatures, fontHintTarget, fontHinting])

  useEffect(() => {
    const r = terminalRef.current
    if (!r) return
    if (!activeTheme) { r.resetTheme(); return }
    const theme = getBuiltinTheme(activeTheme)
    if (!theme) return
    try {
      r.applyTheme(transparentBackground ? patchPaneBg(theme) : theme, activeTheme)
    } catch { /* ignore */ }
  }, [activeTheme, transparentBackground])

  useEffect(() => {
    terminalRef.current?.setMouseMode(mouseMode)
  }, [mouseMode])

  useEffect(() => {
    // Live toggle — re-configures the canvas alpha mode without recreating the
    // terminal or touching the PTY/shell.
    terminalRef.current?.setTransparentBackground(transparentBackground)
  }, [transparentBackground])

  useEffect(() => {
    const r = terminalRef.current
    if (!r) return
    r.setShaderStages(shaderStagesForPresets(activeShaders))
  }, [activeShaders])

  useEffect(() => {
    terminalRef.current?.setLineHeight(lineHeight)
  }, [lineHeight])

  useEffect(() => {
    window.addEventListener('resize', queueResize)
    return () => window.removeEventListener('resize', queueResize)
  }, [queueResize])

  // Jump the viewport back to the live end of the buffer. Ctrl+C interrupts
  // whatever is running, so the user wants to see the interrupt and the new
  // prompt even if they were reading older scrollback.
  const scrollToBottom = useCallback(() => {
    const t = terminalRef.current
    if (!t) return
    const info = t.getScrollbackInfo()
    const maxOffset = Math.max(0, (info.totalLines || 0) - (info.viewportLen || 0))
    const delta = maxOffset - info.viewportOffset
    if (delta > 0) t.scrollViewport(delta)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (!isFocused) return
      // Don't open search bar when vim mode is active (vim mode handles / key)
      if (vimActive) return
      // Ctrl+C is forwarded to the PTY by the terminal core; only add the
      // scroll. Do not prevent or stop the event.
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === 'c') {
        scrollToBottom()
        return
      }
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && !e.altKey && e.key === '/') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [isFocused, vimActive, scrollToBottom])

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query)
    terminalRef.current?.setSearchQuery(query)
  }, [])

  const handleSearchNext = useCallback(() => {
    terminalRef.current?.searchNext()
  }, [])

  const handleSearchPrevious = useCallback(() => {
    terminalRef.current?.searchPrevious()
  }, [])

  const handleSearchClear = useCallback(() => {
    terminalRef.current?.clearSearch()
    setSearchQuery('')
    setSearchState({
      query: '',
      active: false,
      pending: false,
      complete: false,
      total: 0,
      selectedIndex: null,
    })
  }, [])

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    terminalRef.current?.focus()
  }, [])

  const handleErrorClick = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  if (ptyError) {
    return (
      <div className="w-full h-full flex items-center flex-col gap-1 justify-center" onClick={handleErrorClick}>
        <div className="text-lg font-medium" style={{ color: '#f87171' }}>Terminal Error</div>
        <div className="text-sm leading-relaxed" style={{ color: '#d1d5db' }}>{ptyError}</div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full">
      <div ref={rootRef} className="w-full h-full" onPointerDown={armTypingInput} />
      {vimActive && (
        <div
          className="pointer-events-none absolute bottom-0 right-0 z-10 px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground"
          aria-label={`Terminal position ${scrollbackPercent}%`}
        >
          {scrollbackPercent}%
        </div>
      )}
      <TerminalSearchBar
        open={searchOpen}
        query={searchQuery}
        onQueryChange={handleSearchQueryChange}
        searchState={searchState}
        onNext={handleSearchNext}
        onPrevious={handleSearchPrevious}
        onClear={handleSearchClear}
        onClose={handleSearchClose}
      />
    </div>
  )
}

export function TerminalPane(props: PaneComponentProps) {
  return <TerminalPaneInner {...props} />
}

export function register(): void {
  paneRegistry.register({
    kind: 'terminal',
    title: 'Terminal',
    description: 'Full terminal emulator on the Ghostty core — ligatures, images, themes and GPU rendering',
    icon: TerminalIcon,
    component: TerminalPane,
    settingsSchema: terminalSettingsSchema,
    launchSchema: terminalLaunchSchema,
    contextMenuActions: (paneId: number) => [
      {
        label: 'Copy', shortcut: '\u2318C', action: () => {
          window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'copy' } }))
        }
      },
      {
        label: 'Paste', shortcut: '\u2318V', action: () => {
          window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'paste' } }))
        }
      },
      {
        label: 'Clear Screen', action: () => {
          window.dispatchEvent(new CustomEvent('pane-action', { detail: { paneId, action: 'clear' } }))
        }
      },
    ],
    registerBindings() {
      return [
        {
          id: 'new-terminal',
          keys: [{ key: 'n', meta: true }],
          description: 'New Terminal pane',
          action: () => {
            window.dispatchEvent(new CustomEvent('pane:new-tile', { detail: { kind: 'terminal' } }))
          },
        },
      ]
    },
    serialize(paneId: number) {
      const meta = paneMetaRegistry.get(paneId) as { cwd?: string } | undefined
      if (!meta) return undefined
      const data: Record<string, unknown> = {}
      if (meta.cwd) data.cwd = meta.cwd
      return Object.keys(data).length > 0 ? data : undefined
    },
    deserialize(paneId: number, data: Record<string, unknown>) {
      const meta: { cwd?: string } = {}
      if (typeof data.cwd === 'string') meta.cwd = data.cwd
      if (Object.keys(meta).length > 0) {
        paneMetaRegistry.set(paneId, meta)
      }
    },
    onConfigChange(config: Record<string, unknown>) {
      const terminal = config.terminal as Record<string, unknown> | undefined
      if (!terminal) return
      const s = useTerminalSettings.getState()
      if (terminal.renderer !== undefined) s.setRenderer(terminal.renderer as 'auto' | 'webgpu' | 'webgl2')
      if (terminal.font_size !== undefined) s.setFontSize(terminal.font_size as number)
      if (terminal.font_family !== undefined) s.setFontFamily(terminal.font_family as FontPresetKey)
      if (terminal.ligatures !== undefined) s.setLigatures(terminal.ligatures as boolean)
      if (terminal.font_hinting !== undefined) s.setFontHinting(terminal.font_hinting as boolean)
      if (terminal.font_hint_target !== undefined) s.setFontHintTarget(terminal.font_hint_target as 'auto' | 'light' | 'normal')
      if (terminal.selected_local_font !== undefined) s.setSelectedLocalFont(terminal.selected_local_font as string)
      if (terminal.active_theme !== undefined) s.setActiveTheme(terminal.active_theme as string)
      if (terminal.mouse_mode !== undefined) s.setMouseMode(terminal.mouse_mode as 'auto' | 'on' | 'off')
      if (terminal.transparent_background !== undefined) s.setTransparentBackground(terminal.transparent_background as boolean)
      if (terminal.vim_mode_enabled !== undefined) s.setVimModeEnabled(terminal.vim_mode_enabled as boolean)
      if (terminal.jk_trigger_ms !== undefined) s.setJkTriggerMs(terminal.jk_trigger_ms as number)
      if (terminal.vim_trigger_sequence !== undefined) s.setVimTriggerSequence(terminal.vim_trigger_sequence as string)
      if (terminal.yank_exits_vim_mode !== undefined) s.setYankExitsVimMode(terminal.yank_exits_vim_mode as boolean)
      if (terminal.vim_disabled_in_alt_screen !== undefined) s.setVimDisabledInAltScreen(terminal.vim_disabled_in_alt_screen as boolean)
      if (terminal.vim_disabled_apps !== undefined) s.setVimDisabledApps(terminal.vim_disabled_apps as string)
      if (terminal.line_height !== undefined) s.setLineHeight(terminal.line_height as number)
      if (Array.isArray(terminal.active_shaders)) {
        const target = terminal.active_shaders as ShaderPreset[]
        const current = s.activeShaders
        for (const shader of current) {
          if (!target.includes(shader)) s.toggleShader(shader)
        }
        for (const shader of target) {
          if (!current.includes(shader)) s.toggleShader(shader)
        }
      }
    },
  })
}

export function unregister(): void {
  paneRegistry.unregister('terminal')
}

// Backward compatibility alias
export const registerTerminalPane = register

export { useTerminalSettings, setConfigHelpers } from './settings-store'
export { setTokenProvider, setServerUrl } from './ws-pty-transport'
export type { RendererChoice, FontPresetKey, FontHintTarget } from './settings-store'
export { paneMetaRegistry as paneMeta } from '@zem-sh/pane'
export type { ShaderPreset, DemoKind } from '@zem-sh/terminal'
export { GHOSTTY_VERSION, GHOSTTY_COMMIT, GHOSTTY_PATCH_SHA256, ZIG_VERSION, TERMINAL_WASM_OPTIMIZE, TERMINAL_WASM_SIZE, TERMINAL_WASM_SHA256 } from '@zem-sh/terminal'
