import { useState, useEffect, useRef, useCallback } from 'react'
import type { Terminal } from '@zem-sh/terminal'

// ── Vim mode for terminal scrollback ──────────────────────────────────────────
//
// Enter via Ctrl+K or typing "jk" fast (only when already scrolled back).
// Vim motions are intercepted via a capture-phase keydown listener on window —
// this runs before the keybinding engine and the terminal's own handler, so
// we can reliably swallow keys with preventDefault + stopImmediatePropagation.

type VimMode = 'NORMAL' | 'VISUAL' | 'VISUAL_LINE'
type TerminalMode = 'INSERT' | VimMode

function setGlobalTerminalMode(paneId: number, mode: TerminalMode | null): void {
  ;(window as any).__zemSetTerminalMode?.(paneId, mode)
}

function getEngine(): any {
  return (window as any).__zemKeybindingEngine
}

const TRIGGER_BINDING_ID = 'local:terminal-vim:trigger'

// ── Word boundary helpers ────────────────────────────────────────────────────

function isWordChar(ch: string): boolean {
  return ch !== ' ' && ch !== '\t'
}

function findNextWordStart(line: string, fromCol: number): number {
  let i = fromCol
  while (i < line.length && isWordChar(line[i])) i++
  while (i < line.length && !isWordChar(line[i])) i++
  return Math.min(i, line.length)
}

function findPrevWordStart(line: string, fromCol: number): number {
  if (fromCol <= 0) return 0
  let i = fromCol - 1
  while (i > 0 && !isWordChar(line[i])) i--
  while (i > 0 && isWordChar(line[i - 1])) i--
  return Math.max(0, i)
}

function findWordEnd(line: string, fromCol: number): number {
  if (!line.length) return 0

  let col = Math.max(0, Math.min(line.length - 1, fromCol))
  // Vim's `e` moves to the end of the current word on the first press, then
  // to the end of the next word on subsequent presses. If already at a word's
  // end, start scanning after that word instead of returning the same column.
  if (isWordChar(line[col])) {
    let currentEnd = col
    while (currentEnd + 1 < line.length && isWordChar(line[currentEnd + 1])) currentEnd++
    if (currentEnd > col) return currentEnd
    col = currentEnd + 1
  }

  while (col < line.length && !isWordChar(line[col])) col++
  if (col >= line.length) {
    // Keep the cursor on the last real character when there is no later word.
    for (let i = line.length - 1; i >= 0; i--) {
      if (isWordChar(line[i])) return i
    }
    return 0
  }

  let end = col
  while (end + 1 < line.length && isWordChar(line[end + 1])) end++
  return end
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t'
}

function findWordObjectRange(line: string, fromCol: number, around: boolean): { start: number; end: number } | null {
  const content = line.replace(/[ 	]+$/, '')
  if (!content.length) return null

  let col = Math.max(0, Math.min(content.length - 1, fromCol))
  // On whitespace, use the next word when one exists; at the end of a line,
  // fall back to the previous word. This keeps yiw useful on padded cells.
  if (!isWordChar(content[col])) {
    let next = col
    while (next < content.length && !isWordChar(content[next])) next++
    if (next < content.length) col = next
    else {
      let previous = col - 1
      while (previous >= 0 && !isWordChar(content[previous])) previous--
      if (previous < 0) return null
      col = previous
    }
  }

  let start = findPrevWordStart(content, col)
  let end = findWordEnd(content, col)
  if (!isWordChar(content[start]) || !isWordChar(content[end])) return null

  if (around) {
    // Include one separating run, preferring the following run only when it
    // leads to another word; never consume the terminal's padded tail.
    let nextWord = end + 1
    while (isWhitespace(content[nextWord])) nextWord++
    if (nextWord < content.length) {
      while (isWhitespace(content[end + 1])) end++
    } else {
      while (isWhitespace(content[start - 1])) start--
    }
  }
  return { start, end }
}

function findEnclosingPair(
  line: string,
  fromCol: number,
  open: string,
  close: string,
): { open: number; close: number } | null {
  const col = Math.max(0, Math.min(line.length - 1, fromCol))
  // If the cursor is on a closing delimiter, include that delimiter in the
  // reverse match instead of treating it as an unmatched nested close.
  const startedOnClose = line[col] === close
  let depth = startedOnClose ? 1 : 0
  let openIndex = -1
  const scanStart = startedOnClose ? col - 1 : col
  for (let i = scanStart; i >= 0; i--) {
    if (line[i] === close) {
      depth++
    } else if (line[i] === open) {
      if (depth === 0) {
        // With the cursor inside content, the first opening delimiter at
        // depth zero is the nearest enclosing pair. If the cursor is on a
        // closing delimiter, its matching opening delimiter is reached when
        // the initial synthetic depth is consumed.
        openIndex = i
        break
      }
      depth--
      if (startedOnClose && depth === 0) {
        openIndex = i
        break
      }
    }
  }
  if (openIndex < 0) return null

  depth = 1
  for (let i = openIndex + 1; i < line.length; i++) {
    if (line[i] === open) depth++
    else if (line[i] === close) {
      depth--
      if (depth === 0) return { open: openIndex, close: i }
    }
  }
  return null
}

function resolvePairObject(
  line: string,
  fromCol: number,
  object: string,
  around: boolean,
): { start: number; end: number } | null {
  const pairs: Record<string, [string, string]> = {
    '[': ['[', ']'], ']': ['[', ']'],
    '(': ['(', ')'], ')': ['(', ')'],
    '{': ['{', '}'], '}': ['{', '}'],
    '<': ['<', '>'], '>': ['<', '>'],
  }
  const pair = pairs[object]
  if (!pair) return null
  const enclosing = findEnclosingPair(line, fromCol, pair[0], pair[1])
  if (!enclosing) return null
  return {
    start: around ? enclosing.open : enclosing.open + 1,
    end: around ? enclosing.close : enclosing.close - 1,
  }
}

// ── Key matching ─────────────────────────────────────────────────────────────

