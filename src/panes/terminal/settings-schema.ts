import type { PaneSettingsField, PaneSettingsGroup, PaneSettingsSchema } from '@zem-sh/pane'
import type { ShaderPreset } from '@zem-sh/terminal'
import {
  GHOSTTY_VERSION,
  GHOSTTY_COMMIT,
  GHOSTTY_PATCH_SHA256,
  ZIG_VERSION,
  TERMINAL_WASM_OPTIMIZE,
  TERMINAL_WASM_SIZE,
  TERMINAL_WASM_SHA256,
} from '@zem-sh/terminal'
import {
  useTerminalSettings,
  type RendererChoice,
  type FontPresetKey,
  type FontHintTarget,
} from './settings-store'

const SHADER_PRESETS: ReadonlyArray<readonly [ShaderPreset, string, string]> = [
  ['passthrough', 'Passthrough', 'No-op: returns source unchanged (pipeline test)'],
  ['scanline', 'Scanline', 'CRT scanline effect'],
  ['aurora', 'Aurora', 'Aurora borealis effect'],
  ['crt-lite', 'CRT Lite', 'CRT vignette + mask'],
  ['mono-green', 'Mono Green', 'Monochrome green tint'],
  ['cursor-trail', 'Cursor Trail', 'Cursor movement trail'],
]

