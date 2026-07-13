import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  
  main: {},
  preload: {},
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 5930,
      strictPort: false // Allow fallback to another port if 5173 is in use
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    base: './', // ← CRITICAL: This makes paths relative
    build: {
      outDir: 'out/renderer', // ... other config
      
    }
  }
})
