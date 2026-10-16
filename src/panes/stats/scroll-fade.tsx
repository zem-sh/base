import { useState, useRef, useEffect } from "react"

export function ScrollFade({ children, className, style, ...props }: { children: React.ReactNode; className?: string; style?: React.CSSProperties } & React.ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null)
  const [atTop, setAtTop] = useState(true)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      setAtTop(el.scrollTop <= 2)
      setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [])

  const bgColor = "var(--card)"
  const topFade = atTop ? `${bgColor} 0%` : "transparent 0%"
  const topEnd = atTop ? `${bgColor} 0px` : `${bgColor} 32px`
  const botStart = atBottom ? `${bgColor} calc(100% - 0px)` : `${bgColor} calc(100% - 32px)`
  const botFade = atBottom ? `${bgColor} 100%` : "transparent 100%"

  const mask = `linear-gradient(to bottom, ${topFade}, ${topEnd}, ${botStart}, ${botFade})`

  return (
    <div ref={ref} className={`overflow-y-auto scrollbar-thin min-h-0 flex-1 ${className ?? ""}`} style={{ ...style, maskImage: mask, WebkitMaskImage: mask }} {...props}>
      {children}
    </div>
  )
}
