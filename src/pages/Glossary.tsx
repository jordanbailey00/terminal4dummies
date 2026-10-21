import { useState } from 'react';
import { Markdown } from '../components/Markdown';
import { usePageTitle } from '../components/usePageTitle';
import { navigate } from '../router';
import { TERMS } from './glossaryTerms';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function Glossary() {
  usePageTitle('Glossary');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const terms = [...TERMS]
    .sort((a, b) => a.term.localeCompare(b.term))
    .filter((t) => !q || t.term.toLowerCase().includes(q) || t.aka?.some((a) => a.toLowerCase().includes(q)) || t.def.toLowerCase().includes(q));
  const letters = Array.from(new Set(terms.map((t) => t.term[0].toUpperCase())));
  return (
    <div className="page glossary">
      <div className="page-head">
        <h1>Glossary</h1>
        <p>Terms used on the command line and in the lessons.</p>
      </div>
      <div className="search">
        <input type="search" placeholder="search terms" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the glossary" />
      </div>
      <nav className="letter-index" aria-label="Jump to letter">
        {letters.map((l) => (
          <a key={l} href={`#letter-${l}`} onClick={(e) => {
            e.preventDefault();
            document.getElementById(`letter-${l}`)?.scrollIntoView({ block: 'start' });
          }}>
            {l}
          </a>
        ))}
      </nav>
      <dl className="terms">
        {terms.map((t, i) => {
          const letter = t.term[0].toUpperCase();
          const first = i === 0 || terms[i - 1].term[0].toUpperCase() !== letter;
          return (
            <div key={t.term} id={slug(t.term)} className="term">
              {first && (
                <div className="term-letter" id={`letter-${letter}`}>
                  {letter}
                </div>
              )}
              <dt>
                {t.term}
                {t.aka && <span className="faint"> ({t.aka.join(', ')})</span>}
              </dt>
              <dd>
                <Markdown source={t.def} onNavigate={(h) => navigate(h)} />
              </dd>
            </div>
          );
        })}
        {terms.length === 0 && <p className="muted">No terms match “{query}”.</p>}
      </dl>
    </div>
  );
}
