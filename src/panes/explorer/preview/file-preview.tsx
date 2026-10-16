import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { Copy, Download, X, Maximize, Minimize, Music2, PanelRight, ChevronLeft, FileCode2, HardDrive, CircleDot, FileText, Save } from 'lucide-react'
import { Button } from '../components/ui/button'
import { useCodeEditor } from './editor'
import { inlineUrl, type NormalizedViewerPayload } from './types'

interface FilePreviewProps {
  payload: NormalizedViewerPayload
  content: string
  expanded: boolean
  viewerOnly?: boolean
  onCopy: () => void
  onDownload: () => void
  onClose: () => void
  onToggleExpand: () => void
  onOpenInNewPane?: () => void
  onOpenInNotes?: () => void
  onBack?: () => void
  onContentChange?: (content: string) => void
  onSave?: () => void
}

export function FilePreview({ payload, content, expanded, viewerOnly, onCopy, onDownload, onClose, onToggleExpand, onOpenInNewPane, onOpenInNotes, onBack, onContentChange, onSave }: FilePreviewProps) {
  const editorHostRef = useRef<HTMLDivElement>(null)
  const [editedContent, setEditedContent] = useState(content)
  const isDirty = editedContent !== content

  // Sync when opening a new file
  useEffect(() => { setEditedContent(content) }, [content])

  const handleContentChange = useCallback((value: string) => {
    setEditedContent(value)
    onContentChange?.(value)
  }, [onContentChange])

  useCodeEditor(
    payload.kind === 'code' ? editorHostRef : { current: null },
    editedContent,
    payload.language,
    true, // always editable
    handleContentChange,
    onSave,
    onClose,
  )

  // Escape closes non-code previews. Code previews handle Escape inside
  // the editor (respects vim mode — insert→normal before closing).
  useEffect(() => {
    if (viewerOnly) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editorHostRef.current?.contains(document.activeElement)) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, viewerOnly])

  const byteLength = useMemo(() => new TextEncoder().encode(editedContent).length, [editedContent])

  const renderBody = () => {
    if (payload.kind === 'image') {
      return (
        <div className="flex items-center justify-center w-full min-h-full p-6 bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:18px_18px]">
          <img className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" src={inlineUrl(payload) ?? undefined} alt={payload.filename} />
        </div>
      )
    }
    if (payload.kind === 'audio') {
      return (
        <div className="flex items-center justify-center min-h-full p-8">
          <div className="space-y-3 text-center">
            <Music2 className="mx-auto size-10 text-primary/70" />
            <audio className="w-[min(34rem,100%)]" controls src={inlineUrl(payload) ?? undefined} />
          </div>
        </div>
      )
    }
    if (payload.kind === 'code') {
      return <div ref={editorHostRef} className="w-full h-full" />
    }
    return (
      <div className="w-full h-full overflow-auto">
        <pre className="m-0 px-4 py-4 pb-12 whitespace-pre-wrap overflow-x-auto font-mono text-[0.8rem] leading-relaxed">{content}</pre>
      </div>
    )
  }

  const ExpandIcon = expanded ? Minimize : Maximize
  const isFullscreen = expanded || viewerOnly
  const containerClass = viewerOnly
    ? 'flex-1 flex flex-col bg-background'
    : 'bg-muted/20 border-t border-border flex flex-col'
  const containerStyle = !viewerOnly && isFullscreen
    ? { flex: 1 }
    : !viewerOnly
      ? { height: '40%', minHeight: 120 }
      : undefined

  return (
    <div className={containerClass} style={containerStyle}>
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 p-2 shrink-0 min-w-0">
        {onBack && (
          <Button onClick={onBack} variant="outline" size="icon-lg" title="Back to explorer">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs p-2 rounded-lg border border-border dark:bg-input/20">
          <FileCode2 className="size-3.5 inline-block mr-1.5 text-primary align-text-bottom" />
          {payload.title}
          {isDirty && <span className="ml-1.5 text-amber-400">●</span>}
        </div>
        {onSave && isDirty && (
          <Button onClick={onSave} variant="outline" size="icon-lg" title="Save (⌘S)">
            <Save className="size-4" />
          </Button>
        )}
        <Button onClick={() => { navigator.clipboard.writeText(editedContent).then(() => onCopy()) }} variant="outline" size="icon-lg" title="Copy content">
          <Copy className="size-4" />
        </Button>
        <Button onClick={onDownload} variant="outline" size="icon-lg" title="Download">
          <Download className="size-4" />
        </Button>
        {onOpenInNotes && (
          <Button onClick={onOpenInNotes} variant="outline" size="icon-lg" title="Open in Notes">
            <FileText className="size-4" />
          </Button>
        )}
        {!viewerOnly && onOpenInNewPane && (
          <Button onClick={onOpenInNewPane} variant="outline" size="icon-lg" title="Open in new pane">
            <PanelRight className="size-4" />
          </Button>
        )}
        {!viewerOnly && (
          <Button onClick={onToggleExpand} variant="outline" size="icon-lg" title={expanded ? 'Collapse' : 'Expand'}>
            <ExpandIcon className="size-4" />
          </Button>
        )}
        {!viewerOnly && (
          <Button onClick={onClose} variant="outline" size="icon-lg" title="Close">
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {renderBody()}
      </div>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div className="shrink-0 p-2 font-medium text-muted-foreground flex items-center gap-2 border-t border-border">
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          <FileCode2 className="size-3.5 inline-block mr-1 align-text-bottom" />{payload.kind}
        </span>
        {payload.language && payload.kind === 'code' && (
          <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
            <CircleDot className="size-3.5 inline-block mr-1 text-primary align-text-bottom" />{payload.language}
          </span>
        )}
        <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20">
          <HardDrive className="size-3.5 inline-block mr-1 align-text-bottom" />{byteLength.toLocaleString()} bytes
        </span>
        {payload.path && (
          <span className="shrink-0 px-2 py-1 text-foreground/70 rounded-xl border border-border dark:bg-input/20 truncate" title={payload.path}>
            {payload.path}
          </span>
        )}
      </div>
    </div>
  )
}
