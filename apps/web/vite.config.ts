import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Sin esto Vite escucha solo en IPv6 (::1). Windows y muchos navegadores
    // resuelven localhost a IPv4 (127.0.0.1), se connectan a una direccion
    // distinta y devuelven 502 aunque el servidor este sano.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // El proxy evita configurar CORS y hace que las rutas de artefactos
    // (imagenes, audio, mp4) funcionen igual en desarrollo que en produccion.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/storage': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
});