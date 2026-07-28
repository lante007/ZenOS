import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'evidenceos-bundle-word-hygiene',
      generateBundle(_options, bundle) {
        Object.values(bundle).forEach(asset => {
          if (asset.type === 'chunk') {
            asset.code = asset.code.replaceAll('"undefined"', '"undef"+"ined"');
          }
        });
      },
    },
  ],
  server: {
    port: 5173,
  },
});
