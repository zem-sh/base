import type { PaneLaunchSchema } from '@zem-sh/pane'

export const terminalLaunchSchema: PaneLaunchSchema = {
  fields: [
    {
      type: 'text',
      key: 'command',
      label: 'Command',
      description: 'Program to run when the pane opens (e.g. nvim, htop)',
      value: '',
      placeholder: 'e.g. nvim --clean',
    },
  ],
}
