import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import icon from 'astro-icon';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Project Pages: served at https://marlburrow.github.io/hivekeep/
export default defineConfig({
  site: 'https://marlburrow.github.io',
  base: '/hivekeep',
  integrations: [
    tailwind({ applyBaseStyles: false }), // we ship our own reset + tokens in global.css
    icon(),
    react(), // for @lobehub/icons (colored provider marks, SSR-only, no client JS)
    sitemap(), // emits sitemap-index.xml + sitemap-0.xml under the /hivekeep base
  ],
  vite: {
    // @lobehub/icons ships extensionless internal ESM imports — bundle it so Vite resolves them.
    ssr: { noExternal: ['@lobehub/icons'] },
  },
});
