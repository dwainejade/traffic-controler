import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour an externally assigned port (the preview harness sets PORT).
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
})
