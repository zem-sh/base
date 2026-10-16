class PaneMetaRegistry {
  private meta = new Map<number, { cwd?: string; scrollback?: string; terminal?: any }>()

  set(paneId: number, data: { cwd?: string; scrollback?: string; terminal?: any }) {
    const existing = this.meta.get(paneId) ?? {}
    this.meta.set(paneId, { ...existing, ...data })
  }

  get(paneId: number): { cwd?: string; scrollback?: string; terminal?: any } | undefined {
    return this.meta.get(paneId)
  }

  delete(paneId: number): void {
    this.meta.delete(paneId)
  }
}

export const paneMeta = new PaneMetaRegistry()
