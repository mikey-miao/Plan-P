import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config tailored for a Chrome extension popup page.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html'
    }
  }
});
