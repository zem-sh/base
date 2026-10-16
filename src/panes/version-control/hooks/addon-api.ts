export interface AddonApi {
  runPaneQuery: (paneKind: string, query: string, params?: string, paneId?: number) => Promise<unknown>
  runPaneMutation: (paneKind: string, mutation: string, params?: string, paneId?: number) => Promise<unknown>
}

let addonApi: AddonApi = { runPaneQuery: async () => null, runPaneMutation: async () => null }

export function setAddonApi(api: AddonApi) {
  addonApi = api
}

export function getAddonApi(): AddonApi {
  return addonApi
}
