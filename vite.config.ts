import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep the wallet stack in its own chunk. It changes far less often
        // than app code, so browsers keep it cached across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/wagmi|viem|@coinbase|@walletconnect|@metamask|ox\//.test(id)) return 'wallet'
          if (/react-dom|react-router|[\\/]react[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
})
