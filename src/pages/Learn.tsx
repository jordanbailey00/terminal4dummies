import { usePageTitle } from '../components/usePageTitle';
import { LESSONS, MODULES } from '../lessons';
import { Link } from '../router';
import { useProgress } from '../state/progress';

const pad = (n: number) => String(n).padStart(2, '0');

/** The list of all lessons. */
export function Learn() {
  usePageTitle('Lessons');
  const progress = useProgress();
  const doneCount = LESSONS.filter((l) => progress.lessons[l.id]?.done).length;
  const next = LESSONS.find((l) => !progress.lessons[l.id]?.done);
  const started = Object.keys(progress.lessons).length > 0;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Lessons</h1>
        <p className="index-intro">
          Each lesson explains a few commands next to a simulated Linux terminal (Ubuntu, bash) where you try them. Steps are checked as you type. Progress is saved in this browser.
        </p>
      </div>
      <div className="index-status">
        <span>
          {doneCount}/{LESSONS.length} done
        </span>
        {next && (
          <Link to={`/learn/${next.id}`}>
            {started ? 'continue' : 'start'}: {pad(LESSONS.indexOf(next) + 1)} {next.title} →
          </Link>
        )}
      </div>
      {MODULES.map((m, mi) => (
        <section key={m.id} className="module">
          <div className="module-head">
            <h2>
              <span className="num">{pad(mi + 1)}</span>
              {m.title}
            </h2>
            <p>{m.description}</p>
          </div>
          <ol className="lesson-list">
            {m.lessons.map((l) => {
              const p = progress.lessons[l.id];
              const state = p?.done ? '✓' : p && p.steps.length ? `${p.steps.length}/${l.steps.length}` : '';
              return (
                <li key={l.id}>
                  <Link to={`/learn/${l.id}`} className="lesson-row">
                    <span className="num">{pad(LESSONS.indexOf(l) + 1)}</span>
                    <span className="title">{l.title}</span>
                    <span className="summary">{l.summary}</span>
                    <span className="mins">{l.minutes} min</span>
                    <span className={`state${p?.done ? ' done' : ''}`} aria-label={p?.done ? 'done' : state ? `${state} steps` : 'not started'}>
                      {state}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
