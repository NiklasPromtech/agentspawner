import { defineConfig } from 'vite';
import { resolve } from 'path';

// Build each entry as a separate IIFE (no code splitting)
// Run with: vite build --config vite.config.ts
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        offscreen: resolve(__dirname, 'src/offscreen/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.ts'),
        flows_debugger: resolve(__dirname, 'src/flows-debugger/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => `${chunkInfo.name}/index.js`,
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
        // Use ES modules - Chrome MV3 supports ES modules in service workers
        format: 'es',
        inlineDynamicImports: false,
      },
    },
    target: 'es2022',
    minify: false,
  },
  publicDir: 'public',
});
