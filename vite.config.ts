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
    { path: '/learn', title: `Lessons · ${SITE}`, description: `${LESSONS.length} short, hands-on lessons that take you from your first command to writing scripts, in a realistic terminal that checks your work.` },
    { path: '/playground', title: `Playground · ${SITE}`, description: 'A free practice Linux terminal in your browser. Try any command; nothing can break.' },
    { path: '/reference', title: `Command reference · ${SITE}`, description: 'Every command in the practice terminal explained in plain English, with options and examples.' },
    { path: '/glossary', title: `Glossary · ${SITE}`, description: 'Terminal and command-line jargon explained without jargon.' },
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), routeMeta()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
