/**
 * Mirror the built extension + addon into the host-owned `~/.zem` directory, so
 * a running zem picks them up without a separate install step.
 *
 * Layout written (owned by zem, not by this repo):
 *   ~/.zem/extensions/<pane-manifest id>/  index.js, assets/, pane-manifest.toml
 *   ~/.zem/addon/<addon manifest name>/    addon, manifest.toml
 *
 * Every file is written through a temp sibling + rename: the Tauri gateway and
 * the Vite plugin read this directory while it is being replaced, and a reader
 * must never observe a half-written bundle.
 *
 * `ZEM_HOME` overrides the root (tests, or a non-default install location).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function zemHome() {
  const configured = process.env.ZEM_HOME
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.zem')
}

function copyAtomic(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`
  fs.copyFileSync(source, temporary)
  fs.renameSync(temporary, destination)
}

function writeAtomic(destination, contents) {
  const temporary = `${destination}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents)
  fs.renameSync(temporary, destination)
}

/** First `key = "value"` line of a TOML document (all zem manifests are flat here). */
function tomlString(document, key) {
  const match = document.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))
  if (!match) throw new Error(`manifest has no "${key}"`)
  return match[1]
}

/**
 * Copy `dist/` plus `pane-manifest.toml` to `~/.zem/extensions/<id>`, dropping
 * assets that the new bundle no longer references.
 */
export function syncExtension(root, { log = () => {} } = {}) {
  const manifestPath = path.join(root, 'pane-manifest.toml')
  const id = tomlString(fs.readFileSync(manifestPath, 'utf8'), 'id')
  const target = path.join(zemHome(), 'extensions', id)

  fs.mkdirSync(target, { recursive: true })
  copyAtomic(path.join(root, 'dist', 'index.js'), path.join(target, 'index.js'))
  copyAtomic(manifestPath, path.join(target, 'pane-manifest.toml'))

  const sourceAssets = path.join(root, 'dist', 'assets')
  const assets = fs.existsSync(sourceAssets) ? fs.readdirSync(sourceAssets) : []
  const targetAssets = path.join(target, 'assets')
  fs.mkdirSync(targetAssets, { recursive: true })
  for (const name of assets) {
    copyAtomic(path.join(sourceAssets, name), path.join(targetAssets, name))
  }
  for (const name of fs.readdirSync(targetAssets)) {
    if (!assets.includes(name)) fs.rmSync(path.join(targetAssets, name), { force: true })
  }

  log(`extension ${id} → ${target}`)
  return target
}

/**
 * Copy the release addon binary to `~/.zem/addon/<name>` and regenerate its
 * manifest from the binary itself (`--generate-manifest`), which is the same
 * source the server reads at startup.
 */
export function syncAddon(root, { log = () => {} } = {}) {
  const binary = path.join(root, 'target', 'release', 'addon')
  if (!fs.existsSync(binary)) {
    throw new Error(`missing ${binary} — run \`pnpm build:addon\` first`)
  }

  const manifest = execFileSync(binary, ['--generate-manifest'], { encoding: 'utf8' })
  const name = tomlString(manifest, 'name')
  const target = path.join(zemHome(), 'addon', name)

  fs.mkdirSync(target, { recursive: true })
  copyAtomic(binary, path.join(target, 'addon'))
  fs.chmodSync(path.join(target, 'addon'), 0o755)
  writeAtomic(path.join(target, 'manifest.toml'), manifest)

  log(`addon ${name} → ${target}`)
  return target
}
