import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { Annotation, Compartment, EditorState, RangeSetBuilder, type ChangeSpec } from '@codemirror/state'
import { syntaxTree, syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { languages } from '@codemirror/language-data'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap } from '@codemirror/commands'
import { codeBlockPlugin } from './code-block'
import { calloutPlugin } from './callout'
import { useNotesSettings } from './settings'
import { vim, Vim } from '@replit/codemirror-vim'
import { autoCloseInputHandler } from './auto-close'

const externalUpdate = Annotation.define<boolean>()

const HIDDEN_MARKERS = new Set([
  'EmphasisMark',
  'StrongMark',
  'CodeMark',
  'LinkMark',
  'StrikethroughMark',
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'CodeInfo',
])

/** A round bullet that replaces a `-` / `*` / `+` list marker. Ordered
 *  markers (`1.`) are left as source text so numbered lists keep their
 *  numbers, matching the zennotes reference preview. */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-md-bullet'
    element.textContent = '•'
    element.setAttribute('aria-hidden', 'true')
    return element
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Renders a GFM task-list marker (`[ ]` / `[x]` / `[X]`) as a clickable
 *  checkbox. The widget rewrites the underlying markdown when toggled — the
 *  state char sits at `from + 1` and the marker stays 3 chars wide, so no doc
 *  positions downstream shift. (Forwarded `[>]` tasks are handled by
 *  `ForwardedMarkerWidget` — the parser sees them as links, not TaskMarkers.) */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    /** Absolute doc offset of the opening `[`. */
    private readonly from: number,
    private readonly checked: boolean,
  ) { super() }

  eq(other: TaskCheckboxWidget): boolean {
    return this.from === other.from && this.checked === other.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-checkbox'
    wrap.setAttribute('contenteditable', 'false')

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.className = 'cm-md-checkbox-input'
    input.setAttribute('aria-label', this.checked ? 'Uncheck task' : 'Check task')

    // Stop the editor from moving the selection or losing focus on the
    // pointer-down phase. Toggling on click keeps the cursor wherever
    // the user had it before they reached for the checkbox.
    input.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    input.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' },
      })
    })

    wrap.append(input)
    return wrap
  }

  // `false` lets DOM events bubble to our handler above. CodeMirror's
  // default `ignoreEvent` skips events on widgets entirely, which would
  // also swallow our click.
  ignoreEvent(): boolean {
    return false
  }
}

/** Marks the text of a completed task (`- [x] …`) so CSS can strike/gray it. */
const taskDoneMark = Decoration.mark({ class: 'cm-md-task-done' })

/** Marks the text of a cancelled task (`- [-] …`) so CSS can strike/mute it.
 *  Always applied (cancelled always reads as struck), even on the active line. */
const taskCancelledMark = Decoration.mark({ class: 'cm-md-task-cancelled' })

/** Renders a `- [>]` forwarded-task marker as an arrow. @lezer/markdown parses
 *  `[>]` as a broken link rather than a TaskMarker, so this replaces the link
 *  node directly (matching the zennotes reference). */
class ForwardedMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-task-forwarded'
    span.title = 'Forwarded to another note'
    span.setAttribute('role', 'img')
    span.setAttribute('aria-label', 'Forwarded to another note')
    span.setAttribute('contenteditable', 'false')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Renders a `- [-]` cancelled-task marker as a muted ✕. */
class CancelledMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-task-cancelled-marker'
    span.title = 'Cancelled'
    span.setAttribute('role', 'img')
    span.setAttribute('aria-label', 'Cancelled')
    span.setAttribute('contenteditable', 'false')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Renders a `- [/]` in-progress marker as a half-filled box. The text is left
 *  alone: in-progress work still reads as live, not struck out. */
class InProgressMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-task-in-progress-marker'
    span.title = 'In progress'
    span.setAttribute('role', 'img')
    span.setAttribute('aria-label', 'In progress')
    span.setAttribute('contenteditable', 'false')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

