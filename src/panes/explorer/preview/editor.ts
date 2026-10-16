import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'
import { vim, Vim } from '@replit/codemirror-vim'
import { autoCloseInputHandler } from './auto-close'

const externalUpdate = Annotation.define<boolean>()

const highlightDark = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.typeName], color: '#c792ea', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#c3e88d' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#546e7a', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom, t.null], color: '#f78c6c' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.variableName, t.propertyName], color: '#eeffff' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#89ddff' },
  { tag: [t.className, t.namespace], color: '#ffcb6b' },
  { tag: [t.meta, t.processingInstruction], color: '#ff5370' },
])

const highlightLight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.typeName], color: '#7c4dff', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#2e7d32' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#90a4ae', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom, t.null], color: '#e64a19' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#1565c0' },
  { tag: [t.variableName, t.propertyName], color: '#212121' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#546e7a' },
  { tag: [t.className, t.namespace], color: '#c62828' },
  { tag: [t.meta, t.processingInstruction], color: '#d81b60' },
])

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

function useThemeMode(): 'dark' | 'light' {
  const [mode, setMode] = useState<'dark' | 'light'>(() => isDarkMode() ? 'dark' : 'light')
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setMode(isDarkMode() ? 'dark' : 'light')
    })
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return mode
}

function languageDescription(language: string) {
  const normalized = language.toLowerCase()
  return languages.find(lang =>
    lang.name.toLowerCase() === normalized || lang.alias?.some(alias => alias.toLowerCase() === normalized),
  )
}

export function useCodeEditor(
  parentRef: RefObject<HTMLDivElement | null>,
  value: string,
  language: string,
  editable: boolean,
  onChange: (value: string) => void,
  onSave?: () => void,
  onClose?: () => void,
) {
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const highlightCompartmentRef = useRef(new Compartment())
  const vimCompartmentRef = useRef(new Compartment())
  const autoCloseCompartmentRef = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const themeMode = useThemeMode()

  const highlightStyle = themeMode === 'dark' ? highlightDark : highlightLight

  const extensions = useMemo(() => [
    vimCompartmentRef.current.of(editable ? vim() : []),
    autoCloseCompartmentRef.current.of(editable ? autoCloseInputHandler : []),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    highlightCompartmentRef.current.of(syntaxHighlighting(highlightStyle)),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    EditorView.editable.of(editable),
    languageCompartmentRef.current.of([]),
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          onSaveRef.current?.()
          return true
        }
        // Escape in vim normal mode closes the preview.
        // In insert/visual mode, vim handles Escape itself (don't close).
        if (event.key === 'Escape') {
          try {
            const gs = (Vim as any).getVimGlobalState_?.()
            const mode = gs?.mode
            if (!mode || mode === 'normal') {
              event.preventDefault()
              onCloseRef.current?.()
              return true
            }
          } catch {
            // vim not loaded — close on Escape
            event.preventDefault()
            onCloseRef.current?.()
            return true
          }
        }
        return false
      },
    }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) {
        onChangeRef.current(update.state.doc.toString())
      }
    }),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: 'transparent' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' },
      '.cm-content': { padding: '16px 16px 40px', caretColor: 'var(--primary)' },
      '.cm-line': { lineHeight: '1.55' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: '0' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 7%, transparent)' },
      '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--primary) 42%, transparent)' },
      '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--foreground) 8%, transparent)', outline: '1px solid var(--muted-foreground)' },
      '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    }),
  ], [editable])

  useEffect(() => {
    const parent = parentRef.current
    if (!parent) return
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent })
    viewRef.current = view
    // Auto-focus the editor so keyboard input works immediately.
    requestAnimationFrame(() => view.focus())
    // Alias yank / delete / paste to the + register for system clipboard sync.
    if (editable) {
      for (const ctx of ['normal', 'visual'] as const) {
        for (const op of ['y', 'd']) Vim.noremap(op, `"+${op}`, ctx)
      }
      for (const op of ['p', 'P']) Vim.noremap(op, `"+${op}`, 'normal')
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [parentRef, extensions])

  // Reconfigure highlight compartment when theme changes (without recreating editor)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: highlightCompartmentRef.current.reconfigure(syntaxHighlighting(highlightStyle)),
    })
  }, [highlightStyle])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: externalUpdate.of(true) })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const description = languageDescription(language)
    let cancelled = false
    void (description ? description.load() : Promise.resolve([])).then(extension => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: languageCompartmentRef.current.reconfigure(extension) })
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [language])

  return viewRef
}
