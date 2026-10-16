/**
 * Auto-closing for the markdown editor.
 *
 * Installed via `EditorView.inputHandler`, so it only sees real text-input
 * events (typing that would insert characters). Vim normal/visual-mode
 * commands are handled by the vim keymap and never reach the input handler,
 * so this never breaks navigation, search, or operators — it just auto-pairs
 * while typing in insert mode (or with vim disabled).
 *
 * Behaviour:
 *  - markdown delimiter pairs (`*`, `_`, `` ` ``, `[ ]`, `( )`, quotes)
 *    auto-close with the cursor between them; a selection is wrapped.
 *  - typing an opening HTML tag's `>` appends `</tag>` and keeps the cursor
 *    just after `>`, so the tag body remains editable inside the element.
 */

import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Single-char markdown delimiters → their matching closer. */
const PAIRS: Record<string, string> = {
  '*': '*',
  '_': '_',
  '`': '`',
  '[': ']',
  '(': ')',
  '{': '}',
  '"': '"',
  "'": "'",
}

/** Elements that carry no content, so an auto-closed end tag would be redundant. */
const SELF_CLOSING_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Given the full text `prefix` up to the cursor, return the name of the opening
 *  tag currently being typed, or null when `>` should just be inserted plainly. */
function openingTagBefore(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    if (prefix[i] !== '<') continue
    // A `</` closing tag: not what we're completing.
    if (i > 0 && prefix[i - 1] === '/') continue
    const rest = prefix.slice(i + 1)
    // Anything after another `<` or an existing `>` means this `<` isn't the
    // sole opening-tag start pending at the cursor.
    if (rest.includes('<') || rest.includes('>')) continue
    const name = /^[A-Za-z][A-Za-z0-9-]*(?=\s|$)/.exec(rest)?.[0]
    if (!name) continue
    if (SELF_CLOSING_TAGS.has(name.toLowerCase())) return null
    return name
  }
  return null
}

/** Auto-close an opening HTML tag when `>` is typed. Inserts `></tag>` and puts
 *  the cursor right after the `>`. Returns `true` if it acted. */
function closeHtmlTag(view: EditorView, at: number): boolean {
  const name = openingTagBefore(view.state.doc.sliceString(0, at))
  if (!name) return false
  view.dispatch({
    changes: { from: at, insert: `></${name}>` },
    selection: EditorSelection.cursor(at + 1),
  })
  return true
}

/** Insert `open + close` with the cursor between, or wrap a selection, handling
 *  the common "step past a closer you already have" cases. */
function closeMarkdownPair(
  view: EditorView,
  from: number,
  to: number,
  open: string,
  close: string,
): void {
  const { state } = view

  if (from === to) {
    // Symmetric pair (e.g. `*`, `"`) right at a closer → just step past it.
    if (open === close && state.sliceDoc(to, to + close.length) === close) {
      view.dispatch({ selection: EditorSelection.cursor(to + close.length) })
      return
    }
    // Bracket pair (e.g. `[ ]`) already closed → step past both.
    if (
      open !== close &&
      state.sliceDoc(from - open.length, from) === open &&
      state.sliceDoc(to, to + close.length) === close
    ) {
      view.dispatch({ selection: EditorSelection.cursor(to + close.length) })
      return
    }
    view.dispatch({
      changes: { from, to, insert: open + close },
      selection: EditorSelection.cursor(from + open.length),
    })
    return
  }

  view.dispatch({
    changes: [
      { from, insert: open },
      { from: to, insert: close },
    ],
    selection: EditorSelection.range(from + open.length, to + open.length),
  })
}

/** Central handler routed from the input handler. Returns `true` when handled. */
function handleInput(view: EditorView, from: number, to: number, ch: string): boolean {
  if (ch === '>') {
    return from === to && closeHtmlTag(view, to)
  }
  const close = PAIRS[ch]
  if (!close) return false
  closeMarkdownPair(view, from, to, ch, close)
  return true
}

/** `EditorView.inputHandler` extension; returns `false` to keep default insertion. */
export const autoCloseInputHandler = EditorView.inputHandler.of((view, from, to, insert) =>
  insert.length === 1 ? handleInput(view, from, to, insert) : false,
)