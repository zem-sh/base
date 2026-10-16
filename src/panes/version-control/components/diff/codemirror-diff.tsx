import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { lineNumbers, EditorView, keymap } from '@codemirror/view'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'

// @codemirror/merge embeds its styles (cm-mergeView, cm-changedLine, …) in the
// bundle itself — no separate stylesheet import needed.

export interface DiffViewSettings {
  layout: 'stacked' | 'split'
  showLineNumbers: boolean
  wordWrap: boolean
  showBackground: boolean
  indicatorStyle: 'bars' | 'classic' | 'none'
}

interface CodemirrorDiffProps {
  oldContent: string | null
  newContent: string | null
  filePath: string
  settings: DiffViewSettings
}

// ── Syntax highlighting (dark/light, matching the app theme) ────────────────

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
  const [mode, setMode] = useState<'dark' | 'light'>(() => (isDarkMode() ? 'dark' : 'light'))
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => setMode(isDarkMode() ? 'dark' : 'light'))
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return mode
}

// ── Language detection (from file name/extension) ───────────────────────────

function languageForPath(filePath: string) {
  const name = (filePath.split('/').pop() ?? filePath).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return (
    languages.find(
      (lang) =>
        lang.name.toLowerCase() === name ||
        lang.alias?.some((a) => a.toLowerCase() === name) ||
        lang.extensions?.some((e) => e.toLowerCase() === ext),
    ) ?? undefined
  )
}

// ── Editor extensions ───────────────────────────────────────────────────────

function editorExtensions(opts: {
  settings: DiffViewSettings
  highlightStyle: HighlightStyle
  languageComp: Compartment
}): Extension[] {
  const { settings, highlightStyle, languageComp } = opts
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    ...(settings.showLineNumbers ? [lineNumbers()] : []),
    ...(settings.wordWrap ? [EditorView.lineWrapping] : []),
    languageComp.of([]),
    syntaxHighlighting(highlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      { key: 'Mod-g', run: goToNextChunk },
      { key: 'Mod-Shift-g', run: goToPreviousChunk },
    ]),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: 'transparent', fontSize: '12px' },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        lineHeight: '1.55',
      },
      '.cm-content': { padding: '8px 0', caretColor: 'transparent' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: '0' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-selectionBackground': { backgroundColor: 'transparent' },
      '.cm-cursor': { borderLeftColor: 'transparent' },
      '.cm-mergeView': { height: '100%' },
      '.cm-mergeViewEditors': { height: '100%' },
      '.cm-mergeView .cm-changedLine': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 10%, transparent)',
      },
      '.cm-mergeView .cm-changedText': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 20%, transparent)',
      },
    }),
  ]
}

function mergeOptions(settings: DiffViewSettings) {
  return {
    gutter: settings.indicatorStyle !== 'none',
    highlightChanges: settings.showBackground || settings.indicatorStyle === 'classic',
    collapseUnchanged: { margin: 3, minSize: 4 },
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export function CodemirrorDiff({ oldContent, newContent, filePath, settings }: CodemirrorDiffProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const themeMode = useThemeMode()
  const highlightStyle = themeMode === 'dark' ? highlightDark : highlightLight

  useEffect(() => {
    const parent = parentRef.current
    if (!parent) return

    const languageComp = new Compartment()
    const extensions = editorExtensions({ settings, highlightStyle, languageComp })
    const editors: EditorView[] = []
    let view: MergeView | EditorView | null = null

    if (settings.layout === 'split') {
      view = new MergeView({
        parent,
        a: { doc: oldContent ?? '', extensions },
        b: { doc: newContent ?? '', extensions },
        ...mergeOptions(settings),
      })
      editors.push(view.a, view.b)
    } else {
      view = new EditorView({
        parent,
        doc: newContent ?? '',
        extensions: [
          ...extensions,
          unifiedMergeView({
            original: oldContent ?? '',
            mergeControls: false,
            ...mergeOptions(settings),
          }),
        ],
      })
      editors.push(view)
    }

    let cancelled = false
    const language = languageForPath(filePath)
    if (language) {
      language
        .load()
        .then((extension) => {
          if (cancelled) return
          for (const editor of editors) {
            if (!editor.dom.isConnected) continue
            editor.dispatch({ effects: languageComp.reconfigure(extension) })
          }
        })
        .catch(() => {})
    }

    return () => {
      cancelled = true
      view?.destroy()
    }
  }, [oldContent, newContent, filePath, settings, highlightStyle])

  return <div ref={parentRef} className="h-full overflow-auto" />
}
