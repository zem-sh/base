const selectedPathStore = new Map<number, string | null>()
const selectedPathListeners = new Map<number, () => void>()

export function getSelectedPath(paneId: number): string | null {
  return selectedPathStore.get(paneId) ?? null
}

export function setSelectedPath(paneId: number, path: string | null) {
  selectedPathStore.set(paneId, path)
  selectedPathListeners.get(paneId)?.()
}

export function onSelectedPathChange(paneId: number, callback: () => void): () => void {
  selectedPathListeners.set(paneId, callback)
  return () => selectedPathListeners.delete(paneId)
}
