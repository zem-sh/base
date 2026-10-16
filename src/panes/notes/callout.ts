/**
 * Callout block styling for the markdown editor.
 *
 * Detects Obsidian-style callout blocks — consecutive blockquote lines
 * where the first line contains `[!TYPE]` — and adds line-decoration
 * classes so CSS can render a tinted card with a coloured left border.
 *
 * Recognised types (alias→colour group, from zennotes):
 *   blue:   note, info, abstract, summary, tldr
 *   green:  tip, hint, important, success, check, done
 *   purple: question, help, faq, example
 *   yellow: warning, warn, caution, attention
 *   red:    danger, error, bug, failure, fail, missing
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

// ---------------------------------------------------------------------------
// Recognised callout types and their colour-group classes
// ---------------------------------------------------------------------------

const CALLOUT_GROUPS: Record<string, string> = {
  note: 'blue',
  info: 'blue',
  abstract: 'blue',
  summary: 'blue',
  tldr: 'blue',
  tip: 'green',
  hint: 'green',
  important: 'green',
  success: 'green',
  check: 'green',
  done: 'green',
  question: 'purple',
  help: 'purple',
  faq: 'purple',
  example: 'purple',
  warning: 'yellow',
  warn: 'yellow',
  caution: 'yellow',
  attention: 'yellow',
  danger: 'red',
  error: 'red',
  bug: 'red',
  failure: 'red',
  fail: 'red',
  missing: 'red',
}

/** A blockquote line whose first line contains `[!TYPE]`. */
const CALLOUT_HEADER_RE = /^\s*>\s?\[!(\w+)\]/i

/** Any blockquote line (continues or starts a callout). */
const QUOTE_LINE_RE = /^\s*>/

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

const calloutLine = (group: string) =>
  Decoration.line({ class: `cm-callout-line cm-callout-${group}` })
const calloutBegin = (group: string) =>
  Decoration.line({ class: `cm-callout-begin cm-callout-${group}` })
const calloutEnd = (group: string) =>
  Decoration.line({ class: `cm-callout-end cm-callout-${group}` })

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const pending: Array<{ from: number; to: number; decoration: Decoration }> = []
  const seen = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number

    for (let n = firstLine; n <= lastLine; n += 1) {
      if (seen.has(n)) continue
      const line = state.doc.line(n)
      const text = line.text

      // Look for a callout header: `> [!TYPE]`
      const headerMatch = text.match(CALLOUT_HEADER_RE)
      if (!headerMatch) continue

      const type = headerMatch[1].toLowerCase()
      const group = CALLOUT_GROUPS[type] ?? 'blue'

      // Walk forward while consecutive lines are blockquotes.
      let endN = n
      seen.add(n)
      while (endN + 1 <= state.doc.lines) {
        const nextText = state.doc.line(endN + 1).text
        if (!QUOTE_LINE_RE.test(nextText)) break
        endN += 1
        seen.add(endN)
      }

      for (let i = n; i <= endN; i += 1) {
        const lineFrom = state.doc.line(i).from
        const first = i === n
        const last = i === endN
        if (first) {
          pending.push({ from: lineFrom, to: lineFrom, decoration: calloutBegin(group) })
        }
        if (last) {
          pending.push({ from: lineFrom, to: lineFrom, decoration: calloutEnd(group) })
        }
        pending.push({ from: lineFrom, to: lineFrom, decoration: calloutLine(group) })
      }

      n = endN // skip past the processed block
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) builder.add(item.from, item.to, item.decoration)
  return builder.finish()
}

export const calloutPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
