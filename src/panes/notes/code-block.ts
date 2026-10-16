/**
 * Code-block line decorator + language flair for the markdown editor.
 *
 * Every line inside a fenced code block gets `cm-code-block-line` so the
 * stylesheet can apply a continuous "card" background with side borders,
 * monospace font, and rounded top/bottom corners. A small language label
 * floats top-right — clicking it copies the block contents.
 *
 * Mirrors the zennotes `cm-code-block-font` and `cm-code-block-flair` plugins
 * combined into one.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

const FENCE_RE = /^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/

// ---------------------------------------------------------------------------
// Flair widget — language label + copy-to-clipboard
// ---------------------------------------------------------------------------

class CodeFlairWidget extends WidgetType {
  constructor(
    private readonly language: string,
    /** Doc offsets of the block content to copy (fences excluded). */
    private readonly contentFrom: number,
    private readonly contentTo: number,
  ) {
    super()
  }

  eq(other: CodeFlairWidget): boolean {
    return (
      other.language === this.language &&
      other.contentFrom === this.contentFrom &&
      other.contentTo === this.contentTo
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-code-flair'
    button.textContent = this.language
    button.title = 'Copy code'
    button.setAttribute('aria-label', `Copy ${this.language} code block`)
    button.setAttribute('contenteditable', 'false')

    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const text =
        this.contentTo > this.contentFrom
          ? view.state.doc.sliceString(this.contentFrom, this.contentTo)
          : ''
      void navigator.clipboard?.writeText(text).then(
        () => {
          button.classList.add('is-copied')
          button.textContent = 'Copied'
          window.setTimeout(() => {
            button.classList.remove('is-copied')
            button.textContent = this.language
          }, 1100)
        },
        () => {
          /* clipboard denied — leave the label as-is */
        },
      )
    })
    return button
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

const codeBlockLine = Decoration.line({ class: 'cm-code-block-line' })
const codeBlockBegin = Decoration.line({ class: 'cm-code-block-begin' })
const codeBlockEnd = Decoration.line({ class: 'cm-code-block-end' })

function buildDecorations(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state)
  const lineClasses = new Map<number, { line: boolean; begin: boolean; end: boolean }>()
  const flairs: Array<{ at: number; widget: CodeFlairWidget }> = []
  const seen = new Set<number>()

  const mark = (from: number, key: 'line' | 'begin' | 'end'): void => {
    const entry = lineClasses.get(from) ?? { line: false, begin: false, end: false }
    entry[key] = true
    lineClasses.set(from, entry)
  }

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return

        const beginLine = view.state.doc.lineAt(node.from)
        if (seen.has(beginLine.from)) return false
        seen.add(beginLine.from)

        const lastLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1))

        // Tag every line inside the block.
        for (let n = beginLine.number; n <= lastLine.number; n += 1) {
          const lineFrom = view.state.doc.line(n).from
          const first = n === beginLine.number
          const last = n === lastLine.number
          mark(lineFrom, 'line')
          if (first) mark(lineFrom, 'begin')
          if (last) mark(lineFrom, 'end')
        }

        // Language label — resolve from the opening fence.
        const langMatch = beginLine.text.match(FENCE_RE)
        const language = (langMatch?.[1] || 'text').toLowerCase()

        const contentFrom =
          beginLine.number < lastLine.number
            ? view.state.doc.line(beginLine.number + 1).from
            : beginLine.to
        const contentTo =
          lastLine.number > beginLine.number
            ? view.state.doc.line(lastLine.number - 1).to
            : beginLine.to

        flairs.push({
          at: beginLine.to,
          widget: new CodeFlairWidget(language, contentFrom, contentTo),
        })

        return false
      },
    })
  }

  const pending: Array<{ from: number; to: number; decoration: Decoration }> = []

  // Line decorations, sorted by line start.
  const sorted = [...lineClasses.entries()].sort((a, b) => a[0] - b[0])
  for (const [from, cls] of sorted) {
    if (cls.line) {
      pending.push({ from, to: from, decoration: codeBlockLine })
    }
    if (cls.begin) {
      pending.push({ from, to: from, decoration: codeBlockBegin })
    }
    if (cls.end) {
      pending.push({ from, to: from, decoration: codeBlockEnd })
    }
  }

  // Flair widgets sit at the end of the opening fence line.
  for (const { at, widget } of flairs) {
    pending.push({ from: at, to: at, decoration: Decoration.widget({ side: 1, widget }) })
  }

  // CodeMirror requires decorations in document order.
  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) builder.add(item.from, item.to, item.decoration)
  return builder.finish()
}

export const codeBlockPlugin = ViewPlugin.fromClass(
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
