import { useRef, useEffect } from 'react'
import { Send } from '@mynaui/icons-react'

interface CommitPanelProps {
  message: string
  onChange: (message: string) => void
  onCommit: () => Promise<void>
  loading: boolean
  disabled: boolean
}

export function CommitPanel({
  message,
  onChange,
  onCommit,
  loading,
  disabled,
}: CommitPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }, [message])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!loading && !disabled && message.trim()) {
        onCommit()
      }
    }
  }

  // Syncing (loading) must not change the panel's appearance — it only guards
  // the commit action. The `disabled` state (no changes) keeps its visual hint.
  const isDisabled = disabled || !message.trim()

  return (
    <div className='px-2 py-2'>
      <div className="flex gap-2 items-center  relative bg-card p-1 rounded-lg ">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              if (!loading) onChange(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Commit message..."
            className={`w-full resize-none p-1 text-xs outline-none transition-colors disabled:opacity-50`}
            rows={1}
            disabled={disabled}
            style={{ minHeight: '32px' }}
          />
        </div>
        <button
          onClick={() => {
            if (loading) return
            onCommit()
          }}
          disabled={disabled || !message.trim()}
          className={`flex items-center absolute bottom-[4px] right-[4px] gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${isDisabled
            ? 'bg-muted text-muted-foreground cursor-not-allowed'
            : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
        >
          <Send className="w-3.5 h-3.5" />
          Commit
        </button>

        <div className='absolute bottom-0 p-1 flex gap-4 items-center text-[10px] text-muted-foreground pointer-events-none'>
          <div>
            {message.trim() ? `${message.trim().split('\n').filter(Boolean).length} lines` : ''}
          </div>
          {message.trim() && !disabled && (
            <div>
              Press ⌘+Enter to commit
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
