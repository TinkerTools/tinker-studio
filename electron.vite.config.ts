import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    },
    build: {
      rollupOptions: {
        // The main app plus detachable Jobs and Modeling Commands windows (each
        // its own OS window / renderer entry).
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          jobs: resolve(__dirname, 'src/renderer/jobs.html'),
          commands: resolve(__dirname, 'src/renderer/commands.html')
        }
      }
    },
    plugins: [react()]
  }
})
