import { Columns, Hash, GitBranch, List, Grid, TextJustify } from '@mynaui/icons-react'

export interface DiffSettings {
  layout: 'stacked' | 'split'
  showLineNumbers: boolean
  wordWrap: boolean
  showBackground: boolean
  indicatorStyle: 'bars' | 'classic' | 'none'
}

interface DiffSettingsProps {
  settings: DiffSettings
  onChange: (settings: DiffSettings) => void
}

interface SettingToggleProps {
  label: string
  icon?: React.ReactNode
  value: boolean
  onChange: (value: boolean) => void
}

function SettingToggle({ label, icon, value, onChange }: SettingToggleProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 rounded border-border bg-background text-primary focus:ring-1 focus:ring-primary"
      />
      {icon && <span className="text-muted-foreground">{icon}</span>}
      <span className="text-xs">{label}</span>
    </label>
  )
}

interface RadioGroupProps {
  label: string
  value: string
  options: Array<{ value: string; label: string; icon?: React.ReactNode }>
  onChange: (value: string) => void
}

function RadioGroup({ label, value, options, onChange }: RadioGroupProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={`px-2 py-0.5 rounded text-xs flex items-center gap-1 transition-colors ${
              value === option.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent'
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function DiffSettings({ settings, onChange }: DiffSettingsProps) {
  const update = (key: keyof DiffSettings, value: any) => {
    onChange({ ...settings, [key]: value })
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <RadioGroup
        label="Layout"
        value={settings.layout}
        options={[
          { value: 'stacked', label: 'Stacked', icon: <Grid className="w-3 h-3" /> },
          { value: 'split', label: 'Split', icon: <Columns className="w-3 h-3" /> },
        ]}
        onChange={(val) => update('layout', val)}
      />

      <RadioGroup
        label="Indicators"
        value={settings.indicatorStyle}
        options={[
          { value: 'bars', label: 'Bars', icon: <List className="w-3 h-3" /> },
          { value: 'classic', label: 'Classic' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(val) => update('indicatorStyle', val)}
      />

      <div className="flex items-center gap-3">
        <SettingToggle
          label="Line numbers"
          icon={<Hash className="w-3 h-3" />}
          value={settings.showLineNumbers}
          onChange={(val) => update('showLineNumbers', val)}
        />

        <SettingToggle
          label="Word wrap"
          icon={<TextJustify className="w-3 h-3" />}
          value={settings.wordWrap}
          onChange={(val) => update('wordWrap', val)}
        />

        <SettingToggle
          label="Background"
          icon={<GitBranch className="w-3 h-3" />}
          value={settings.showBackground}
          onChange={(val) => update('showBackground', val)}
        />
      </div>
    </div>
  )
}