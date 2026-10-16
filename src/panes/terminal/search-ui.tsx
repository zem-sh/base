import { useRef, useEffect, useCallback } from 'react'
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'

export interface TerminalSearchState {
  query: string
  active: boolean
  pending: boolean
  complete: boolean
  total: number
  selectedIndex: number | null
}

export interface TerminalSearchBarProps {
  open: boolean
  query: string
  onQueryChange: (query: string) => void
  searchState: TerminalSearchState
  onNext: () => void
  onPrevious: () => void
  onClear: () => void
  onClose: () => void
}

export function TerminalSearchBar({
  open,
  query,
  onQueryChange,
  searchState,
  onNext,
  onPrevious,
  onClear,
  onClose,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        onPrevious()
      } else {
        onNext()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [onNext, onPrevious, onClose])

  const hasMatches = searchState.active && searchState.total > 0
  const statusText = !query
    ? ''
    : searchState.pending
      ? '\u2026'
      : searchState.total <= 0
        ? '0'
        : searchState.selectedIndex !== null
          ? `${searchState.selectedIndex + 1}/${searchState.total}`
          : `${searchState.total}`

  if (!open) return null

  return (
    <div
      className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border bg-popover/95 p-1.5 shadow-lg backdrop-blur-sm"
      role="search"
      aria-label="Search terminal scrollback"
    >
      <Search className="size-3.5 text-muted-foreground shrink-0 ml-1" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in scrollback..."
        className="flex h-7 w-40 md:w-52 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
      {statusText && (
        <span
          className={`inline-flex items-center justify-center h-6 min-w-[2rem] px-1.5 rounded text-[10px] tabular-nums ${
            hasMatches
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground bg-muted/50'
          }`}
        >
          {statusText}
        </span>
      )}
      <button
        onClick={onPrevious}
        disabled={!hasMatches}
        title="Match above (Shift+Enter)"
        aria-label="Previous match"
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 size-7 shrink-0"
      >
        <ChevronUp className="size-3" />
      </button>
      <button
        onClick={onNext}
        disabled={!hasMatches}
        title="Match below (Enter)"
        aria-label="Next match"
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 size-7 shrink-0"
      >
        <ChevronDown className="size-3" />
      </button>
      <button
        onClick={onClear}
        disabled={!query}
        title="Clear search"
        aria-label="Clear search"
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 size-7 shrink-0"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
