import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour an externally assigned port (the preview harness sets PORT).
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      /*
       * The world store (`npm run world:serve`), proxied so the app's requests
       * are same-origin. Without this every level download is a cross-origin
       * request that has to be preflighted and CORS-approved, for a service
       * running on the same laptop.
       *
       * The store being down is normal — most people never run it — and the
       * proxy answers ECONNREFUSED, which `worldDb.ts` reads as "no store" and
       * falls back to OpenStreetMap.
       */
      "/api": {
        target: `http://localhost:${process.env.WORLD_PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
})
