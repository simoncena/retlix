import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so phones on the same Wi-Fi can connect (prints the Network URL)
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000', // the proxy runs on this machine, so localhost is fine
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
