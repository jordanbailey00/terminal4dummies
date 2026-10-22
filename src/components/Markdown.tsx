// Renders lesson/reference markdown. Inline code written as `$ cmd` becomes
// a clickable command that is typed into the terminal.

import { Marked } from 'marked';
import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';

const CALLOUTS: Record<string, { cls: string; label: string }> = {
  TIP: { cls: 'callout-tip', label: 'tip' },
  NOTE: { cls: '', label: 'note' },
  IMPORTANT: { cls: 'callout-warn', label: 'important' },
  WARNING: { cls: 'callout-warn', label: 'warning' },
  CAUTION: { cls: 'callout-danger', label: 'careful' },
  HOW: { cls: 'callout-how', label: 'how it works' },
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
      return `<div class="callout ${c.cls}"><p><span class="callout-label">${c.label}:</span> ${body.slice(m[0].length)}</div>`;
    },
  },
});

const cache = new Map<string, string>();

/** Markdown to HTML; `inline` renders a single line without a surrounding paragraph. */
export function renderMarkdown(src: string, inline = false): string {
  const key = (inline ? 'i:' : 'b:') + src;
  let html = cache.get(key);
  if (html === undefined) {
    html = (inline ? marked.parseInline(src.trim(), { async: false }) : marked.parse(src.trim(), { async: false })) as string;
    if (cache.size > 400) cache.clear();
    cache.set(key, html);
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
  /** One line of text (rendered in a <span>, without a paragraph). */
  inline?: boolean;
}

export function Markdown({ source, className, onRun, onNavigate, inline }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(source, inline), [source, inline]);
  if (inline) return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
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
