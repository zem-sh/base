import type { PaneSettingsField, PaneSettingsGroup, PaneSettingsSchema } from '@zem-sh/pane'
import { settingsStore } from './settings'

function buildGroups(): PaneSettingsGroup[] {
  const s = settingsStore.get()

  const editorFields: PaneSettingsField[] = [
    {
      type: 'toggle',
      key: 'vimMode',
      label: 'Vim Mode',
      description: 'Vim keybindings for editing',
      value: s.vimMode,
      onChange: (v) => settingsStore.setKey('vimMode', v),
    },
    {
      type: 'toggle',
      key: 'autoClose',
      label: 'Auto Close',
      description: 'Auto-close markdown delimiters and HTML tags while typing',
      value: s.autoClose,
      onChange: (v) => settingsStore.setKey('autoClose', v),
    },
    {
      type: 'number',
      key: 'fontSize',
      label: 'Font Size',
      description: 'Editor text size (10–24)',
      value: s.fontSize,
      min: 10,
      max: 24,
      onChange: (v) => settingsStore.setKey('fontSize', v),
    },
    {
      type: 'select',
      key: 'fontFamily',
      label: 'Font Family',
      description: 'Editor monospace font',
      value: s.fontFamily,
      options: [
        { value: 'ui-monospace, SFMono-Regular, Menlo, monospace', label: 'System Mono' },
        { value: '"JetBrains Mono", ui-monospace, monospace', label: 'JetBrains Mono' },
        { value: '"Fira Code", ui-monospace, monospace', label: 'Fira Code' },
        { value: '"SF Mono", SFMono-Regular, ui-monospace, monospace', label: 'SF Mono' },
        { value: 'Menlo, ui-monospace, monospace', label: 'Menlo' },
      ],
      onChange: (v) => settingsStore.setKey('fontFamily', v),
    },
    {
      type: 'toggle',
      key: 'autoSave',
      label: 'Auto Save',
      description: 'Save the note automatically while typing',
      value: s.autoSave,
      onChange: (v) => settingsStore.setKey('autoSave', v),
    },
    {
      type: 'toggle',
      key: 'yankEnabled',
      label: 'Vim Yank',
      description: 'Use y to copy the selected note name to clipboard in the list',
      value: s.yankEnabled,
      onChange: (v) => settingsStore.setKey('yankEnabled', v),
    },
  ]

  return [{ title: 'EDITOR', fields: editorFields }]
}

export const notesSettingsSchema: PaneSettingsSchema = {
  get groups(): PaneSettingsGroup[] {
    return buildGroups()
  },
  subscribe: (listener: () => void) => settingsStore.subscribe(listener),
  getSnapshot: () => settingsStore.get(),
}