const STYLED_NODES: Record<string, string> = {
  Emphasis: 'cm-md-emphasis',
  StrongEmphasis: 'cm-md-strong',
  Strikethrough: 'cm-md-strikethrough',
  InlineCode: 'cm-md-inline-code',
  Link: 'cm-md-link',
  URL: 'cm-md-link',
  // Headings get their size from the line class (`cm-md-heading-line-N`);
  // these marks only carry weight/color so the `em` size is never doubled.
  ATXHeading1: 'cm-md-heading',
  ATXHeading2: 'cm-md-heading',
  ATXHeading3: 'cm-md-heading',
  ATXHeading4: 'cm-md-heading',
  ATXHeading5: 'cm-md-heading',
  ATXHeading6: 'cm-md-heading',
}

// Leading whitespace plus any run of blockquote markers (`> `, nestable).
const LINE_PREFIX_RE = /^([ \t]*(?:>[ \t]?)*)/
// A list marker after the prefix: bullet or ordered, with its trailing gap.
const LIST_MARKER_RE = /^([-*+]|\d{1,9}[.)])([ \t]+)/
// A task marker after the list marker: `[c]` followed by whitespace or EOL.
const TASK_STATE_RE = /^\[(.)\](?:[ \t]|$)/

/** The minimal change that toggles `line` (text at absolute offset `from`),
 *  or null when the line is intentionally left alone. Ported from the zennotes
 *  reference so the notes pane behaves identically:
 *  - a line with no checkbox becomes one, keeping indentation, blockquote
 *    prefix and list marker (`* note` → `* [ ] note`, plain text → `- [ ] text`),
 *  - `[ ]` and `[/]` check off to `[x]`,
 *  - `[x]` / `[X]` uncheck back to `[ ]`,
 *  - forwarded `[>]` and cancelled `[-]` are deliberate states, left alone. */
function checkboxToggleChange(line: string, from: number): ChangeSpec | null {
  const prefix = LINE_PREFIX_RE.exec(line)?.[1] ?? ''
  const afterPrefix = line.slice(prefix.length)

  const marker = LIST_MARKER_RE.exec(afterPrefix)
  if (marker) {
    const markerEnd = prefix.length + marker[0].length
    const state = TASK_STATE_RE.exec(line.slice(markerEnd))
    if (state) {
      const stateChar = state[1]
      // Forwarded and cancelled stay untouched; everything else flips
      // between checked and unchecked, matching the checkbox widget.
      if (stateChar === '>' || stateChar === '-') return null
      const at = from + markerEnd + 1
      return { from: at, to: at + 1, insert: /[xX]/.test(stateChar) ? ' ' : 'x' }
    }
    return { from: from + markerEnd, insert: '[ ] ' }
  }

  return { from: from + prefix.length, insert: '- [ ] ' }
}

/** Toggle the checkbox on every line any selection range touches (⌘L). */
export function toggleCheckbox(view: EditorView | null): boolean {
  if (!view) return false
  const { state } = view
  const changes: ChangeSpec[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number
    const lastLine = state.doc.lineAt(range.to).number
    for (let n = firstLine; n <= lastLine; n += 1) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      const change = checkboxToggleChange(line.text, line.from)
      if (change) changes.push(change)
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: 'input' })
  }
  return true
}

function lineNumberAt(state: EditorState, position: number): number {
  return state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length))).number
}

