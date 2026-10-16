import { type ReactNode } from 'react'
import { SlidingNumber } from '../animate-ui/primitives/texts/sliding-number'

interface Badge {
  text: string
  color?: string
}

interface StatsCardProps {
  title: string
  icon: ReactNode
  badges?: Badge[]
  number?: number
  suffix?: string
  footer?: string[]
  children?: ReactNode
}

export function StatsCard({ title, icon, badges, number, suffix = '%', footer, children }: StatsCardProps) {
  return (
    <div className="flex flex-col rounded-md overflow-hidden p-1.5 sm:p-2 bg-card" >
      <div className="flex px-2 sm:px-3 items-center justify-between gap-1 text-[9px] sm:text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <div className="flex items-center gap-1.5 sm:gap-2">
          {icon}
          <span>{title}</span>
        </div>
        {badges && badges.length > 0 && (
          <div className="flex items-center gap-2 sm:gap-4">
            {badges.filter(b => b.text).map((badge, i) => (
              <span key={i} className="text-[8px] sm:text-[9px] truncate max-w-[60px] sm:max-w-none" style={{ color: badge.color }}>
                {badge.text}
              </span>
            ))}
          </div>
        )}
      </div>
      {number != null && (
        <div className="flex px-2 sm:px-4 py-2 sm:py-4 items-end gap-1">
          <SlidingNumber
            number={number}
            className="text-3xl sm:text-5xl font-bold text-foreground"
          />
          <span className="text-muted-foreground text-sm sm:text-lg">{suffix}</span>
        </div>
      )}
      <div className='w-full flex-1 flex items-center'>
        {children}
      </div>
      {footer && footer.length > 0 && (
        <div className="flex items-center px-2 sm:px-3 gap-2 sm:gap-3 text-[10px] sm:text-xs text-muted-foreground">
          {footer.map((text, i) => (
            <span key={i} className="truncate">{text}</span>
          ))}
        </div>
      )}
    </div>
  )
}
