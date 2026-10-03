import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.MY_API_KEY': JSON.stringify(env.MY_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
            hmr: process.env.DISABLE_HMR !== 'true',
            port: 5173,
            proxy: {
                // In dev the SPA runs on Vite (:5173) while the API runs on
                // Express (:5000); proxy /api so relative apiFetch() calls work.
                '/api': {
                    target: process.env.VITE_API_PROXY || 'http://localhost:5000',
                    changeOrigin: true,
                },
                '/uploads': {
                    target: process.env.VITE_API_PROXY || 'http://localhost:5000',
                    changeOrigin: true,
                },
            },
    },
  };
});
