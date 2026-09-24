import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: false,
    watch: {
      // Atomic-write editors create short-lived `.name.<pid>.tmpdir/` folders
      // inside the project; watching them races with the rename and throws
      // EBUSY on Windows, which kills the dev server.
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/dist/**'],
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
})
