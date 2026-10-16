import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { isSharedExternal } from './scripts/shared-runtime.mjs'

// One bundle for every built-in pane.
//
// Deliberately NOT `build.lib`: library mode force-inlines every asset as
// base64, which would turn the terminal's ~16MB of font faces (emitted via
// `new URL(..., import.meta.url)`) into a giant base64 blob inside index.js.
// A JS-entry build with `preserveEntrySignatures: 'strict'` keeps the entry's
// exports and emits the fonts as separate files under assets/, which the
// terminal font store fetches lazily.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    rollupOptions: {
      input: './src/index.tsx',
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        assetFileNames: 'assets/[name][extname]',
        inlineDynamicImports: true,
      },
      // Host-provided shared runtime (react, @zem-sh/pane, codemirror, zustand,
      // …) stays external; everything else (the Ghostty terminal core, the visx
      // charts, the icon packs) is bundled so the extension is self-contained.
      external: (id) => isSharedExternal(id),
    },
    cssCodeSplit: false,
    // No sourcemap in the shipped extension: pane source maps are only useful
    // when debugging the pane itself — rebuild with `--sourcemap` if needed.
    sourcemap: false,
  },
})
