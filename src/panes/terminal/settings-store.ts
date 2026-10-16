import { create } from 'zustand'
import { listBuiltinThemeNames } from '@zem-sh/terminal'
import type { ShaderPreset, DemoKind } from '@zem-sh/terminal'

export type RendererChoice = 'auto' | 'webgpu' | 'webgl2'
export type FontPresetKey = 'jetbrains' | 'local'
export type FontHintTarget = 'auto' | 'light' | 'normal'

interface TerminalSettingsState {
  renderer: RendererChoice
  fontSize: number
  fontFamily: FontPresetKey
  ligatures: boolean
  fontHinting: boolean
  fontHintTarget: FontHintTarget
  selectedLocalFont: string
  localFontOptions: string[]
  activeTheme: string
  themeNames: string[]
  mouseMode: 'auto' | 'on' | 'off'
  transparentBackground: boolean
  vimModeEnabled: boolean
  jkTriggerMs: number
  vimTriggerSequence: string
  yankExitsVimMode: boolean
  vimDisabledInAltScreen: boolean
  vimDisabledApps: string
  activeShaders: ShaderPreset[]
  demoKind: DemoKind
  fontHint: string
  lineHeight: number

  setRenderer: (v: RendererChoice) => void
  setFontSize: (v: number) => void
  setFontFamily: (v: FontPresetKey) => void
  setLigatures: (v: boolean) => void
  setFontHinting: (v: boolean) => void
  setFontHintTarget: (v: FontHintTarget) => void
  setSelectedLocalFont: (v: string) => void
  setLocalFontOptions: (v: string[]) => void
  setActiveTheme: (v: string) => void
  setThemeNames: (v: string[]) => void
  setMouseMode: (v: 'auto' | 'on' | 'off') => void
  setTransparentBackground: (v: boolean) => void
  setVimModeEnabled: (v: boolean) => void
  setJkTriggerMs: (v: number) => void
  setVimTriggerSequence: (v: string) => void
  setYankExitsVimMode: (v: boolean) => void
  setVimDisabledInAltScreen: (v: boolean) => void
  setVimDisabledApps: (v: string) => void
  toggleShader: (v: ShaderPreset) => void
  setDemoKind: (v: DemoKind) => void
  setFontHint: (v: string) => void
  setLineHeight: (v: number) => void
}

const DEFAULT_THEME_NAME = 'Aizen Dark'
const defaultThemeNames = listBuiltinThemeNames()
const initialTheme = defaultThemeNames.includes(DEFAULT_THEME_NAME) ? DEFAULT_THEME_NAME : ''

let _updateConfig: ((section: string, key: string, value: unknown) => void) | null = null

export function setConfigHelpers(
  updateFn: (section: string, key: string, value: unknown) => void,
  _getFn: () => { terminal: Record<string, unknown> }
) {
  _updateConfig = updateFn
}

function saveToConfig(key: string, value: unknown) {
  if (_updateConfig) {
    _updateConfig('terminal', key, value)
  }
}

export const useTerminalSettings = create<TerminalSettingsState>((set) => ({
  renderer: 'auto',
  fontSize: 18,
  fontFamily: 'jetbrains',
  ligatures: true,
  fontHinting: false,
  fontHintTarget: 'auto',
  selectedLocalFont: '',
  localFontOptions: [],
  activeTheme: initialTheme,
  themeNames: defaultThemeNames,
  mouseMode: 'auto',
  transparentBackground: true,
  vimModeEnabled: true,
  jkTriggerMs: 350,
  vimTriggerSequence: 'jk',
  yankExitsVimMode: true,
  vimDisabledInAltScreen: true,
  vimDisabledApps: 'vim,nvim,neovim,nano,emacs,less,more,top,htop,man',
  activeShaders: [],
  demoKind: 'basic',
  fontHint: '',
  lineHeight: 30,

  setRenderer: (v) => { saveToConfig('renderer', v); set({ renderer: v }) },
  setFontSize: (v) => { saveToConfig('font_size', v); set({ fontSize: v }) },
  setFontFamily: (v) => { saveToConfig('font_family', v); set({ fontFamily: v }) },
  setLigatures: (v) => { saveToConfig('ligatures', v); set({ ligatures: v }) },
  setFontHinting: (v) => { saveToConfig('font_hinting', v); set({ fontHinting: v }) },
  setFontHintTarget: (v) => { saveToConfig('font_hint_target', v); set({ fontHintTarget: v }) },
  setSelectedLocalFont: (v) => { saveToConfig('selected_local_font', v); set({ selectedLocalFont: v }) },
  setLocalFontOptions: (v) => set({ localFontOptions: v }),
  setActiveTheme: (v) => { saveToConfig('active_theme', v); set({ activeTheme: v }) },
  setThemeNames: (v) => set({ themeNames: v }),
  setMouseMode: (v) => { saveToConfig('mouse_mode', v); set({ mouseMode: v }) },
  setTransparentBackground: (v) => { saveToConfig('transparent_background', v); set({ transparentBackground: v }) },
  setVimModeEnabled: (v) => { saveToConfig('vim_mode_enabled', v); set({ vimModeEnabled: v }) },
  setJkTriggerMs: (v) => { saveToConfig('jk_trigger_ms', v); set({ jkTriggerMs: v }) },
  setVimTriggerSequence: (v) => {
    const normalized = v.trim().toLowerCase()
    saveToConfig('vim_trigger_sequence', normalized)
    set({ vimTriggerSequence: normalized })
  },
  setYankExitsVimMode: (v) => { saveToConfig('yank_exits_vim_mode', v); set({ yankExitsVimMode: v }) },
  setVimDisabledInAltScreen: (v) => { saveToConfig('vim_disabled_in_alt_screen', v); set({ vimDisabledInAltScreen: v }) },
  setVimDisabledApps: (v) => {
    const normalized = v.trim().toLowerCase()
    saveToConfig('vim_disabled_apps', normalized)
    set({ vimDisabledApps: normalized })
  },
  toggleShader: (v) => set(s => {
    const newShaders = s.activeShaders.includes(v)
      ? s.activeShaders.filter(p => p !== v)
      : [...s.activeShaders, v]
    saveToConfig('active_shaders', newShaders)
    return { activeShaders: newShaders }
  }),
  setDemoKind: (v) => set({ demoKind: v }),
  setFontHint: (v) => set({ fontHint: v }),
  setLineHeight: (v) => { saveToConfig('line_height', v); set({ lineHeight: v }) },
}))
