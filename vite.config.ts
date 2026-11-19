import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** src/env.d.ts __BUILD__: written into the header and every update log. */
const BUILD = {
  version: (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version,
  channel: process.env.VITE_CHANNEL ?? '',
  commit: process.env.GITHUB_SHA?.slice(0, 7) ?? 'local',
  date: new Date().toISOString().slice(0, 10),
};

/**
 * Production CSP: the page may only talk to its own origin. This is the browser-enforced half of
 * "no network calls of any kind at runtime, and no telemetry" (docs/SPEC.md). Dev mode skips it
 * because Vite's HMR client needs inline scripts and a websocket.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'globe-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  // Relative asset URLs: the same build works on GitHub Pages (served from /<repo>/), on localhost and
  // from the shop-laptop folder.
  base: './',
  plugins: [react(), cspMeta()],
  define: {
    // Simulated-bike tools: in `npm run dev` and `npm run laptop` (VITE_DEV_TOOLS=1), never in the public build.
    __DEV_TOOLS__: JSON.stringify(command === 'serve' || process.env.VITE_DEV_TOOLS === '1'),
    __BUILD__: JSON.stringify(BUILD),
  },
  build: {
    target: 'es2022',
    // The firmware images must be emitted as files (fetched same-origin and hashed), never inlined.
    assetsInlineLimit: 0,
  },
}));
