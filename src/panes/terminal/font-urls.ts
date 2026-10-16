// The pane owns the font faces it renders with: @zem-sh/terminal ships no font
// binaries, only the font store that loads them. These URLs are resolved by the
// bundler (Vite mirrors `new URL(…, import.meta.url)` into emitted assets), and
// the terminal's font store fetches them lazily with an IndexedDB cache.

export const FONT_URL_JETBRAINS_MONO = new URL('./fonts/JetBrainsMonoNLNerdFontMono-Regular.ttf', import.meta.url).href
export const FONT_URL_JETBRAINS_MONO_BOLD = new URL('./fonts/JetBrainsMonoNLNerdFontMono-Bold.ttf', import.meta.url).href
export const FONT_URL_JETBRAINS_MONO_ITALIC = new URL('./fonts/JetBrainsMonoNLNerdFontMono-Italic.ttf', import.meta.url).href
export const FONT_URL_JETBRAINS_MONO_BOLD_ITALIC = new URL('./fonts/JetBrainsMonoNLNerdFontMono-BoldItalic.ttf', import.meta.url).href
export const FONT_URL_NERD_SYMBOLS = new URL('./fonts/SymbolsNerdFontMono-Regular.ttf', import.meta.url).href
export const FONT_URL_NOTO_SYMBOLS = new URL('./fonts/NotoSansSymbols2-Regular.ttf', import.meta.url).href
export const FONT_URL_SYMBOLA = new URL('./fonts/Symbola.ttf', import.meta.url).href
export const FONT_URL_NOTO_CANADIAN_ABORIGINAL = new URL('./fonts/NotoSansCanadianAboriginal-Regular.ttf', import.meta.url).href
export const FONT_URL_OPENMOJI = new URL('./fonts/OpenMoji-black-glyf.ttf', import.meta.url).href
