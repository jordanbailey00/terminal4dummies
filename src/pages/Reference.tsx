import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { usePageTitle } from '../components/usePageTitle';
import { Link, navigate, useLocation } from '../router';
import { BUILTIN_HELP } from '../shell/builtins';
import { COMMANDS } from '../shell/commands';
import { PACKAGES } from '../shell/packages';
import type { CommandCategory } from '../shell/types';

interface Entry {
  name: string;
  builtin: boolean;
  alsoBuiltin: boolean;
  category: CommandCategory;
  summary: string;
  synopsis: string[];
  description: string;
  options: { flags: string; desc: string }[];
  examples: { cmd: string; desc: string }[];
  seeAlso: string[];
  tip?: string;
  install?: string;
}

const CATEGORY_TITLES: Record<CommandCategory, string> = {
  navigation: 'Moving around',
  files: 'Files and folders',
  viewing: 'Viewing files',
  search: 'Searching',
  text: 'Text processing',
  permissions: 'Permissions and users',
  processes: 'Processes and jobs',
  system: 'System information',
  shell: 'Shell features',
  network: 'Networking',
  archives: 'Archives and compression',
  packages: 'Installing software',
  help: 'Getting help',
  fun: 'Just for fun',
};

const ORDER: CommandCategory[] = ['navigation', 'files', 'viewing', 'search', 'text', 'help', 'permissions', 'shell', 'processes', 'system', 'packages', 'archives', 'network', 'fun'];

const BUILTIN_CATEGORY: Record<string, CommandCategory> = {
  cd: 'navigation',
  pwd: 'navigation',
  pushd: 'navigation',
  popd: 'navigation',
  dirs: 'navigation',
  jobs: 'processes',
  fg: 'processes',
  bg: 'processes',
  wait: 'processes',
  kill: 'processes',
  disown: 'processes',
  help: 'help',
  type: 'help',
  history: 'shell',
};

const BUILTIN_TIPS: Record<string, string> = {
  cd: 'cd on its own takes you home; cd .. goes up one folder; cd - goes back to where you were.',
  history: 'Press the up arrow to step through history, or Ctrl+R to search it.',
  alias: "Aliases vanish when the shell exits. Put them in ~/.bashrc to keep them.",
  export: 'Only exported variables are passed on to the programs you run.',
  help: 'Builtins like cd have no man page; help cd describes them.',
};

const BUILTIN_EXAMPLES: Record<string, { cmd: string; desc: string }[]> = {
  cd: [
    { cmd: 'cd Documents', desc: 'Go into the Documents folder.' },
    { cmd: 'cd ..', desc: 'Go up one level.' },
    { cmd: 'cd', desc: 'Go to your home folder.' },
  ],
  alias: [{ cmd: "alias ll='ls -alF'", desc: 'Make ll a shortcut for ls -alF.' }],
  export: [{ cmd: 'export EDITOR=nano', desc: 'Set a variable and pass it on to programs.' }],
  history: [{ cmd: 'history 10', desc: 'Show the last 10 commands.' }],
  echo: [{ cmd: 'echo $HOME', desc: 'Print the value of a variable.' }],
  jobs: [{ cmd: 'jobs', desc: 'List background and stopped jobs.' }],
  fg: [{ cmd: 'fg %1', desc: 'Bring job 1 back to the foreground.' }],
  type: [{ cmd: 'type ls cd', desc: 'Is it an alias, a builtin or a program?' }],
};

