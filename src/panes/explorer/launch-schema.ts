import type { PaneLaunchSchema } from '@zem-sh/pane'
import { addonQuery } from './hooks/use-remote-connection'
import type { RemoteConnectionConfig } from './types'

export const explorerLaunchSchema: PaneLaunchSchema = {
  fields: [
    {
      type: 'select',
      key: 'connectionId',
      label: 'Connection',
      description: 'Saved connection to open',
      value: '',
      options: [],
      optionsLoader: async () => {
        try {
          const res = await addonQuery<{ connections: RemoteConnectionConfig[] }>('get_saved_connections', {})
          return (res.connections || []).map(c => ({ value: c.id, label: c.label }))
        } catch {
          return []
        }
      },
      onChange: () => {},
    },
    {
      type: 'text',
      key: 'rootPath',
      label: 'Root path',
      description: 'Initial directory (defaults to connection root or home)',
      value: '',
      placeholder: 'e.g. /home/user/projects',
      onChange: () => {},
    },
  ],
}
