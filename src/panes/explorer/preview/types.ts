export type ViewerKind = 'image' | 'audio' | 'code' | 'raw'

export interface ViewerPayload {
  kind?: ViewerKind
  url?: string
  data?: string
  encoding?: 'utf8' | 'base64'
  mimeType?: string
  filename?: string
  language?: string
  title?: string
  editable?: boolean
  source?: string
  path?: string
}

export interface NormalizedViewerPayload {
  kind: ViewerKind
  url?: string
  data?: string
  encoding: 'utf8' | 'base64'
  mimeType: string
  filename: string
  language: string
  title: string
  editable: boolean
  source?: string
  path?: string
}

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
const AUDIO_TYPES = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm'])
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
}
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json',
  rs: 'rust', py: 'python', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  md: 'markdown', markdown: 'markdown', toml: 'toml', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql',
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() || value
}

function extension(value: string): string {
  return basename(value).split('.').pop()?.toLowerCase() ?? ''
}

function inferKind(payload: ViewerPayload, name: string): ViewerKind {
  if (payload.kind) return payload.kind
  const mime = payload.mimeType?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  return IMAGE_TYPES.has(extension(name)) ? 'image'
    : AUDIO_TYPES.has(extension(name)) ? 'audio'
    : 'code'
}

export function languageForPayload(payload: ViewerPayload, name: string): string {
  return payload.language || LANGUAGE_BY_EXTENSION[extension(name)] || 'text'
}

export function normalizeViewerPayload(raw: Record<string, unknown> | undefined): NormalizedViewerPayload | null {
  const payload = (raw ?? {}) as ViewerPayload
  const source = typeof payload.url === 'string' ? payload.url : payload.source
  const filename = payload.filename || (payload.url ? basename(payload.url) : 'Untitled')
  const kind = inferKind(payload, filename)
  const mimeType = payload.mimeType || MIME_BY_EXTENSION[extension(filename)] || (kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'text/plain')
  return {
    kind,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    data: typeof payload.data === 'string' ? payload.data : undefined,
    encoding: payload.encoding === 'base64' ? 'base64' : 'utf8',
    mimeType,
    filename,
    language: languageForPayload(payload, filename),
    title: payload.title || filename,
    editable: payload.editable === true && kind === 'code',
    source,
    path: typeof payload.path === 'string' ? payload.path : undefined,
  }
}

export function inlineUrl(payload: NormalizedViewerPayload): string | null {
  if (payload.url) return payload.url
  if (payload.data == null) return null
  if (payload.kind === 'code' || payload.kind === 'raw') {
    return `data:${payload.mimeType};charset=utf-8,${encodeURIComponent(payload.data)}`
  }
  if (payload.encoding === 'base64') return `data:${payload.mimeType};base64,${payload.data}`
  return `data:${payload.mimeType};charset=utf-8,${encodeURIComponent(payload.data)}`
}
