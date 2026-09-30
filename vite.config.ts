import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/sand-garden/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
});
