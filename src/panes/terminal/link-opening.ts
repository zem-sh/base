/**
 * Link activation for terminal output.
 *
 * The Ghostty core opens detected URLs with
 * `window.open(url, "_blank", "noopener,noreferrer")`. That is a browser-only
 * path: a Tauri webview (WKWebView/WebView2) does not create windows unless the
 * app opts into it, so a detected link highlights on hover but clicking it does
 * nothing on desktop. Send those opens to the OS instead, and leave every other
 * `window.open` call untouched.
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const TRAILING_PUNCTUATION = /^[.,;:!?'"`]$/
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const SCHEMELESS_WWW = /^www\./i
const SCHEMELESS_LOCALHOST = /^localhost[:/]/i

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type TauriGlobals = {
  invoke?: Invoke
  opener?: { openUrl?: (url: string) => Promise<void> }
  shell?: { open?: (path: string) => Promise<void> }
}

type TauriWindow = Window & {
  __TAURI__?: TauriGlobals
  __TAURI_INTERNALS__?: { invoke?: Invoke }
}

function countOccurrences(value: string, char: string): number {
  let count = 0
  for (const current of value) if (current === char) count += 1
  return count
}

/**
 * Drop punctuation the surrounding prose glued onto a URL, e.g.
 * `(see https://example.com/foo).` or `https://example.com/foo,`. Balanced
 * brackets inside a URL (`…/wiki/Foo_(bar)`) are preserved.
 */
export function trimLinkPunctuation(raw: string): string {
  let value = raw.trim()
  while (value) {
    const last = value[value.length - 1] as string
    const opener = CLOSING_BRACKETS[last]
    if (opener) {
      if (countOccurrences(value, last) <= countOccurrences(value, opener)) break
      value = value.slice(0, -1)
      continue
    }
    if (!TRAILING_PUNCTUATION.test(last)) break
    value = value.slice(0, -1)
  }
  return value
}

function toAbsoluteUrl(raw: string): string {
  const value = trimLinkPunctuation(raw)
  if (!value) return ''
  if (SCHEMELESS_WWW.test(value)) return `https://${value}`
  if (SCHEMELESS_LOCALHOST.test(value)) return `http://${value}`
  return value
}

export function isExternalUrl(raw: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(toAbsoluteUrl(raw)).protocol)
  } catch {
    return false
  }
}

/**
 * Hand a URL to the OS handler (default browser / mail client).
 *
 * Returns false when no desktop bridge is available, which is the normal case
 * in a browser build — callers should fall back to the webview's own behavior.
 */
export function openInSystemBrowser(raw: string): boolean {
  const url = toAbsoluteUrl(raw)
  if (!url || !isExternalUrl(url)) return false

  const target = window as TauriWindow
  const globals = target.__TAURI__

  // Builds with `withGlobalTauri` expose the plugin bindings directly.
  try {
    if (globals?.opener?.openUrl) {
      void globals.opener.openUrl(url).catch(() => {})
      return true
    }
    if (globals?.shell?.open) {
      void globals.shell.open(url).catch(() => {})
      return true
    }
  } catch {
    /* fall through to the raw IPC bridge */
  }

  const invoke = globals?.invoke ?? target.__TAURI_INTERNALS__?.invoke
  if (typeof invoke !== 'function') return false
  // The v2 opener plugin; older shells expose the shell plugin's open command.
  // A `_blank` anchor is the last resort: the opener plugin's injected script
  // (when present) routes those to the default browser as well.
  void invoke('plugin:opener|open_url', { url })
    .catch(() => invoke('plugin:shell|open', { path: url }))
    .catch(() => clickBlankAnchor(url))
  return true
}

function clickBlankAnchor(url: string): void {
  if (typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

let installed = false

/**
 * Intercept the `window.open` calls the terminal core makes for detected links
 * so they reach the desktop's default browser. Idempotent; in a browser the
 * wrapper defers to the native implementation and changes nothing.
 */
export function installExternalLinkOpener(): void {
  if (installed || typeof window === 'undefined' || typeof window.open !== 'function') return
  installed = true
  const nativeOpen = window.open.bind(window)
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : ''
    const opensNewWindow = !target || target === '_blank' || target === '_new'
    if (opensNewWindow && href && isExternalUrl(href) && openInSystemBrowser(href)) return null
    return nativeOpen(url as string | undefined, target, features)
  }) as typeof window.open
}
