import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any sub-path (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
});
