/**
 * Post-build guard: every bare import left in dist/index.js must be provided by
 * the host at runtime (the /vendor import map in prod, Vite optimized deps in
 * dev). Anything else would silently 404 in production, so fail the build.
 *
 * Mirrors zem's scripts/build-panes.mjs `assertCoveredByHost`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARED_SPECS } from './shared-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'dist', 'index.js')

/** Bare specifiers the host always provides regardless of shared-runtime.json. */
const HOST_ALWAYS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]

const bundle = readFileSync(entry, 'utf8')
const specShape = /^@?[a-zA-Z][\w.-]*(?:\/[\w.-]+)*$/
const bare = [...bundle.matchAll(/(?:from|import)\s*"([^"]*)"/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('.') && specShape.test(spec))

const missing = [...new Set(bare)].filter(
  (spec) =>
    !HOST_ALWAYS.includes(spec) &&
    !SHARED_SPECS.some((s) => spec === s || spec.startsWith(`${s}/`)),
)

if (missing.length > 0) {
  console.error(
    '[build] external imports not covered by the host contract:',
    missing.join(', '),
    '\n  → add them to shared-runtime.json (host) or stop externalizing them.',
  )
  process.exit(1)
}

console.log(`[build] dist/index.js imports covered by host (${[...new Set(bare)].length} specifiers)`)
