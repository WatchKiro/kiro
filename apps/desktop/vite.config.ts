import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Set by the Tauri CLI when developing on a physical/mobile device.
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Keep Rust compiler output visible when run through `tauri dev`.
  clearScreen: false,
  // VITE_* and TAURI_ENV_* variables are exposed to the renderer. They are public.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5173,
    strictPort: true,
    host: devHost || false,
    hmr: devHost ? { protocol: 'ws', host: devHost, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