interface VimKey {
  key: string
  ctrl?: boolean
  shift?: boolean
}

function matchKey(e: KeyboardEvent, def: VimKey): boolean {
  const ek = e.key?.toLowerCase?.() ?? ''
  const dk = def.key.toLowerCase()
  if (ek !== dk) return false
  if (!!def.ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (!!def.shift !== e.shiftKey) return false
  // Don't match when Alt is held (Alt+key are different bindings)
  if (e.altKey) return false
  return true
}

// ── Single-chord mappings (dispatch immediately) ─────────────────────────────

const SINGLE_KEYS: Array<{ def: VimKey; action: string }> = [
  { def: { key: 'j' },                   action: 'moveDown' },
  { def: { key: 'k' },                   action: 'moveUp' },
  { def: { key: 'h' },                   action: 'moveLeft' },
  { def: { key: 'l' },                   action: 'moveRight' },
  { def: { key: 'w' },                   action: 'nextWord' },
  { def: { key: 'b' },                   action: 'prevWord' },
  { def: { key: 'e' },                   action: 'wordEnd' },
  // Lowercase g is a prefix for gg; it has no standalone action.
  { def: { key: 'g' },                   action: 'pendingGoTop' },
  { def: { key: 'i' },                   action: 'enterInsert' },
  { def: { key: '0' },                   action: 'lineStart' },
  { def: { key: '$' },                   action: 'lineEnd' },
  { def: { key: 'd', ctrl: true },       action: 'halfDown' },
  { def: { key: 'u', ctrl: true },       action: 'halfUp' },
  { def: { key: 'f', ctrl: true },       action: 'pageDown' },
  { def: { key: 'b', ctrl: true },       action: 'pageUp' },
  { def: { key: 'v' },                   action: 'enterVisual' },
  { def: { key: 'v', shift: true },      action: 'enterVisualLine' },
  { def: { key: 'y' },                   action: 'yank' },
  { def: { key: '/' },                   action: 'searchOpen' },
  { def: { key: 'n' },                   action: 'searchNext' },
  { def: { key: 'n', shift: true },      action: 'searchPrev' },
  { def: { key: 'escape' },              action: 'exitVim' },
  // G goes to the last meaningful terminal row; gg is handled by the two-chord logic below
  { def: { key: 'g', shift: true },      action: 'goBottom' },
]

// ── Two-chord sequences (e.g. gg) ────────────────────────────────────────────
// We track the first chord and a short timeout; if the second chord arrives
// within GAP_MS we dispatch the sequence action; otherwise dispatch the
// first chord as a fallback (for single-chord bindings).

const GAP_MS = 400

const TWO_CHORD: Array<{ seq: [VimKey, VimKey]; action: string }> = [
  { seq: [{ key: 'g' }, { key: 'g' }], action: 'goTop' },
]

// Find a single-chord action (excluding keys that start two-chord sequences).
// For keys like 'g' that may start a sequence, we return the pending action.
function findSingleAction(e: KeyboardEvent): string | null {
  for (const { def, action } of SINGLE_KEYS) {
    if (matchKey(e, def)) return action
  }
  return null
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseTerminalVimModeOptions {
  paneId: number
  isFocused: boolean
  terminalRef: React.RefObject<Terminal | null>
  setSearchOpen: (v: boolean) => void
  vimModeEnabled: boolean
  jkTriggerMs: number
  vimTriggerSequence: string
  yankExitsVimMode: boolean
  vimDisabledInAltScreen: boolean
  vimDisabledApps: string
  altScreenActive: boolean
  currentTitleApp: string
}

function matchesDisabledApp(title: string, disabledApps: string): boolean {
  if (!disabledApps.trim() || !title) return false
  const apps = disabledApps.split(',').map(a => a.trim()).filter(Boolean)
  if (!apps.length) return false
  const lowerTitle = title.toLowerCase()
  return apps.some(app => lowerTitle.includes(app))
}

export function useTerminalVimMode({
  paneId,
  isFocused,
  terminalRef,
  setSearchOpen,
  vimModeEnabled,
  jkTriggerMs,
  vimTriggerSequence,
  yankExitsVimMode,
  vimDisabledInAltScreen,
  vimDisabledApps,
  altScreenActive,
  currentTitleApp,
}: UseTerminalVimModeOptions) {
  const [vimMode, setVimMode] = useState<VimMode>('NORMAL')
  const [vimActive, setVimActive] = useState(false)
  const [scrollbackPercent, setScrollbackPercent] = useState(0)

  const scrollPercentRafRef = useRef<number | null>(null)
  const bottomCursorRafRef = useRef<number | null>(null)
  // WASM scrollbar offsets can settle in a later renderer frame than the
  // keydown handler. Keep the logical Vim viewport locally so the status bar
  // updates from the same motion that changes the viewport.
  const logicalViewportOffsetRef = useRef<number | null>(null)
  const visualAnchorAbsRowRef = useRef(0)
  const vimCursorColRef = useRef(0)
  const vimCursorRowRef = useRef(0)
  const visualAnchorColRef = useRef(0)
  const vimModeRef = useRef(vimMode)
  vimModeRef.current = vimMode
  const vimActiveRef = useRef(vimActive)
  vimActiveRef.current = vimActive
  const isFocusedRef = useRef(isFocused)
  isFocusedRef.current = isFocused
  const publishTerminalMode = useCallback((mode: TerminalMode | null) => {
    // A delayed operation from an unfocused pane must not overwrite the mode
    // published by the pane that currently owns the app focus.
    if (mode !== null && !isFocusedRef.current) return
    setGlobalTerminalMode(paneId, mode)
  }, [paneId])
  const triggerProgressRef = useRef(0)
  const triggerLastAtRef = useRef(0)
  const triggerBufferRef = useRef('')
  const triggerTimerRef = useRef<number | null>(null)
  const suppressedTriggerKeyupsRef = useRef(new Set<string>())

  // Restore characters consumed while attempting the fast trigger. The first
  // trigger key must be swallowed so it cannot reach the shell and auto-follow
  // the terminal back to the live prompt; only failed attempts are replayed.
  const replayTriggerBuffer = useCallback(() => {
    if (triggerTimerRef.current !== null) {
      clearTimeout(triggerTimerRef.current)
      triggerTimerRef.current = null
    }
    const buffered = triggerBufferRef.current
    triggerBufferRef.current = ''
    triggerProgressRef.current = 0
    triggerLastAtRef.current = 0
    // Keep consumed key identities until their physical keyup events arrive;
    // otherwise a delayed keyup can leak into the terminal after replay.
    if (buffered) terminalRef.current?.sendKeyInput(buffered, 'key')
  }, [])

  const discardTriggerBuffer = useCallback(() => {
    if (triggerTimerRef.current !== null) {
      clearTimeout(triggerTimerRef.current)
      triggerTimerRef.current = null
    }
    triggerBufferRef.current = ''
    triggerProgressRef.current = 0
    triggerLastAtRef.current = 0
    suppressedTriggerKeyupsRef.current.clear()
  }, [])

  const finishTriggerBuffer = useCallback(() => {
    if (triggerTimerRef.current !== null) {
      clearTimeout(triggerTimerRef.current)
      triggerTimerRef.current = null
    }
    triggerBufferRef.current = ''
    triggerProgressRef.current = 0
    triggerLastAtRef.current = 0
    // Keep suppressed key identities until their keyup events are consumed.
  }, [])

  // Two-chord sequence state (currently used by gg).
  const pendingRef = useRef<{ action: string; timer: number } | null>(null)
  // Operator-pending state for yank and visual text objects such as yiw,
  // viw, ya[, and va[.
  const operatorPendingRef = useRef<{
    operation: 'yank' | 'visual'
    around: boolean | null
    timer: number
  } | null>(null)
  const vimOperationRef = useRef(0)

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getScrollInfo = useCallback(() => {
    const t = terminalRef.current
    if (!t) return { totalLines: 0, viewportOffset: 0, viewportLen: 0 }
    return t.getScrollbackInfo()
  }, [])

  const getViewportRows = useCallback(() => {
    const info = getScrollInfo()
    return Math.max(1, info.viewportLen || 24)
  }, [getScrollInfo])

  const getCursorAbsRow = useCallback(() => {
    return getScrollInfo().viewportOffset
  }, [getScrollInfo])

  const getLineText = useCallback((viewportRow: number): string => {
    const t = terminalRef.current
    if (!t) return ''
    const lines = t.getViewportText()
    const idx = viewportRow
    if (idx < 0 || idx >= lines.length) return ''
    return lines[idx]
  }, [])

  const getLastMeaningfulViewportRow = useCallback(() => {
    const info = getScrollInfo()
    const lines = terminalRef.current?.getViewportText() ?? []
    const visibleRows = Math.max(1, info.viewportLen || lines.length || getViewportRows())
    for (let row = Math.min(visibleRows, lines.length) - 1; row >= 0; row--) {
      if (lines[row].trim().length > 0) return row
    }
    return 0
  }, [getScrollInfo, getViewportRows])

  const updateScrollPercent = useCallback(() => {
    const readScrollPercent = () => {
      const info = getScrollInfo()
      // Report the Vim cursor's absolute position, not just the viewport
      // offset. `j`/`k` often move within the visible viewport without
      // changing that offset, so using only the offset made the display stay
      // at 0% while the cursor visibly moved.
      const viewportLines = terminalRef.current?.getViewportText() ?? []
      const visibleRows = Math.max(1, info.viewportLen || viewportLines.length || getViewportRows())
      // getViewportText preserves the terminal grid, including blank rows
      // below the last printed line. Exclude only that trailing padding from
      // the percentage range; internal blank lines remain meaningful.
      const lastMeaningfulRow = getLastMeaningfulViewportRow()
      const meaningfulRows = Math.max(1, lastMeaningfulRow + 1)
      const trailingEmptyRows = Math.max(0, visibleRows - meaningfulRows)
      const logicalOffset = Math.max(0, logicalViewportOffsetRef.current ?? info.viewportOffset)
      // During startup or with older WASM builds, scrollbar metadata can be
      // temporarily zero even though the terminal viewport is usable. Fall
      // back to a locally tracked range instead of forcing the status to 0%.
      // As Vim scrolls farther, the fallback range grows with the viewport.
      const reportedTotalRows = Number.isFinite(info.totalLines) ? info.totalLines : 0
      const totalRows = Math.max(
        meaningfulRows,
        reportedTotalRows - trailingEmptyRows,
        logicalOffset + meaningfulRows,
      )
      const maxOffset = Math.max(0, totalRows - meaningfulRows)
      const viewportOffset = Math.max(0, Math.min(maxOffset, logicalOffset))
      // If the synthetic cursor is in blank padding below the output, keep the
      // percentage anchored to the last meaningful row instead of counting it.
      const row = Math.max(0, Math.min(meaningfulRows - 1, vimCursorRowRef.current))
      const absoluteRow = viewportOffset + row
      const maxRow = Math.max(0, totalRows - 1)
      if (maxRow <= 0) {
        setScrollbackPercent(0)
        return
      }
      setScrollbackPercent(Math.round((Math.max(0, Math.min(maxRow, absoluteRow)) / maxRow) * 100))
    }

    // Update immediately from the logical Vim position. The deferred read
    // keeps the display correct if the terminal was scrolled by another input
    // path and the WASM scrollbar state has just become available.
    readScrollPercent()
    if (scrollPercentRafRef.current !== null) {
      cancelAnimationFrame(scrollPercentRafRef.current)
    }
    scrollPercentRafRef.current = requestAnimationFrame(() => {
      scrollPercentRafRef.current = null
      readScrollPercent()
    })
  }, [getScrollInfo, getViewportRows, getLastMeaningfulViewportRow])

  const scrollViewport = useCallback((delta: number) => {
    if (!Number.isFinite(delta)) return
    const info = getScrollInfo()
    const hasUsableScrollbar = info.totalLines > 0 && info.viewportLen > 0
    const maxOffset = hasUsableScrollbar ? Math.max(0, info.totalLines - info.viewportLen) : Number.POSITIVE_INFINITY
    const currentOffset = Math.max(
      0,
      Math.min(maxOffset, logicalViewportOffsetRef.current ?? info.viewportOffset),
    )
    const targetOffset = hasUsableScrollbar
      ? Math.max(0, Math.min(maxOffset, currentOffset + Math.trunc(delta)))
      : Math.max(0, currentOffset + Math.trunc(delta))
    logicalViewportOffsetRef.current = targetOffset
    if (targetOffset !== currentOffset) {
      terminalRef.current?.scrollViewport(targetOffset - currentOffset)
    }
    updateScrollPercent()
  }, [getScrollInfo, updateScrollPercent])

  const updateVimCursorHighlight = useCallback(() => {
    const t = terminalRef.current
    if (!t) return
    const info = getScrollInfo()
    const lines = t.getViewportText()
    const row = Math.max(0, Math.min(Math.max(0, info.viewportLen - 1), vimCursorRowRef.current))
    // Viewport lines preserve the terminal grid width, so clamp only to the
    // actual cell range. This keeps `w` from creating an invisible col==cols
    // selection while allowing `l` to cross trailing blank cells.
    const colLimit = Math.max(0, (lines[row]?.length ?? 1) - 1)
    const col = Math.max(0, Math.min(colLimit, Math.floor(vimCursorColRef.current)))
    vimCursorRowRef.current = row
    vimCursorColRef.current = col
    // The terminal has no separate overlay-cursor API. A one-cell selection
    // gives NORMAL mode a visible cursor without sending anything to the PTY.
    t.setSelection({ row, col }, { row, col })
  }, [getScrollInfo])

  const updateVisualSelection = useCallback(() => {
    const t = terminalRef.current
    if (!t) return
    const info = getScrollInfo()
    const cursorAbsRow = info.viewportOffset + vimCursorRowRef.current
    const anchorAbsRow = visualAnchorAbsRowRef.current
    const anchorCol = visualAnchorColRef.current
    const cursorCol = vimCursorColRef.current
    // Selection coordinates are viewport-relative. Project both absolute
    // endpoints into the currently rendered viewport.
    const anchorRow = anchorAbsRow - info.viewportOffset
    const cursorRow = cursorAbsRow - info.viewportOffset
    const forward = cursorAbsRow > anchorAbsRow ||
      (cursorAbsRow === anchorAbsRow && cursorCol >= anchorCol)
    const startRow = forward ? anchorRow : cursorRow
    const endRow = forward ? cursorRow : anchorRow
    if (vimModeRef.current === 'VISUAL_LINE') {
      // Linewise visual mode always spans both edges of every affected row;
      // it must not stop at the current character column.
      t.setSelection({ row: startRow, col: 0 }, { row: endRow, col: Number.MAX_SAFE_INTEGER })
      return
    }
    const startCol = forward ? anchorCol : cursorCol
    const endCol = forward ? cursorCol : anchorCol
    t.setSelection({ row: startRow, col: startCol }, { row: endRow, col: endCol })
  }, [getScrollInfo])

  const placeCursorAtLastMeaningfulRow = useCallback(() => {
    vimCursorRowRef.current = getLastMeaningfulViewportRow()
    if (vimModeRef.current !== 'NORMAL') updateVisualSelection()
    else updateVimCursorHighlight()
    updateScrollPercent()
  }, [getLastMeaningfulViewportRow, updateVisualSelection, updateVimCursorHighlight, updateScrollPercent])

  // ── Entry / exit ───────────────────────────────────────────────────────────
  const isVimDisabled = useCallback(() => {
    if (!vimModeEnabled) return true
    if (vimDisabledInAltScreen && altScreenActive) return true
    if (matchesDisabledApp(currentTitleApp, vimDisabledApps)) return true
    return false
  }, [vimModeEnabled, vimDisabledInAltScreen, altScreenActive, currentTitleApp, vimDisabledApps])

  const enterVimMode = useCallback((fromFastTrigger = false) => {
    if (isVimDisabled()) return
    // The global engine only owns the Ctrl+K entry binding. Plain Vim keys do
    // not match its leader-prefixed bindings, so leave its suspension state
    // untouched; other UI code may be using that shared engine too.
    terminalRef.current?.focus()
    // A direct Ctrl+K entry cancels any partially matched fast-trigger
    // sequence. Discard it because Ctrl+K is an explicit replacement trigger.
    // A completed fast trigger uses finishTriggerBuffer instead, preserving
    // the completing key's suppressed keyup until the browser delivers it.
    if (fromFastTrigger) finishTriggerBuffer()
    else discardTriggerBuffer()
    // Keep the completing key's keyup suppressed while Vim starts; clearing it
    // here would allow report-events mode to leak that key to the shell.
    // Update refs synchronously as well as React state. The Ctrl+K event is
    // handled by the global keybinding engine before this hook's capture
    // listener gets the same event, and a fast follow-up h/j/k/l must already
    // belong to Vim even before React commits the status-bar render.
    vimOperationRef.current += 1
    vimActiveRef.current = true
    vimModeRef.current = 'NORMAL'
    publishTerminalMode('NORMAL')
    setVimActive(true)
    setVimMode('NORMAL')
    const cursor = terminalRef.current?.getCursorPosition()
    const info = getScrollInfo()
    const lines = terminalRef.current?.getViewportText() ?? []
    // Cursor rows are terminal-grid coordinates. Do not use the trimmed text
    // array to determine the limit; blank rows are still real viewport cells.
    const rowLimit = Math.max(0, (info.viewportLen || lines.length || 1) - 1)
    const row = Math.max(0, Math.min(rowLimit, Math.floor(cursor?.row ?? 0)))
    // The terminal cursor may be in an empty/trailing cell. Do not clamp to
    // the trimmed text length; selection rendering clamps to the actual grid.
    const col = Math.max(0, Math.floor(cursor?.col ?? 0))
    vimCursorColRef.current = col
    vimCursorRowRef.current = row
    // The cursor row is viewport-relative. Keep the anchor absolute so visual
    // mode remains stable while the viewport scrolls.
    visualAnchorAbsRowRef.current = info.viewportOffset + row
    visualAnchorColRef.current = col
    const hasUsableScrollbar = info.totalLines > 0 && info.viewportLen > 0
    logicalViewportOffsetRef.current = hasUsableScrollbar
      ? Math.max(0, Math.min(Math.max(0, info.totalLines - info.viewportLen), info.viewportOffset))
      : Math.max(0, info.viewportOffset)
    updateScrollPercent()
    updateVimCursorHighlight()
  }, [getScrollInfo, updateScrollPercent, updateVimCursorHighlight, discardTriggerBuffer, finishTriggerBuffer, paneId, publishTerminalMode, isVimDisabled])

  const exitVimMode = useCallback(() => {
    vimOperationRef.current += 1
    vimActiveRef.current = false
    if (bottomCursorRafRef.current !== null) {
      cancelAnimationFrame(bottomCursorRafRef.current)
      bottomCursorRafRef.current = null
    }
    vimModeRef.current = 'NORMAL'
    setVimActive(false)
    setVimMode('NORMAL')
    terminalRef.current?.clearSelection()
    // Scroll back to the live cursor position. Compute the exact distance
    // from the current scrollback offset to the live end rather than passing
    // a huge delta that could overflow the WASM's 32-bit integer parameter.
    const info = getScrollInfo()
    const maxOffset = Math.max(0, (info.totalLines || 0) - (info.viewportLen || 0))
    const delta = maxOffset - info.viewportOffset
    if (delta > 0) terminalRef.current?.scrollViewport(delta)
    terminalRef.current?.focus()
    logicalViewportOffsetRef.current = null
    publishTerminalMode(isFocusedRef.current ? 'INSERT' : null)
  }, [paneId, publishTerminalMode, getScrollInfo])

  // ── Auto-exit when vim mode becomes disabled (e.g. alt screen entered) ────
  useEffect(() => {
    if (vimActiveRef.current && isVimDisabled()) {
      exitVimMode()
    }
  }, [altScreenActive, currentTitleApp, vimDisabledInAltScreen, vimDisabledApps, vimModeEnabled, exitVimMode, isVimDisabled])

  const resolveTextObjectRange = useCallback((object: string, around: boolean) => {
    const line = getLineText(vimCursorRowRef.current)
    return object === 'w'
      ? findWordObjectRange(line, vimCursorColRef.current, around)
      : resolvePairObject(line, vimCursorColRef.current, object, around)
  }, [getLineText])

  const yankTextObject = useCallback((object: string, around: boolean) => {
    const t = terminalRef.current
    if (!t) return
    const range = resolveTextObjectRange(object, around)
    if (!range || range.end < range.start) return

    // Selection APIs use viewport-relative coordinates. The current Vim
    // cursor row is already in that coordinate frame.
    t.setSelection(
      { row: vimCursorRowRef.current, col: range.start },
      { row: vimCursorRowRef.current, col: range.end },
    )
    // The text extraction inside copySelectionToClipboard is synchronous, but
    // wait for the clipboard operation before clearing the selection so this
    // remains safe if the clipboard implementation changes its timing.
    void (async () => {
      const operation = vimOperationRef.current
      try {
        await t.copySelectionToClipboard()
      } finally {
        t.clearSelection()
        if (operation !== vimOperationRef.current || !vimActiveRef.current) return
        if (yankExitsVimMode) exitVimMode()
        else updateVimCursorHighlight()
      }
    })().catch(() => {})
  }, [resolveTextObjectRange, yankExitsVimMode, exitVimMode, updateVimCursorHighlight])

  const selectVisualTextObject = useCallback((object: string, around: boolean) => {
    const range = resolveTextObjectRange(object, around)
    if (!range || range.end < range.start) return

    // Visual text objects replace the current visual range with the resolved
    // object while keeping Vim in VISUAL mode so `y` can copy it afterward.
    visualAnchorAbsRowRef.current = getCursorAbsRow() + vimCursorRowRef.current
    visualAnchorColRef.current = range.start
    vimCursorColRef.current = range.end
    updateVisualSelection()
  }, [resolveTextObjectRange, getCursorAbsRow, updateVisualSelection])

  // ── Dispatch a named action ────────────────────────────────────────────────
  const dispatchAction = useCallback((name: string) => {
    const t = terminalRef.current
    const mode = vimModeRef.current
    switch (name) {
      case 'moveDown': {
        const lastRow = Math.max(0, getViewportRows() - 1)
        if (vimCursorRowRef.current < lastRow) {
          // Move through the currently visible terminal text first. This is
          // important even when there is no scrollback: j/k must still have a
          // visible effect inside a single viewport.
          vimCursorRowRef.current += 1
        } else {
          // At the bottom edge, reveal newer lines toward the shell prompt.
          scrollViewport(1)
        }
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        updateScrollPercent()
        break
      }
      case 'moveUp': {
        if (vimCursorRowRef.current > 0) {
          vimCursorRowRef.current -= 1
        } else {
          // At the top edge, reveal older scrollback. Ghostty's negative
          // viewport delta moves toward the beginning of scrollback.
          scrollViewport(-1)
        }
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        updateScrollPercent()
        break
      }
      case 'moveLeft':
        vimCursorColRef.current = Math.max(0, vimCursorColRef.current - 1)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      case 'moveRight': {
        const line = getLineText(vimCursorRowRef.current)
        vimCursorColRef.current = Math.min(Math.max(0, line.length - 1), vimCursorColRef.current + 1)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      }
      case 'nextWord': {
        const line = getLineText(vimCursorRowRef.current)
        vimCursorColRef.current = findNextWordStart(line, vimCursorColRef.current)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      }
      case 'prevWord': {
        const line = getLineText(vimCursorRowRef.current)
        vimCursorColRef.current = findPrevWordStart(line, vimCursorColRef.current)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      }
      case 'wordEnd': {
        const line = getLineText(vimCursorRowRef.current)
        vimCursorColRef.current = findWordEnd(line, vimCursorColRef.current)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      }
      case 'lineStart':
        vimCursorColRef.current = 0
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      case 'lineEnd': {
        const line = getLineText(vimCursorRowRef.current)
        vimCursorColRef.current = Math.max(0, line.length - 1)
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        break
      }
      case 'halfDown': {
        const rows = getViewportRows()
        scrollViewport(Math.max(1, Math.floor(rows / 2)))
        if (mode !== 'NORMAL') updateVisualSelection()
        updateScrollPercent()
        break
      }
      case 'halfUp': {
        const rows = getViewportRows()
        scrollViewport(-Math.max(1, Math.floor(rows / 2)))
        if (mode !== 'NORMAL') updateVisualSelection()
        updateScrollPercent()
        break
      }
      case 'pageDown':
        scrollViewport(getViewportRows())
        if (mode !== 'NORMAL') updateVisualSelection()
        updateScrollPercent()
        break
      case 'pageUp':
        scrollViewport(-getViewportRows())
        if (mode !== 'NORMAL') updateVisualSelection()
        updateScrollPercent()
        break
      case 'pendingGoTop':
        // A lone g is only a prefix for gg; do nothing if the sequence times out.
        break
      case 'goTop': {
        const info = getScrollInfo()
        const hasUsableScrollbar = info.totalLines > 0 && info.viewportLen > 0
        const maxOffset = Math.max(0, info.totalLines - info.viewportLen)
        const currentOffset = logicalViewportOffsetRef.current ?? info.viewportOffset
        const targetOffset = hasUsableScrollbar ? maxOffset : 0
        if (currentOffset !== targetOffset) scrollViewport(targetOffset - currentOffset)
        // A jump also moves the synthetic Vim cursor to the corresponding
        // edge. Redraw it in NORMAL mode so the jump is immediately visible.
        vimCursorRowRef.current = 0
        if (mode !== 'NORMAL') updateVisualSelection()
        else updateVimCursorHighlight()
        updateScrollPercent()
        break
      }
      case 'goBottom': {
        // G goes to the live end of the terminal, then places the synthetic
        // cursor on the last meaningful row instead of trailing blank padding.
        const info = getScrollInfo()
        const hasUsableScrollbar = info.totalLines > 0 && info.viewportLen > 0
        const maxOffset = Math.max(0, info.totalLines - info.viewportLen)
        const currentOffset = logicalViewportOffsetRef.current ?? info.viewportOffset
        const targetOffset = hasUsableScrollbar ? maxOffset : currentOffset
        if (currentOffset !== targetOffset) {
          scrollViewport(targetOffset - currentOffset)
        }

        // The terminal may expose the old viewport until its next render. Do
        // one immediate placement for responsiveness and one deferred
        // placement after the scroll has committed, so G never lands on the
        // previous viewport's last line.
        placeCursorAtLastMeaningfulRow()
        if (bottomCursorRafRef.current !== null) {
          cancelAnimationFrame(bottomCursorRafRef.current)
        }
        bottomCursorRafRef.current = requestAnimationFrame(() => {
          bottomCursorRafRef.current = null
          if (vimActiveRef.current) placeCursorAtLastMeaningfulRow()
        })
        break
      }
      case 'enterVisual':
        if (mode === 'VISUAL') {
          vimModeRef.current = 'NORMAL'
          publishTerminalMode('NORMAL')
          setVimMode('NORMAL')
          t?.clearSelection()
        } else {
          vimModeRef.current = 'VISUAL'
          publishTerminalMode('VISUAL')
          setVimMode('VISUAL')
          visualAnchorAbsRowRef.current = getCursorAbsRow() + vimCursorRowRef.current
          visualAnchorColRef.current = vimCursorColRef.current
          updateVisualSelection()
        }
        break
      case 'enterVisualLine':
        if (mode === 'VISUAL_LINE') {
          vimModeRef.current = 'NORMAL'
          publishTerminalMode('NORMAL')
          setVimMode('NORMAL')
          t?.clearSelection()
        } else {
          vimModeRef.current = 'VISUAL_LINE'
          publishTerminalMode('VISUAL_LINE')
          setVimMode('VISUAL_LINE')
          visualAnchorAbsRowRef.current = getCursorAbsRow() + vimCursorRowRef.current
          visualAnchorColRef.current = 0
          updateVisualSelection()
        }
        break
      case 'yank':
        if (mode !== 'NORMAL' && t) {
          void (async () => {
            const operation = vimOperationRef.current
            try {
              await t.copySelectionToClipboard()
            } finally {
              if (operation !== vimOperationRef.current || !vimActiveRef.current) return
              vimModeRef.current = 'NORMAL'
              publishTerminalMode('NORMAL')
              setVimMode('NORMAL')
              t.clearSelection()
              if (yankExitsVimMode) {
                exitVimMode()
              } else {
                updateVimCursorHighlight()
              }
            }
          })().catch(() => {})
        }
        break
      case 'enterInsert':
        // `i` is Vim's insert-mode escape hatch: leave scrollback mode,
        // remove the synthetic Vim selection, and return focus to terminal
        // typing without forwarding the `i` key to the shell.
        exitVimMode()
        break
      case 'searchOpen':
        setSearchOpen(true)
        break
      case 'searchNext':
        t?.searchNext()
        break
      case 'searchPrev':
        t?.searchPrevious()
        break
      case 'exitVim':
        if (mode !== 'NORMAL') {
          vimModeRef.current = 'NORMAL'
          publishTerminalMode('NORMAL')
          setVimMode('NORMAL')
          t?.clearSelection()
        } else {
          exitVimMode()
        }
        break
    }
  }, [getScrollInfo, getViewportRows, getCursorAbsRow, getLineText, getLastMeaningfulViewportRow, placeCursorAtLastMeaningfulRow, updateVisualSelection, updateVimCursorHighlight, updateScrollPercent, scrollViewport, exitVimMode, setSearchOpen, yankExitsVimMode, paneId, publishTerminalMode])

  // ── Direct capture-phase key handler for vim motions ──────────────────────
  const handleVimKey = useCallback((e: KeyboardEvent) => {
    if (!isFocusedRef.current || !vimActiveRef.current) return

    // The global engine is suspended when Vim starts. Do not use
    // defaultPrevented as a guard here: another earlier capture listener may
    // have prevented the event even though it did not handle the Vim action.

    // Swallow the event — we're in vim mode, nothing passes to terminal.
    // stopImmediatePropagation prevents other capture handlers on window
    // (keybinding engine, search toggle) and all bubble handlers (terminal).
    e.preventDefault()
    e.stopImmediatePropagation()

    // q is an unconditional Vim exit, even if an operator/text-object sequence
    // is currently pending. Keep it intercepted so it never reaches the PTY.
    if (e.key?.toLowerCase?.() === 'q' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
      }
      if (operatorPendingRef.current) {
        clearTimeout(operatorPendingRef.current.timer)
        operatorPendingRef.current = null
      }
      exitVimMode()
      return
    }

    // Text-object operator sequences have priority over ordinary mappings.
    const operatorPending = operatorPendingRef.current
    if (operatorPending) {
      clearTimeout(operatorPending.timer)
      operatorPendingRef.current = null
      const key = e.key?.toLowerCase?.() ?? ''
      if (key === 'escape') return
      if (operatorPending.around === null && (key === 'i' || key === 'a') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const timer = window.setTimeout(() => { operatorPendingRef.current = null }, GAP_MS)
        operatorPendingRef.current = {
          operation: operatorPending.operation,
          around: key === 'a',
          timer,
        }
        return
      }
      if (operatorPending.around !== null && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (key === 'w' || key === '[' || key === ']' || key === '(' || key === ')' || key === '{' || key === '}' || key === '<' || key === '>') {
          if (operatorPending.operation === 'yank') yankTextObject(key, operatorPending.around)
          else selectVisualTextObject(key, operatorPending.around)
        }
      }
      // Unknown object keys cancel the operator without leaking the key to the
      // shell; this is the safe Vim-style behavior for an incomplete command.
      return
    }

    // Handle G/gg from the physical key code as well as e.key. This avoids
    // keyboard-layout/Caps-Lock differences and keeps uppercase G distinct
    // from lowercase g before the generic matcher runs.
    const isPlainG = !e.ctrlKey && !e.metaKey && !e.altKey &&
      (e.code === 'KeyG' || e.key === 'g' || e.key === 'G')
    if (isPlainG) {
      // `G` is the shifted command. The Caps Lock state is handled explicitly
      // so Caps-Lock `g` remains lowercase, while synthetic events with key
      // `G` and no modifier still work as uppercase input.
      const capsLock = e.getModifierState?.('CapsLock') ?? false
      const isUppercaseG = e.shiftKey || (e.key === 'G' && !capsLock)
      if (isUppercaseG) {
        if (pendingRef.current) {
          clearTimeout(pendingRef.current.timer)
          pendingRef.current = null
        }
        dispatchAction('goBottom')
        return
      }

      // Lowercase `g` starts (or completes) the `gg` top-of-scrollback command.
      if (pendingRef.current?.action === 'pendingGoTop') {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
        dispatchAction('goTop')
        return
      }
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
      }
      const timer = window.setTimeout(() => {
        pendingRef.current = null
        dispatchAction('pendingGoTop')
      }, GAP_MS)
      pendingRef.current = { action: 'pendingGoTop', timer }
      return
    }

    // In VISUAL mode, i/a start a visual text-object sequence such as viw or
    // va[. Ordinary i in NORMAL mode remains the insert/terminal escape hatch.
    const mode = vimModeRef.current
    const key = e.key?.toLowerCase?.() ?? ''
    if (mode === 'VISUAL' && (key === 'i' || key === 'a') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const timer = window.setTimeout(() => { operatorPendingRef.current = null }, GAP_MS)
      operatorPendingRef.current = { operation: 'visual', around: key === 'a', timer }
      return
    }

    // In NORMAL mode, y starts an operator-pending text-object sequence.
    // In VISUAL mode it remains the existing selection yank command.
    if (mode === 'NORMAL' && key === 'y' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const timer = window.setTimeout(() => { operatorPendingRef.current = null }, GAP_MS)
      operatorPendingRef.current = { operation: 'yank', around: null, timer }
      return
    }

    // Check two-chord sequences first
    if (pendingRef.current) {
      const pending = pendingRef.current
      clearTimeout(pending.timer)
      pendingRef.current = null

      for (const { seq, action } of TWO_CHORD) {
        if (matchKey(e, seq[1])) {
          dispatchAction(action)
          return
        }
      }
      // Second chord didn't match any sequence — dispatch the first chord
      // as a fallback, then handle this chord as a new single-chord.
      dispatchAction(pending.action)
      // fall through to single-chord handling below
    }

    // Check single-chord bindings
    const action = findSingleAction(e)
    if (action) {
      // Check if this key starts a two-chord sequence
      const startsSeq = TWO_CHORD.some(({ seq }) => matchKey(e, seq[0]))
      if (startsSeq) {
        const timer = window.setTimeout(() => {
          pendingRef.current = null
          dispatchAction(action)
        }, GAP_MS)
        pendingRef.current = { action, timer }
        return
      }
      dispatchAction(action)
    }
  }, [dispatchAction, yankTextObject, selectVisualTextObject])

  // ── Configurable fast-key trigger (default: jk) ────────────────────────────
  // Buffer trigger characters while matching. This keeps the first `j` out of
  // the shell, preventing it from auto-following the terminal before `k`
  // arrives. Failed or timed-out attempts are replayed unchanged.
  const armTriggerTimeout = useCallback(() => {
    if (triggerTimerRef.current !== null) clearTimeout(triggerTimerRef.current)
    triggerTimerRef.current = window.setTimeout(() => {
      triggerTimerRef.current = null
      replayTriggerBuffer()
    }, Math.max(0, jkTriggerMs))
  }, [jkTriggerMs, replayTriggerBuffer])

  const handleJkTrigger = useCallback((e: KeyboardEvent) => {
    if (!isFocusedRef.current || vimActiveRef.current) return
    if (!vimModeEnabled) return
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
    if (isVimDisabled()) return

    const trigger = vimTriggerSequence.trim().toLowerCase()
    if (trigger.length < 2) {
      replayTriggerBuffer()
      return
    }

    const rawKey = e.key ?? ''
    const key = rawKey.toLowerCase()
    if (key.length !== 1) {
      replayTriggerBuffer()
      return
    }

    const now = performance.now()
    if (triggerLastAtRef.current > 0 && now - triggerLastAtRef.current > jkTriggerMs) {
      replayTriggerBuffer()
    }

    const progress = triggerProgressRef.current
    if (key === trigger[progress]) {
      const nextProgress = progress + 1
      e.preventDefault()
      e.stopImmediatePropagation()
      suppressedTriggerKeyupsRef.current.add(e.code || key)
      triggerBufferRef.current += rawKey

      if (nextProgress === trigger.length) {
        if (triggerTimerRef.current !== null) {
          clearTimeout(triggerTimerRef.current)
          triggerTimerRef.current = null
        }
        triggerBufferRef.current = ''
        triggerProgressRef.current = 0
        triggerLastAtRef.current = 0
        enterVimMode(true)
        return
      }

      triggerProgressRef.current = nextProgress
      triggerLastAtRef.current = now
      armTriggerTimeout()
      return
    }

    // Replay the failed prefix so ordinary typing is not lost. If this key is
    // also the beginning of a fresh sequence, consume it as that new prefix.
    replayTriggerBuffer()
    if (key === trigger[0]) {
      e.preventDefault()
      e.stopImmediatePropagation()
      suppressedTriggerKeyupsRef.current.add(e.code || key)
      triggerBufferRef.current = rawKey
      triggerProgressRef.current = 1
      triggerLastAtRef.current = now
      armTriggerTimeout()
    }
  }, [enterVimMode, vimModeEnabled, jkTriggerMs, vimTriggerSequence, replayTriggerBuffer, armTriggerTimeout, isVimDisabled])

  const handleTriggerKeyUp = useCallback((e: KeyboardEvent) => {
    if (!isFocusedRef.current) return
    const keyIdentity = e.code || e.key?.toLowerCase?.() || ''
    if (!suppressedTriggerKeyupsRef.current.has(keyIdentity)) return
    suppressedTriggerKeyupsRef.current.delete(keyIdentity)
    e.preventDefault()
    e.stopImmediatePropagation()
  }, [])

  // Reset partially matched trigger input whenever focus or its configuration
  // changes; stale keys must never complete a later sequence.
  useEffect(() => {
    if (!isFocused) {
      // Never inject a stale prefix into a terminal that just lost focus.
      discardTriggerBuffer()
      return
    }
    // Configuration changes while focused should preserve ordinary typing by
    // replaying any prefix that was already consumed.
    replayTriggerBuffer()
  }, [isFocused, vimTriggerSequence, jkTriggerMs, vimModeEnabled, replayTriggerBuffer, discardTriggerBuffer])

  // ── Attach/detach capture-phase handlers ──────────────────────────────────
  // Keep one stable document-capture listener per pane. Reattaching only when
  // the pane focus flag changes can race the terminal's canvas focus/blur
  // events, causing a fast `jk` to be missed entirely. The live ref above keeps
  // unfocused panes inert while the focused pane handles the event first.
  useEffect(() => {
    document.addEventListener('keydown', handleVimKey, true)
    document.addEventListener('keydown', handleJkTrigger, true)
    document.addEventListener('keyup', handleTriggerKeyUp, true)

    return () => {
      document.removeEventListener('keydown', handleVimKey, true)
      document.removeEventListener('keydown', handleJkTrigger, true)
      document.removeEventListener('keyup', handleTriggerKeyUp, true)
      // Cancel any pending sequence timers.
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
      }
      if (operatorPendingRef.current) {
        clearTimeout(operatorPendingRef.current.timer)
        operatorPendingRef.current = null
      }
      discardTriggerBuffer()
    }
  }, [handleVimKey, handleJkTrigger, handleTriggerKeyUp, discardTriggerBuffer])

  // ── Ctrl+K trigger via keybinding engine (only when focused and enabled) ──
  useEffect(() => {
    if (!isFocused || !vimModeEnabled) return
    const engine = getEngine()
    if (!engine) return
    engine.pushScope('local')
    engine.registry.register({
      id: TRIGGER_BINDING_ID,
      scope: 'local',
      keys: [{ key: 'k', ctrl: true }],
      description: 'Enter vim scrollback mode',
      group: 'Terminal',
      action: () => {
        if (vimActiveRef.current || isVimDisabled()) return
        enterVimMode()
      },
    })
    return () => {
      engine.registry.unregister(TRIGGER_BINDING_ID)
      engine.popScope('local')
      engine.resetBuffer()
    }
  }, [isFocused, paneId, enterVimMode, vimModeEnabled, isVimDisabled])

  // ── Reset when focus is lost ──────────────────────────────────────────────
  useEffect(() => {
    if (!isFocused) {
      if (vimActiveRef.current) exitVimMode()
      publishTerminalMode(null)
      return
    }
    publishTerminalMode(vimActiveRef.current ? vimModeRef.current : 'INSERT')
  }, [isFocused, paneId, exitVimMode, publishTerminalMode])

  useEffect(() => () => {
    publishTerminalMode(null)
    if (scrollPercentRafRef.current !== null) {
      cancelAnimationFrame(scrollPercentRafRef.current)
    }
    if (bottomCursorRafRef.current !== null) {
      cancelAnimationFrame(bottomCursorRafRef.current)
    }
  }, [paneId, publishTerminalMode])

  return { vimActive, vimMode, scrollbackPercent, exitVimMode }
}
