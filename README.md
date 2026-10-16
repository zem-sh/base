# core-zem

The zem **core** addon + pane extension. This repo merges what used to live as
six separate addon crates and six separate pane packages in the zem monorepo
into **one server addon** and **one web pane extension**:

| Piece | Id | What it does | Installed by |
| --- | --- | --- | --- |
| `lib/` + `Cargo.toml` — **server addon** | `com.zem.core` | Terminal PTY, filesystem, git, GitHub, system stats, notes, status items and all their queries/mutations/actions | zem (built-in) or `zem addon install` → GitHub release |
| `src/` + `package.json` — **web extension** | `zem.core` | The pane UIs for terminal, explorer, empty, stats, version control and notes — one bundle, six pane kinds | `POST /api/extension/install` → GitHub release |

The six pane kinds are `terminal`, `explorer`, `general`, `stats`,
`version-control` and `notes`; both the addon manifest and the pane manifest
declare exactly these, and every pane's `entry` points at the same
`./index.js`.

## Layout

```
base/
├── lib/                    Rust addon sources
│   ├── main.rs             addon definition (id, panes, actions, collections, events)
│   ├── general/
│   ├── stats/
│   ├── terminal/
│   ├── version_control/
│   ├── explorer/
│   └── notes/
├── src/                    Vite/React pane sources
│   ├── index.tsx           merged extension entry (registers all six panes)
│   └── panes/<name>/       per-pane UI, one folder per former package
├── Cargo.toml              Rust package manifest (binary: addon)
├── package.json            JS package manifest (pane bundle)
├── pane-manifest.toml      extension install manifest (six [[pane]] entries)
├── shared-runtime.json     host-provided package contract (externals)
├── scripts/                shared-runtime helper + post-build import guard
├── vite.config.ts
├── tsconfig.json
└── .github/workflows/      release pipeline
```

The zem monorepo packages this repo depends on (`zem-addon-sdk`, `@zem-sh/pane`,
`@zem-sh/keybinding`, `@zem-sh/terminal`) are consumed as regular registry
dependencies — nothing is vendored.

## Build

```sh
# server addon (release binary at target/release/addon)
cargo build --release
cargo test

# web pane bundle (dist/index.js + dist/assets/*.ttf)
pnpm install
pnpm build
```

`pnpm build` runs Vite and then `scripts/assert-host-covered.mjs`, which fails
the build if `dist/index.js` imports any bare specifier the host does not
provide (see `shared-runtime.json`). A stray external import would silently 404
against the host import map in production, so it is a hard build error.

Generate the addon manifest from code (the release pipeline does this):

```sh
./target/release/addon --generate-manifest
```

## Release

Push a version tag; CI builds everything and publishes a GitHub Release:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The repo must be **public**: zem's installers download release assets
unauthenticated, so a private repo would 404 on install.

### Release asset contract

zem's installers resolve these asset names — do not rename them:

| Asset | Consumed by |
| --- | --- |
| `core-macos` / `core-linux` | addon installer (`{name}-{os}`, os = Rust `std::env::consts::OS`) |
| `zem-addon-manifest.toml` | addon installer (exact name required) |
| `pane-manifest.toml` | extension installer (exact name required) |
| `index.js` | extension installer (the `pane.entry` from pane-manifest) |
| `*.ttf` (flat) | terminal font store — see the font caveat below |

**Upload order matters**: the server infers the addon name from the *first*
release asset (text before the last `-`), so the platform binaries must be
uploaded first (`core-macos` → `core`). The release workflow enforces this
order.

### Font assets caveat

The terminal pane loads nine font files (~16 MB) referenced as
`new URL("assets/<name>.ttf", import.meta.url)`; Vite emits them to
`dist/assets/` and, at runtime, they resolve next to `index.js`
(`/api/extension/zem.core/assets/<name>.ttf`). The server can already serve
them, but **zem's extension installer currently downloads only each pane's
`entry` and optional `style`** — it does not fetch side assets, so a
GitHub/npm install leaves the fonts missing (and GitHub release asset names
cannot contain `/`, so the `assets/` path cannot round-trip as-is). The release
workflow still uploads the fonts (flattened to their base names) so they are
available; see *zem host integration* for the required installer change.

## Install (server addon)

```sh
# latest release
zem addon install <owner>/base

# a specific version (tag must be v{version})
zem addon install <owner>/base@1.0.0
```

Then **restart the zem server** — the addon manager only loads addons from
`~/.zem/addon/` at startup, so a freshly installed addon appears after a restart.

> The addon id `com.zem.core` sits in the `com.zem.` namespace, which zem treats
> as a **built-in core addon**: its collections are never pruned as stale and
> the API refuses to uninstall it (`AddonManager::is_core_addon`). That is the
> intent for this repo — it *is* zem's core addon. A release-installed copy is
> therefore not removable through the API.

## Install (web extension)

Admin only (header = an admin user's UUID from `~/.zem/connections.json`):

```sh
curl -X POST http://127.0.0.1:50051/api/extension/install \
  -H "Content-Type: application/json" \
  -H "X-User-UUID: <admin-uuid>" \
  -d '{"source":"<owner>/base"}'
```

Verify / manage:

```sh
curl -H "X-User-UUID: <admin-uuid>" http://127.0.0.1:50051/api/extension
curl -X DELETE -H "X-User-UUID: <admin-uuid>" \
  http://127.0.0.1:50051/api/extension/zem.core
```

The files land in `~/.zem/extensions/zem.core/` and are served at
`/api/extension/zem.core/index.js`.

## zem host integration

This repo is the extract of zem's built-in core panes, so zem's web client and
addon dispatch need small, deliberate changes to consume it as a *single*
extension/addon instead of six:

1. **`apps/web/src/lib/builtin-panes.ts`** — `BUILT_IN_PANE_DEFS` currently
   lists six panes with six distinct extension ids (`zem.terminal-pane`, …).
   Replace them with six entries that all share `id: 'zem.core'` (one entry per
   `kind`), since `paneEntryUrl` builds `<id>/index.js` and one bundle now
   backs every kind.
2. **`apps/web/src/lib/pane-setup.ts`** — `runPaneQuery` / `runPaneMutation`
   pass `addon: paneKind`. The server's `dispatch_operation` resolves `addon`
   through `entry_for_id` (id or `short_key`), which will not match the kind, so
   pass `addon: ''` instead: the server then falls back to `entry_for_pane`,
   which is what routes a shared bundle by pane kind.
3. **Extension installer** (`crates/zem/src/extensions/mod.rs`) — teach both
   `install_from_github` and the npm/esm.sh path to also fetch the extension's
   static assets. Release assets are flat, so the follow-up is to add an asset
   list to the pane manifest (e.g. `assets = ["assets/*.ttf"]`) and download
   each matched release asset into `<ext_dir>/<relative path>`.
4. **Migrations / seeded rows** — zem seeds collections, rules and status items
   keyed by the old per-addon ids (`com.zem.terminal`, `com.zem.explorer`,
   `com.zem.notes` in `crates/zem/migrations/*.sql` and the terminal `agents`
   status-bar action). Those keys must move to `com.zem.core` so the merged
   addon's collections (id becomes `com.zem.core:agent`, …) and status item
   attach to the surviving rows instead of orphaning them.

Until (1) and (3) land, installing `zem.core` puts the manifest and bundle in
place and the catalog/serve endpoints work, but the panes will not appear in the
web UI and the terminal fonts will 404.
