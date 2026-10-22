import react from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runnerImport, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import type { Lesson } from './src/lessons/types.ts';

const SITE = 'terminal4dummies';

interface RouteMeta {
  path: string;
  title: string;
  description: string;
}

function routes(LESSONS: Lesson[]): RouteMeta[] {
  return [
    { path: '/learn', title: `Lessons · ${SITE}`, description: `${LESSONS.length} lessons on the Linux command line, each with a simulated terminal that checks your work.` },
    { path: '/reference', title: `Command reference · ${SITE}`, description: 'Commands available in the practice terminal, with options and examples.' },
    ...LESSONS.map((l) => ({ path: `/learn/${l.id}`, title: `${l.title} · ${SITE}`, description: l.summary })),
  ];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Write a copy of index.html per route with the right <title> and description (for search engines and link previews). */
function routeMeta(): Plugin {
  let outDir = 'dist';
  return {
    name: 't4d-route-meta',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      // loaded here (through Vite) rather than imported by this config file
      const { module } = await runnerImport<{ LESSONS: Lesson[] }>('/src/lessons/index.ts', { configFile: false, logLevel: 'silent' });
      const index = readFileSync(join(outDir, 'index.html'), 'utf8');
      for (const r of routes(module.LESSONS)) {
        const html = index
          .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(r.title)}</title>`)
          .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeHtml(r.description)}$2`)
          .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(r.title)}$2`)
          .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeHtml(r.description)}$2`);
        const file = join(outDir, r.path, 'index.html');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, html);
      }
    },
  };
}

/**
 * The site's look, modeled on commitmono.com (src/skins/commit), layered over
 * the original styles. `--mode classic` (npm run dev:classic, build:classic)
 * leaves it out and gives the original look.
 */
function commitSkin(): Plugin {
  return {
    name: 't4d-commit-skin',
    transformIndexHtml: {
      // before Vite processes the page, so the script is bundled in builds
      order: 'pre',
      handler: (html) => ({
        // set up front so the first paint already has the skin (light unless
        // the visitor picked dark: the inline script in index.html sees to that)
        html: html
          .replace('<html lang="en">', '<html lang="en" data-skin="commit" data-theme="light">')
          .replace('<meta name="theme-color" content="#0c0c0c" />', '<meta name="theme-color" content="#aaaaaa" />'),
        // in <head>, so it runs before /src/main.tsx
        tags: [{ tag: 'script', attrs: { type: 'module', src: '/src/skins/commit/index.ts' }, injectTo: 'head' }],
      }),
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), routeMeta(), mode !== 'classic' && commitSkin()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
}));
