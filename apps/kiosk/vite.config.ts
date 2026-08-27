import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // The packaged kiosk is loaded from a file:// URL, where root-absolute asset
  // paths resolve against the filesystem root and the window renders blank.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