function buildEntries(): Entry[] {
  const installHint = new Map<string, string>();
  for (const p of PACKAGES) {
    if (!p.preinstalled && p.available) for (const c of p.commands) installHint.set(c.name, p.name);
  }
  const map = new Map<string, Entry>();
  for (const c of COMMANDS) {
    if (!c.doc || map.has(c.name)) continue;
    const pkg = PACKAGES.find((p) => p.name === c.pkg);
    if (pkg && !pkg.available) continue;
    map.set(c.name, {
      name: c.name,
      builtin: false,
      alsoBuiltin: BUILTIN_HELP.has(c.name),
      category: c.doc.category,
      summary: c.doc.summary,
      synopsis: c.doc.synopsis,
      description: c.doc.description,
      options: c.doc.options ?? [],
      examples: c.doc.examples ?? [],
      seeAlso: c.doc.seeAlso ?? [],
      tip: c.doc.tip,
      install: installHint.get(c.name),
    });
  }
  for (const [name, h] of BUILTIN_HELP) {
    if (map.has(name) || name === '.' || name === ':' || name === '[') continue;
    map.set(name, {
      name,
      builtin: true,
      alsoBuiltin: false,
      category: BUILTIN_CATEGORY[name] ?? 'shell',
      summary: h.summary.replace(/\.$/, ''),
      synopsis: [h.usage],
      description: h.body ?? h.summary,
      options: [],
      examples: BUILTIN_EXAMPLES[name] ?? [],
      seeAlso: [],
      tip: BUILTIN_TIPS[name],
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0];
}

export function Reference() {
  usePageTitle('Command reference');
  const entries = useMemo(buildEntries, []);
  const { hash } = useLocation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (id && entries.some((e) => e.name === id)) {
      setOpen(id);
      requestAnimationFrame(() => document.getElementById(`cmd-${id}`)?.scrollIntoView({ block: 'start' }));
    }
  }, [hash, entries]);

  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)) : entries;
  const grouped = ORDER.map((cat) => ({ cat, items: filtered.filter((e) => e.category === cat) })).filter((g) => g.items.length);

  return (
    <div className="page ref-page">
      <div className="page-head">
        <h1>Commands</h1>
        <p>
          Everything installed in the practice terminal. In the terminal itself, <code>man NAME</code> shows the full manual and <code>NAME --help</code> a short summary.
        </p>
      </div>
      <div className="search">
        <input type="search" placeholder="search commands (copy, ls, permissions…)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search commands" />
        <span className="faint">{filtered.length}</span>
      </div>
      <div className="ref-layout">
        <nav className="ref-toc" aria-label="Categories">
          {grouped.map((g) => (
            <a key={g.cat} href={`#cat-${g.cat}`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(`cat-${g.cat}`)?.scrollIntoView({ block: 'start' });
            }}>
              {CATEGORY_TITLES[g.cat]} <span className="faint">{g.items.length}</span>
            </a>
          ))}
        </nav>
        <div className="ref-list">
          {grouped.length === 0 && <p className="muted">No commands match “{query}”.</p>}
          {grouped.map((g) => (
            <section key={g.cat} id={`cat-${g.cat}`} className="ref-group">
              <h2>{CATEGORY_TITLES[g.cat]}</h2>
              {g.items.map((e) => {
                const isOpen = open === e.name || (q !== '' && filtered.length <= 3);
                return (
                  <article key={e.name} id={`cmd-${e.name}`} className={`ref-item ${isOpen ? 'open' : ''}`}>
                    <button type="button" className="ref-summary" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.name)}>
                      <span className="ref-name">{e.name}</span>
                      <span className="ref-desc">{e.summary}</span>
                      <span className="ref-tag">{e.builtin ? 'builtin' : e.install ? 'not installed' : ''}</span>
                    </button>
                    {isOpen && (
                      <div className="ref-body">
                        <pre className="ref-synopsis">{e.synopsis.join('\n')}</pre>
                        <Markdown source={firstParagraph(e.description)} />
                        {e.description.split(/\n\s*\n/).length > 1 && (
                          <details>
                            <summary>more</summary>
                            <Markdown source={e.description.split(/\n\s*\n/).slice(1).join('\n\n')} />
                          </details>
                        )}
                        {e.tip && <p className="ref-note">tip: {e.tip}</p>}
                        {e.install && (
                          <p className="ref-note">
                            Not installed by default: <code>sudo apt install {e.install}</code>
                          </p>
                        )}
                        {e.alsoBuiltin && <p className="ref-note">bash also has a built-in {e.name}; that is the one you normally use.</p>}
                        {e.options.length > 0 && (
                          <table className="ref-options">
                            <thead>
                              <tr>
                                <th>Option</th>
                                <th>Meaning</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.options.map((o) => (
                                <tr key={o.flags}>
                                  <td>
                                    <code>{o.flags}</code>
                                  </td>
                                  <td>{o.desc}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {e.examples.length > 0 && (
                          <div className="ref-examples">
                            <h3>Examples</h3>
                            {e.examples.map((x) => (
                              <div key={x.cmd} className="ref-example">
                                <code>{x.cmd}</code>
                                <span className="muted">{x.desc}</span>
                                <button type="button" className="btn" onClick={() => navigate(`/?cmd=${encodeURIComponent(x.cmd)}`)} title="Open the emulator with this command typed in">
                                  try
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {e.seeAlso.length > 0 && (
                          <p className="ref-see">
                            see also:{' '}
                            {e.seeAlso.map((s, i) => (
                              <span key={s}>
                                {i > 0 && ', '}
                                {entries.some((x) => x.name === s) ? <Link to={`/reference#${s}`}>{s}</Link> : s}
                              </span>
                            ))}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
