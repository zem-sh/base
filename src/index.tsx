/**
 * Merged Zem base pane extension.
 *
 * One bundle serves every base pane: terminal, explorer, empty (general),
 * stats, version control and markdown notes. Each pane keeps its own sources
 * under `panes/<name>/` and self-registers its renderer into the host's shared
 * `window.__zemPaneRegistry` bridge when its `register()` runs.
 *
 * The host loads this bundle once per discovered pane kind and injects the
 * shared runtime dependencies (addon API, server URL, workspace, token provider,
 * config helpers) before calling `register()`. Because there is a single module
 * instance, this file fans the injections out to every pane module.
 *
 * Everything the host provides (react, @zem-sh/pane, zustand, codemirror, …) is
 * external and resolved to the host's instances — see `shared-runtime.json`.
 */
import * as terminal from './panes/terminal'
import * as explorer from './panes/explorer'
import * as empty from './panes/empty'
import * as stats from './panes/stats'
import * as versionControl from './panes/version-control'
import * as notes from './panes/notes'

/** Shape of the host-provided addon API (see the host's pane-runtime). */
export interface PaneAddonApi {
  runPaneQuery: (paneKind: string, query: string, params?: string, paneId?: number) => Promise<unknown>
  runPaneMutation: (paneKind: string, mutation: string, params?: string, paneId?: number) => Promise<unknown>
}

type ConfigHelpersGet = () => { terminal: Record<string, unknown> }
type ConfigHelpersUpdate = (section: string, key: string, value: unknown) => void

/** The subset of the dependency-injection surface a pane module may expose. */
interface PaneModule {
  register?: () => void
  unregister?: () => void
  setAddonApi?: (api: PaneAddonApi) => void
  setTokenProvider?: (provider: (kind: string, resourceId?: number) => Promise<string>) => void
  setServerUrl?: (url: string) => void
  setUserUuid?: (uuid: string) => void
  setWorkspaceId?: (workspaceId: number | null) => void
  setConfigHelpers?: (update: ConfigHelpersUpdate, get: ConfigHelpersGet) => void
}

const panes = [terminal, explorer, empty, stats, versionControl, notes] as unknown as PaneModule[]

/** Register every pane in the host's shared pane registry. */
export function register(): void {
  for (const pane of panes) pane.register?.()
}

/** Unregister every pane (used on teardown / server switch). */
export function unregister(): void {
  for (const pane of panes) pane.unregister?.()
}

export function setAddonApi(api: PaneAddonApi): void {
  for (const pane of panes) pane.setAddonApi?.(api)
}

export function setTokenProvider(provider: (kind: string, resourceId?: number) => Promise<string>): void {
  for (const pane of panes) pane.setTokenProvider?.(provider)
}

export function setServerUrl(url: string): void {
  for (const pane of panes) pane.setServerUrl?.(url)
}

export function setUserUuid(uuid: string): void {
  for (const pane of panes) pane.setUserUuid?.(uuid)
}

export function setWorkspaceId(workspaceId: number | null): void {
  for (const pane of panes) pane.setWorkspaceId?.(workspaceId)
}

export function setConfigHelpers(update: ConfigHelpersUpdate, get: ConfigHelpersGet): void {
  for (const pane of panes) pane.setConfigHelpers?.(update, get)
}

/**
 * The terminal's settings store, re-exported so the host can push the active
 * app theme into a terminal pane that loads later (see `setTerminalActiveTheme`
 * in the host's pane-runtime).
 */
export { useTerminalSettings } from './panes/terminal'
