import { useState } from 'react'
import { Plus, X } from '@mynaui/icons-react'
import { cn } from '../../utils'
import { Button } from '../ui/button'

interface CreatePrFormProps {
  head: string
  defaultBase: string
  loading: boolean
  onSubmit: (title: string, body?: string, base?: string) => Promise<boolean>
  onCancel: () => void
}

export function CreatePrForm({
  head,
  defaultBase,
  loading,
  onSubmit,
  onCancel,
}: CreatePrFormProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState(defaultBase)
  const [titleFocused, setTitleFocused] = useState(false)

  if (!open) {
    return (
      <div className="shrink-0 px-3 py-1.5 border-b border-border">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          className="w-full justify-center"
        >
          <Plus className="w-3.5 h-3.5" />
          New Pull Request
        </Button>
      </div>
    )
  }

  const handleSubmit = async () => {
    if (!title.trim()) return
    const ok = await onSubmit(title.trim(), body.trim() || undefined, base.trim() || undefined)
    if (ok) {
      setTitle('')
      setBody('')
      setOpen(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-border px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Create Pull Request</span>
        <button
          onClick={onCancel}
          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="rounded bg-accent px-1 py-px text-foreground/70 truncate max-w-32">{head}</span>
        <span className="text-muted-foreground/60">into</span>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          spellCheck={false}
          className="h-5 w-24 rounded border border-border bg-background px-1.5 text-[10px] outline-none focus:border-primary/50"
        />
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setTitleFocused(true)}
        onBlur={() => setTitleFocused(false)}
        placeholder="PR title"
        spellCheck={false}
        className={cn(
          'h-7 w-full rounded-md border bg-background px-2 text-xs outline-none transition-colors placeholder:text-muted-foreground/50',
          titleFocused ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'
        )}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) {
            handleSubmit()
          }
        }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
      />
      <div className="flex items-center gap-1.5 justify-end">
        <Button size="xs" variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button size="xs" onClick={handleSubmit} disabled={loading || !title.trim()}>
          {loading ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