function detectLocalFonts(): void {
  const s = useTerminalSettings.getState()
  if (typeof window === 'undefined' || !('queryLocalFonts' in window)) {
    s.setFontHint('Local font picker is not supported in this browser.')
    return
  }
  void (async () => {
    try {
      const fonts = await (window as any).queryLocalFonts()
      const seen = new Set<string>()
      const detected: string[] = []
      for (const f of fonts) {
        const family = String(f.family ?? '').trim()
        if (!family || seen.has(family.toLowerCase())) continue
        seen.add(family.toLowerCase())
        detected.push(family)
      }
      const st = useTerminalSettings.getState()
      st.setLocalFontOptions(detected)
      st.setFontHint(`Detected ${detected.length} local font families.`)
    } catch {
      useTerminalSettings.getState().setFontHint('Local font access denied or unavailable.')
    }
  })()
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function buildGroups(): PaneSettingsGroup[] {
  const s = useTerminalSettings.getState()

  const supportsLocalFonts = typeof window !== 'undefined' && 'queryLocalFonts' in window

  const themeOptions = s.themeNames.map(name => ({ value: name, label: name }))
  if (!s.activeTheme || !s.themeNames.includes(s.activeTheme)) {
    themeOptions.unshift({ value: '', label: 'Default' })
  }

  const localFontOptions: { value: string; label: string }[] = [{ value: 'none', label: 'None' }]
  for (const f of s.localFontOptions) {
    localFontOptions.push({ value: `local:${f}`, label: f })
  }

  const terminalFields: PaneSettingsField[] = [
    {
      type: 'select',
      key: 'theme',
      label: 'Color Theme',
      description: 'Terminal color scheme',
      value: s.activeTheme,
      options: themeOptions,
      onChange: (v) => useTerminalSettings.getState().setActiveTheme(v),
    },
    {
      type: 'toggle',
      key: 'transparentBackground',
      label: 'Transparent Background',
      description: 'Show the pane background instead of the theme color',
      value: s.transparentBackground,
      onChange: (v) => useTerminalSettings.getState().setTransparentBackground(v),
    },
    {
      type: 'select',
      key: 'renderer',
      label: 'Renderer',
      description: 'WebGPU / WebGL2 / Auto',
      value: s.renderer,
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'webgpu', label: 'WebGPU' },
        { value: 'webgl2', label: 'WebGL2' },
      ],
      onChange: (v) => useTerminalSettings.getState().setRenderer(v as RendererChoice),
    },
    {
      type: 'number',
      key: 'fontSize',
      label: 'Font Size',
      description: 'Terminal text size (10-64)',
      value: s.fontSize,
      min: 10,
      max: 64,
      onChange: (v) => useTerminalSettings.getState().setFontSize(v),
    },
    {
      type: 'number',
      key: 'lineHeight',
      label: 'Adjust Cell Height',
      description: 'Extra cell height as % of the font height (-50 to 100)',
      value: s.lineHeight,
      min: -50,
      max: 100,
      onChange: (v) => useTerminalSettings.getState().setLineHeight(v),
    },
    {
      type: 'select',
      key: 'fontFamily',
      label: 'Font Family',
      description: 'Base monospace font',
      value: s.fontFamily,
      options: [
        { value: 'jetbrains', label: 'JetBrains Mono (default)' },
        { value: 'local', label: 'Local font' },
      ],
      onChange: (v) => useTerminalSettings.getState().setFontFamily(v as FontPresetKey),
    },
    {
      type: 'toggle',
      key: 'ligatures',
      label: 'Ligatures',
      description: 'Enable font ligatures',
      value: s.ligatures,
      onChange: (v) => useTerminalSettings.getState().setLigatures(v),
    },
    {
      type: 'toggle',
      key: 'fontHinting',
      label: 'Font Hinting',
      description: 'Enable font hinting',
      value: s.fontHinting,
      onChange: (v) => {
        const st = useTerminalSettings.getState()
        st.setFontHinting(v)
        if (!v) st.setFontHintTarget('auto')
      },
    },
    {
      type: 'select',
      key: 'fontHintTarget',
      label: 'Hint Target',
      description: 'Auto / Light / Normal',
      value: s.fontHintTarget,
      disabled: !s.fontHinting,
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'light', label: 'Light' },
        { value: 'normal', label: 'Normal' },
      ],
      onChange: (v) => useTerminalSettings.getState().setFontHintTarget(v as FontHintTarget),
    },
    {
      type: 'select',
      key: 'localFont',
      label: 'Local Font',
      description: 'System font used when Font Family is "Local"',
      value: s.selectedLocalFont ? `local:${s.selectedLocalFont}` : 'none',
      disabled: !supportsLocalFonts || s.fontFamily !== 'local',
      options: localFontOptions,
      onChange: (v) => {
        const st = useTerminalSettings.getState()
        if (v === 'none') {
          st.setSelectedLocalFont('')
          return
        }
        const name = v.slice('local:'.length)
        st.setSelectedLocalFont(name)
        if (!st.localFontOptions.includes(name)) {
          st.setLocalFontOptions([...st.localFontOptions, name])
        }
      },
    },
    {
      type: 'action',
      key: 'detectLocalFonts',
      label: 'Detect',
      description: s.fontHint || 'Scan system fonts via the Local Font Access API',
      disabled: !supportsLocalFonts,
      onAction: detectLocalFonts,
    },
    {
      type: 'select',
      key: 'mouseMode',
      label: 'Mouse Mode',
      description: 'Terminal mouse tracking',
      value: s.mouseMode,
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      onChange: (v) => useTerminalSettings.getState().setMouseMode(v as 'auto' | 'on' | 'off'),
    },
  ]

  const vimFields: PaneSettingsField[] = [
    {
      type: 'toggle',
      key: 'vimModeEnabled',
      label: 'Vim Scrollback Mode',
      description: 'Enable Ctrl+K / jk to navigate scrollback with vim keys',
      value: s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setVimModeEnabled(v),
    },
    {
      type: 'text',
      key: 'vimTriggerSequence',
      label: 'Vim Trigger Keys',
      description: 'Fast key sequence to enter Vim mode',
      value: s.vimTriggerSequence,
      placeholder: 'jk',
      disabled: !s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setVimTriggerSequence(v),
    },
    {
      type: 'number',
      key: 'jkTriggerMs',
      label: 'Trigger Interval (ms)',
      description: 'Max time between trigger keys (100–800 ms)',
      value: s.jkTriggerMs,
      min: 100,
      max: 800,
      disabled: !s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setJkTriggerMs(v),
    },
    {
      type: 'toggle',
      key: 'yankExitsVimMode',
      label: 'Exit After Yank',
      description: 'Leave Vim mode after copying a visual selection',
      value: s.yankExitsVimMode,
      disabled: !s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setYankExitsVimMode(v),
    },
    {
      type: 'toggle',
      key: 'vimDisabledInAltScreen',
      label: 'Disable in Alt Screen',
      description: 'Auto-disable Vim mode when a full-screen app (vim, less, etc.) uses the alternate screen',
      value: s.vimDisabledInAltScreen,
      disabled: !s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setVimDisabledInAltScreen(v),
    },
    {
      type: 'text',
      key: 'vimDisabledApps',
      label: 'Disabled App Names',
      description: 'Comma-separated process names whose title matches disable Vim mode (e.g. vim,nvim,less)',
      value: s.vimDisabledApps,
      placeholder: 'vim,nvim,less,man',
      disabled: !s.vimModeEnabled,
      onChange: (v) => useTerminalSettings.getState().setVimDisabledApps(v),
    },
  ]

  const shaderFields: PaneSettingsField[] = SHADER_PRESETS.map(([key, label, desc]) => ({
    type: 'toggle',
    key,
    label,
    description: desc,
    value: s.activeShaders.includes(key),
    onChange: () => useTerminalSettings.getState().toggleShader(key),
  }))

  const aboutFields: PaneSettingsField[] = [
    {
      type: 'info',
      key: 'ghosttyVersion',
      label: 'Ghostty version',
      value: GHOSTTY_VERSION,
      mono: true,
    },
    {
      type: 'info',
      key: 'zigVersion',
      label: 'Zig version',
      value: ZIG_VERSION,
      mono: true,
    },
    {
      type: 'info',
      key: 'optimizeMode',
      label: 'Optimize mode',
      value: TERMINAL_WASM_OPTIMIZE,
      mono: true,
    },
    {
      type: 'info',
      key: 'wasmSize',
      label: 'WASM size',
      value: formatBytes(TERMINAL_WASM_SIZE),
      mono: true,
    },
    {
      type: 'info',
      key: 'wasmTarget',
      label: 'Build target',
      value: 'wasm32-freestanding',
      mono: true,
    },
    {
      type: 'info',
      key: 'ghosttyCommit',
      label: 'Ghostty commit',
      value: GHOSTTY_COMMIT.slice(0, 12),
      mono: true,
    },
    {
      type: 'info',
      key: 'ghosttyPatch',
      label: 'Ghostty patch',
      value: GHOSTTY_PATCH_SHA256.slice(0, 12),
      mono: true,
    },
    {
      type: 'info',
      key: 'wasmSha256',
      label: 'WASM sha256',
      value: TERMINAL_WASM_SHA256.slice(0, 16),
      mono: true,
    },
  ]

  return [
    { title: 'TERMINAL', fields: terminalFields },
    { title: 'VIM MODE', fields: vimFields },
    { title: 'SHADERS', fields: shaderFields },
    { title: 'ABOUT', fields: aboutFields },
  ]
}

export const terminalSettingsSchema: PaneSettingsSchema = {
  get groups(): PaneSettingsGroup[] {
    return buildGroups()
  },
  subscribe: (listener) => useTerminalSettings.subscribe(listener),
  getSnapshot: () => useTerminalSettings.getState(),
}
