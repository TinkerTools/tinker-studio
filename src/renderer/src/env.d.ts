/// <reference types="vite/client" />

import type { TinkerApi } from '../../preload'

declare global {
  interface Window {
    tinker: TinkerApi
  }
}
