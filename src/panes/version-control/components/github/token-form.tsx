import { useState } from 'react'
import { Key, Eye, Lock } from '@mynaui/icons-react'
import { cn } from '../../utils'
import { Button } from '../ui/button'

interface TokenFormProps {
  loading: boolean
  onSave: (token: string) => Promise<boolean>
  onClear?: () => void
}

export function TokenForm({ loading, onSave, onClear }: TokenFormProps) {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [focused, setFocused] = useState(false)

  const handleSave = async () => {
    const ok = await onSave(token)
    if (ok) {
      setToken('')
    }
  }

  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Key className="w-3.5 h-3.5 text-muted-foreground" />
        <span>Connect to GitHub</span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Paste a personal access token to browse pull requests and issues. Tokens are
        stored in the addon's settings. Create one at{' '}
        <a
          className="text-primary hover:underline"
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
        >
          github.com/settings/tokens
        </a>{' '}
        with <code className="text-foreground/70">repo</code> scope.
      </p>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            spellCheck={false}
            className={cn(
              'w-full h-7 rounded-md border bg-background px-2 pr-8 text-xs outline-none transition-colors placeholder:text-muted-foreground/50',
              focused ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'
            )}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && token.trim()) {
                handleSave()
              }
            }}
          />
          <button
            onClick={() => setShow((s) => !s)}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title={show ? 'Hide token' : 'Show token'}
          >
            {show ? <Lock className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={loading || !token.trim()}
        >
          {loading ? 'Connecting...' : 'Save'}
        </Button>
        {onClear && (
          <Button size="sm" variant="outline" onClick={onClear} disabled={loading}>
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}