/** Every line touched by a cursor or selection remains source-editable. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = lineNumberAt(state, range.from)
    const last = lineNumberAt(state, range.to)
    for (let line = first; line <= last; line += 1) lines.add(line)
  }
  return lines
}

function nodeIsActive(state: EditorState, from: number, to: number, active: Set<number>): boolean {
  const first = lineNumberAt(state, from)
  const last = lineNumberAt(state, Math.max(from, to - 1))
  for (let line = first; line <= last; line += 1) {
    if (active.has(line)) return true
  }
  return false
}

function markerEnd(state: EditorState, from: number, to: number, name: string): number {
  // Zennotes hides the separating space along with heading/list/quote markers,
  // so inactive lines read like rendered Markdown rather than oddly indented text.
  if (!['HeaderMark', 'QuoteMark', 'ListMark'].includes(name)) return to
  const next = state.doc.sliceString(to, Math.min(to + 1, state.doc.length))
  return next === ' ' ? to + 1 : to
}

function buildLivePreview(view: EditorView): DecorationSet {
  const { state } = view
  const active = activeLines(state)
  const pending: Array<{ from: number; to: number; decoration: Decoration }> = []

  for (const range of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.type.name
        if (node.from >= node.to) return true
        const isActive = nodeIsActive(state, node.from, node.to, active)

        // `[>]` forwarded, `[-]` cancelled and `[/]` in-progress markers are
        // parsed as broken links, not TaskMarkers. At the start of a list item
        // they render a dedicated glyph (arrow / ✕ / half-filled box) off the
        // active line; cancelled always strikes its text, like Obsidian. We
        // return false so the bracket LinkMarks aren't separately hidden (which
        // would overlap this replacement).
        if (name === 'Link') {
          const markerText = state.doc.sliceString(node.from, node.to)
          if (markerText === '[>]' || markerText === '[-]' || markerText === '[/]') {
            const markerLine = state.doc.lineAt(node.from)
            const before = state.doc.sliceString(markerLine.from, node.from)
            if (/^\s*(?:[-+*]|\d+[.)])[ \t]+$/.test(before)) {
              if (markerText === '[-]' && markerLine.to > node.to) {
                pending.push({ from: node.to, to: markerLine.to, decoration: taskCancelledMark })
              }
              // Like the checkbox, the glyph renders off the active line; on
              // the active line the raw `[>]` / `[-]` / `[/]` stays visible as
              // editable source (matching the zennotes reference).
              if (isActive) return false
              const widget = markerText === '[>]'
                ? new ForwardedMarkerWidget()
                : markerText === '[-]'
                  ? new CancelledMarkerWidget()
                  : new InProgressMarkerWidget()
              pending.push({
                from: node.from,
                to: node.to,
                decoration: Decoration.replace({ widget }),
              })
              return false
            }
          }
        }

        // Task markers: render a clickable checkbox (and strike the text of
        // checked tasks). On the active line the raw `[ ]` / `[x]` marker stays
        // visible so the whole line reads as editable source — matching the
        // zennotes reference and Obsidian, and consistent with the
        // list/quote/heading markers, which also reveal on the active line.
        // Off the active line the marker renders as a clickable checkbox
        // (toggle via click or ⌘L).
        if (name === 'TaskMarker') {
          const markerLine = state.doc.lineAt(node.from)
          const markerText = state.doc.sliceString(node.from, node.to)
          const stateChar = markerText[1] ?? ''
          const checked = markerText.length >= 2 && /[xX]/.test(stateChar)
          if (checked && markerLine.to > node.to) {
            pending.push({ from: node.to, to: markerLine.to, decoration: taskDoneMark })
          }
          // Reveal the raw marker on the active line so the line reads as
          // source; the checkbox renders off the line. The checked-text strike
          // is applied either way so it doesn't flip as the cursor moves.
          if (isActive) return true
          pending.push({
            from: node.from,
            to: node.to,
            decoration: Decoration.replace({
              widget: new TaskCheckboxWidget(node.from, checked),
            }),
          })
          return true
        }

        // List markers: only `-` / `*` / `+` become a bullet; ordered markers
        // (`1.`) stay as text so numbered lists render their numbers. On a
        // task line the checkbox replaces the list marker, so hide the bullet
        // (and trailing space) there — the line reads "☐ task", not "• ☐ task".
        if (name === 'ListMark') {
          if (isActive) return true
          const text = state.doc.sliceString(node.from, node.to)
          if (!/^[-*+]$/.test(text)) return true // ordered marker → keep visible
          const afterMark = state.doc.sliceString(node.to, state.doc.lineAt(node.from).to)
          // Task lines (`[ ]`/`[x]`/`[X]`, plus forwarded `[>]`, cancelled
          // `[-]`, in-progress `[/]`) get their own marker in place of the
          // bullet, so hide it (and the trailing space) there.
          if (/^\s*\[[ xX>/-]\]/.test(afterMark)) {
            pending.push({
              from: node.from,
              to: markerEnd(state, node.from, node.to, name),
              decoration: Decoration.replace({}),
            })
            return true
          }
          pending.push({
            from: node.from,
            to: markerEnd(state, node.from, node.to, name),
            decoration: Decoration.replace({ widget: new BulletWidget() }),
          })
          return true
        }

        if (!isActive && HIDDEN_MARKERS.has(name)) {
          pending.push({
            from: node.from,
            to: markerEnd(state, node.from, node.to, name),
            decoration: Decoration.replace({}),
          })
        }

        const style = STYLED_NODES[name]
        if (style) {
          pending.push({
            from: node.from,
            to: node.to,
            decoration: Decoration.mark({ class: style }),
          })
        }
        return true
      },
    })

    const firstLine = state.doc.lineAt(range.from).number
    const lastLine = state.doc.lineAt(Math.max(range.from, range.to - 1)).number
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber)
      const text = line.text.trimStart()
      const sourceClass = active.has(lineNumber) ? 'cm-md-source-line ' : ''
      let className: string | undefined
      if (/^#{1,6}(?:\s|$)/.test(text)) {
        className = `${sourceClass}cm-md-heading-line cm-md-heading-line-${text.match(/^#+/)?.[0].length ?? 1}`
      } else if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(text)) {
        className = `${sourceClass}cm-md-list-line`
      } else if (/^>\s?/.test(text)) {
        className = `${sourceClass}cm-md-quote-line`
      } else if (active.has(lineNumber)) {
        className = `${sourceClass}cm-md-source-line`
      }
      if (className) {
        pending.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({ class: className }),
        })
      }
    }
  }

  // CodeMirror requires decorations in document order. Stable tie ordering
  // keeps line decorations before inline ranges and avoids duplicate viewport
  // ranges when the viewport list overlaps.
  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) builder.add(item.from, item.to, item.decoration)
  return builder.finish()
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildLivePreview(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildLivePreview(update.view)
    }
  }
}, {
  decorations: value => value.decorations,
})

/** Resolves a fence info string (e.g. "typescript") to a language description
 *  that CodeMirror can load for syntax highlighting. Uses the pre-bundled
 *  `@codemirror/language-data` registry, then falls back to plain text when
 *  no match is found or the grammar can't load. */
