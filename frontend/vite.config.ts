import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // 2D simulation page is served by the Java backend (classpath:/static/simulation.html)
      '/simulation.html': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
