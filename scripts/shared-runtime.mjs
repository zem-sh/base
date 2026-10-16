/**
 * Shared runtime contract helper. The canonical list lives in shared-runtime.json;
 * pane builds externalize these packages and the host provides them.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'shared-runtime.json'), 'utf8'))

export const SHARED_SPECS = [...manifest.packages, ...manifest.subpaths]

/** True when a module id is a host-provided shared package (or a subpath of one). */
export function isSharedExternal(id) {
  return SHARED_SPECS.some((spec) => id === spec || id.startsWith(`${spec}/`))
}