function resolveCodeLanguage(info: string) {
  const normalized = info.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!normalized) return null
  return (
    languages.find(
      (lang) =>
        lang.name.toLowerCase() === normalized ||
        lang.alias?.some((a: string) => a.toLowerCase() === normalized),
    ) ?? null
  )
}

/** Code-syntax highlight tags mapped to CSS classes for the pane's paper-like
 *  theme. Matches the zennotes `paperHighlight` but uses the pane's CSS
 *  variables so the palette adapts to any theme. */
const paperHighlight = HighlightStyle.define([
  // Code tokens
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.moduleKeyword, class: 'tok-keyword' },
  { tag: t.modifier, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.character, class: 'tok-string' },
  { tag: t.escape, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.docComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.integer, class: 'tok-number' },
  { tag: t.float, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.self, class: 'tok-atom' },
  { tag: t.special(t.variableName), class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.logicOperator, class: 'tok-operator' },
  { tag: t.arithmeticOperator, class: 'tok-operator' },
  { tag: t.bitwiseOperator, class: 'tok-operator' },
  { tag: t.compareOperator, class: 'tok-operator' },
  { tag: t.updateOperator, class: 'tok-operator' },
  { tag: t.definitionOperator, class: 'tok-operator' },
  { tag: t.typeOperator, class: 'tok-operator' },
  { tag: t.controlOperator, class: 'tok-keyword' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.className, class: 'tok-type' },
  { tag: t.namespace, class: 'tok-type' },
  { tag: t.standard(t.variableName), class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function' },
  { tag: t.function(t.propertyName), class: 'tok-function' },
  { tag: t.definition(t.variableName), class: 'tok-variable-def' },
  { tag: t.definition(t.propertyName), class: 'tok-variable-def' },
  { tag: t.variableName, class: 'tok-variable' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.separator, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-bracket' },
  { tag: t.paren, class: 'tok-bracket' },
  { tag: t.brace, class: 'tok-bracket' },
  { tag: t.squareBracket, class: 'tok-bracket' },
  { tag: t.angleBracket, class: 'tok-bracket' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' },
  { tag: t.attributeValue, class: 'tok-string' },
  { tag: t.annotation, class: 'tok-meta-code' },
  { tag: t.processingInstruction, class: 'tok-meta-code' },
  { tag: t.invalid, class: 'tok-invalid' },
])

export function useMarkdownEditor(
  parentRef: RefObject<HTMLDivElement | null>,
  value: string,
  onChange: (value: string) => void,
  onSave: () => void,
  active = true,
) {
  const settings = useNotesSettings()
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const vimCompartmentRef = useRef(new Compartment())
  const autoCloseCompartmentRef = useRef(new Compartment())
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  const extensions = useMemo(() => [
          vimCompartmentRef.current.of(settings.vimMode ? vim() : []),
          autoCloseCompartmentRef.current.of(settings.autoClose ? autoCloseInputHandler : []),
          history(),
          keymap.of(historyKeymap),
          drawSelection(),
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage }),
          codeBlockPlugin,
          calloutPlugin,
          livePreviewPlugin,
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.theme({
            '.cm-selectionBackground': {
              backgroundColor: 'color-mix(in srgb, var(--primary) 42%, transparent)',
            },
            '&.cm-focused .cm-selectionBackground': {
              backgroundColor: 'color-mix(in srgb, var(--primary) 52%, transparent)',
            },
          }),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            keydown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                onSaveRef.current()
                return true
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
                event.preventDefault()
                toggleCheckbox(viewRef.current)
                return true
              }
              return false
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ], [])

  // Create or destroy the editor when active state changes.
  useEffect(() => {
    const parent = parentRef.current
    if (!parent || !active) return
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent,
    })
    viewRef.current = view
    view.focus()
    // Alias yank / delete / paste to the + register so they sync with
    // the system clipboard (the library already does the clipboard I/O
    // for "+y / "+p — we just make bare y/p use it automatically).
    for (const ctx of ['normal', 'visual'] as const) {
      for (const op of ['y', 'd']) Vim.noremap(op, `"+${op}`, ctx)
    }
    for (const op of ['p', 'P']) Vim.noremap(op, `"+${op}`, 'normal')
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [parentRef, active])

  // Reconfigure vim compartment when the vimMode setting changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: vimCompartmentRef.current.reconfigure(settings.vimMode ? vim() : []),
    })
  }, [settings.vimMode])

  // Apply font settings as CSS on the scroller.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dom.style.fontSize = `${settings.fontSize}px`
    view.dom.querySelector('.cm-scroller')?.setAttribute('style', `font-family: ${settings.fontFamily}`)
  }, [settings.fontSize, settings.fontFamily])

  // Sync editor content when value changes externally.
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalUpdate.of(true),
    })
  }, [value])

  return viewRef
}
