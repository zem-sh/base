import type { PaneSettingsGroup, PaneSettingsSchema } from '@zem-sh/pane'
import { useVCSettings } from './settings-store'

function buildGroups(): PaneSettingsGroup[] {
  const s = useVCSettings.getState()

  return [
    {
      title: 'CONFIRMATIONS',
      fields: [
        {
          type: 'toggle' as const,
          key: 'confirmDiscard',
          label: 'Confirm before discard',
          description: 'Show a confirmation dialog before discarding file changes',
          value: s.confirmDiscard,
          onChange: (v) => { useVCSettings.getState().setConfirmDiscard(v) },
        },
      ],
    },
  ]
}

export const vcSettingsSchema: PaneSettingsSchema = {
  get groups(): PaneSettingsGroup[] {
    return buildGroups()
  },
  subscribe: (listener) => useVCSettings.subscribe(listener),
  getSnapshot: () => useVCSettings.getState(),
}
