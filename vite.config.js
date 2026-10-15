// Конфигурация Vite (необязательна): проект работает и без сборки,
// достаточно любого статического сервера. Vite даёт HMR и минификацию.
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Разносим модули по папкам — проще дебажить и кэшировать
        manualChunks: undefined,
      },
    },
  },
});