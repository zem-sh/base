/**
 * Git conflict-marker parsing and resolution. Pure string logic (no React).
 */

export type Resolution = 'current' | 'incoming' | 'both'

export type ConflictSegment =
  | { type: 'text'; content: string }
  | { type: 'conflict'; current: string; incoming: string }

/** Split raw file contents into text segments and git conflict blocks
 *  (`<<<<<<<`, `=======`, `>>>>>>>` markers). Marker lines are dropped. */
export function parseConflictContent(content: string): ConflictSegment[] {
  const segments: ConflictSegment[] = []
  const lines = content.split('\n')
  const flush = (buffer: string[]) => {
    if (buffer.length > 0) {
      segments.push({ type: 'text', content: buffer.join('\n') })
    }
  }

  let i = 0
  let buffer: string[] = []
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      flush(buffer)
      buffer = []
      i++
      const current: string[] = []
      while (i < lines.length && !lines[i].startsWith('=======')) {
        current.push(lines[i])
        i++
      }
      i++ // skip the `=======` separator (or run off the end)
      const incoming: string[] = []
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
        incoming.push(lines[i])
        i++
      }
      i++ // skip the `>>>>>>>` closing marker
      segments.push({ type: 'conflict', current: current.join('\n'), incoming: incoming.join('\n') })
    } else {
      buffer.push(lines[i])
      i++
    }
  }
  flush(buffer)
  return segments
}

export function resolveSegment(segment: Extract<ConflictSegment, { type: 'conflict' }>, resolution: Resolution): string {
  if (resolution === 'current') return segment.current
  if (resolution === 'incoming') return segment.incoming
  return [segment.current, segment.incoming].filter((s) => s !== '').join('\n')
}

/** Serialize segments back to file content. Unresolved conflicts keep their
 *  git marker blocks. */
export function segmentsToContent(segments: ConflictSegment[]): string {
  return segments
    .map((s) => {
      if (s.type === 'text') return s.content
      return `<<<<<<< \n${s.current}\n=======\n${s.incoming}\n>>>>>>> `
    })
    .join('\n')
}
