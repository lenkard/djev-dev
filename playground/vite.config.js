import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: Object.fromEntries(['/v1', '/health', '/ready'].map(path =>
    [path, { target: 'http://127.0.0.1:8000', changeOrigin: false }])) },
  build: { minify: true, sourcemap: false, target: 'es2022' }
});
