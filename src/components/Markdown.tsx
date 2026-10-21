// Renders lesson/reference markdown. Inline code written as `$ cmd` becomes
// a clickable command that is typed into the terminal.

import { Marked } from 'marked';
import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';

const ICONS: Record<string, string> = {
  tip: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>',
  note: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  warn: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  how: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

const CALLOUTS: Record<string, { cls: string; label: string; icon: string }> = {
  TIP: { cls: 'callout-tip', label: 'Tip', icon: ICONS.tip },
  NOTE: { cls: '', label: 'Note', icon: ICONS.note },
  IMPORTANT: { cls: 'callout-warn', label: 'Important', icon: ICONS.warn },
  WARNING: { cls: 'callout-warn', label: 'Warning', icon: ICONS.warn },
  CAUTION: { cls: 'callout-danger', label: 'Careful', icon: ICONS.warn },
  HOW: { cls: 'callout-how', label: 'How it works', icon: ICONS.how },
};

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    codespan({ text }) {
      if (text.startsWith('$ ')) {
        const cmd = text.slice(2);
        return `<code class="runnable" data-cmd="${attr(decode(cmd))}" tabindex="0" role="button" title="Click to type this into the terminal">${cmd}</code>`;
      }
      return `<code>${text}</code>`;
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const external = /^https?:/.test(href);
      return `<a href="${attr(href)}"${external ? ' target="_blank" rel="noreferrer"' : ' data-internal="1"'}>${text}</a>`;
    },
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      const m = /^\s*<p>\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION|HOW)\]\s*/.exec(body);
      if (!m) return `<blockquote>${body}</blockquote>`;
      const c = CALLOUTS[m[1]];
      return `<div class="callout ${c.cls}">${c.icon}<div class="callout-body"><p><strong class="callout-label">${c.label}:</strong> ${body.slice(m[0].length)}</div></div>`;
    },
  },
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  let html = cache.get(src);
  if (html === undefined) {
    html = marked.parse(src.trim(), { async: false }) as string;
    if (cache.size > 400) cache.clear();
    cache.set(src, html);
  }
  return html;
}

export interface MarkdownProps {
  source: string;
  className?: string;
  /** Called when a `$ command` snippet is clicked. */
  onRun?: (command: string) => void;
  /** Called for internal links (so the router can handle them). */
  onNavigate?: (href: string) => void;
}

export function Markdown({ source, className, onRun, onNavigate }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const handle = (target: EventTarget | null, e: MouseEvent | KeyboardEvent) => {
    const el = target as HTMLElement | null;
    const code = el?.closest?.('code.runnable') as HTMLElement | null;
    if (code && onRun) {
      e.preventDefault();
      onRun(code.dataset.cmd ?? code.textContent ?? '');
      return;
    }
    const a = el?.closest?.('a[data-internal]') as HTMLAnchorElement | null;
    if (a && onNavigate && 'button' in e && e.button === 0 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onNavigate(a.getAttribute('href') ?? '/');
    }
  };
  return (
    <div
      className={`prose ${className ?? ''}`}
      onClick={(e) => handle(e.target, e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handle(e.target, e);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
