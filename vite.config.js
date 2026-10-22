import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the same build works on GitHub Pages and inside the Android app.
  base: './',
  build: { target: 'es2020', outDir: 'dist' },
});
