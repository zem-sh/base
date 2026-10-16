import type { InlineInput as InlineInputType } from '../types'

interface InlineInputProps {
  input: InlineInputType
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function InlineInput({ input, onSubmit, onCancel }: InlineInputProps) {
  return (
    <div className="absolute top-2 left-2 right-2 z-10 flex m-2 items-center gap-3 p-3 border border-border rounded-lg bg-card shadow-lg">
      <span className="text-muted-foreground shrink-0 w-4 text-center">
        {input.mode === 'create' ? '+' : '\u2192'}
      </span>
      <input
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck="false"
        className="flex-1 bg-transparent shadow-lg outline-none text-xs min-w-0 border-none"
        placeholder={input.mode === 'create' ? 'name (end with / for folder)...' : 'rename...'}
        defaultValue={input.mode === 'rename' ? input.name : ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSubmit((e.target as HTMLInputElement).value)
          } else if (e.key === 'Escape') {
            onCancel()
          }
          e.stopPropagation()
        }}
        onBlur={() => onCancel()}
      />
    </div>
  )
}
