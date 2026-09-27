import vinext from 'vinext';
import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';

// Separate from Sites: no mock sign-in, Site packaging, or trusted Sites edge.
export default defineConfig(async () => {
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    plugins: [vinext(), cloudflare({
      configPath: existsSync('./wrangler.standalone.local.json') ? './wrangler.standalone.local.json' : './wrangler.standalone.json',
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      inspectorPort: false,
    })],
  };
});
