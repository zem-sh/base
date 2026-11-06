#!/usr/bin/env node
/**
 * Dev loop for the extension and the addon.
 *
 *   pnpm dev         panes + addon
 *   pnpm dev:pane    panes only (skips the release cargo build, which is slow)
 *
 * Panes: `vite build --watch` owns the rebuild; we watch `dist/index.js` instead
 * of hooking the builder so the host-coverage assertion and the sync always run
 * against files that are fully written. Reload the window to pick up a bundle.
 *
 * Addon: a Rust edit rebuilds `target/release/addon` and regenerates its manifest
 * into `~/.zem/addon`. The server spawns the executable when it starts, so the
 * addon needs `zem` restarted — the script says so when it happens.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncAddon, syncExtension } from './sync-to-zem.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watchAddon = !process.argv.slice(2).includes('--pane-only')

const log = (message) =>
  console.log(`[dev ${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`)

/** Vite prints its own timings; keep its exit from stranding this process. */
const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--watch'],
  { cwd: root, stdio: 'inherit' },
)

const bundle = path.join(root, 'dist', 'index.js')
let paneTimer = null

fs.watchFile(bundle, { interval: 250 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return
  clearTimeout(paneTimer)
  // Vite's watcher has settled by the time the file lands; debounce so a burst
  // of asset writes produces one sync.
  paneTimer = setTimeout(syncPanes, 60)
})

function syncPanes() {
  // Vite empties outDir when a build starts, which is also a change to the
  // watched path — there is nothing to check or copy until it has been written.
  if (!fs.existsSync(bundle)) return

  const guard = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-host-covered.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  if (guard.status !== 0) {
    log('bundle rejected by the host-coverage check — not syncing')
    return
  }

  try {
    syncExtension(root, { log })
    log('reload the window to load the new pane bundle')
  } catch (error) {
    log(`extension sync failed: ${error.message}`)
  }
}

function watchAddonSources() {
  let timer = null
  let building = false
  let pending = false

  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(buildAddon, 300)
  }

  const buildAddon = () => {
    if (building) {
      pending = true
      return
    }
    building = true
    log('building addon (release) — this can take a while')

    const cargo = spawn('cargo', ['build', '--release'], { cwd: root, stdio: 'inherit' })
    cargo.on('exit', (code) => {
      building = false
      if (code === 0) {
        try {
          syncAddon(root, { log })
          log('restart zem to load the new addon')
        } catch (error) {
          log(`addon sync failed: ${error.message}`)
        }
      } else {
        log(`cargo build failed (${code}) — addon not synced`)
      }
      if (pending) {
        pending = false
        buildAddon()
      }
    })
  }

  fs.watch(path.join(root, 'lib'), { recursive: true }, (_event, file) => {
    if (!file || String(file).endsWith('.rs')) trigger()
  })
  fs.watchFile(path.join(root, 'Cargo.toml'), { interval: 500 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs) trigger()
  })
}

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  fs.unwatchFile(bundle)
  vite.kill()
  process.exit(code)
}

vite.on('exit', (code) => {
  if (shuttingDown) return
  log(`vite exited (${code}) — stopping`)
  shutdown(code ?? 1)
})
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

if (watchAddon) {
  watchAddonSources()
  log('watching panes + addon, syncing into ~/.zem')
} else {
  log('watching panes, syncing into ~/.zem')
}
