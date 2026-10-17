import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';

export default defineConfig({
  publicDir: '.cloudflare/assets',
  server: {host: 'localhost', port: 8787, strictPort: true},
  plugins: [cloudflare()],
});
