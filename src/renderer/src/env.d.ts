/// <reference types="vite/client" />

import type { FFEApi } from '../../preload'

declare global {
  interface Window {
    ffe: FFEApi
  }
}
