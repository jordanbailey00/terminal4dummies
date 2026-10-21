import { IconArrowRight, IconCheck, IconClock } from '../components/Icons';
import { usePageTitle } from '../components/usePageTitle';
import { LESSONS, MODULES } from '../lessons';
import { Link } from '../router';
import { useProgress } from '../state/progress';

export function Learn() {
  usePageTitle('Lessons');
  const progress = useProgress();
  const doneCount = LESSONS.filter((l) => progress.lessons[l.id]?.done).length;
  const nextLesson = LESSONS.find((l) => !progress.lessons[l.id]?.done) ?? LESSONS[0];
  const started = doneCount > 0 || Object.keys(progress.lessons).length > 0;
  return (
    <div className="page learn-page">
      <header className="learn-head">
        <div>
          <h1>Lessons</h1>
          <p className="lead">
            {LESSONS.length} short, hands-on lessons that take you from your very first command to writing your own scripts. Each one runs in a real-feeling terminal and checks your work as you go.
          </p>
        </div>
        <div className="learn-cta card">
          <div className="faint">{started ? 'Pick up where you left off' : 'Start at the beginning'}</div>
          <strong>{nextLesson.title}</strong>
          <div className="progress" aria-label={`${doneCount} of ${LESSONS.length} lessons complete`}>
            <div className="progress-bar" style={{ width: `${(doneCount / LESSONS.length) * 100}%` }} />
          </div>
          <div className="faint">
            {doneCount} of {LESSONS.length} lessons complete
          </div>
          <Link className="btn btn-primary" to={`/learn/${nextLesson.id}`}>
            {started ? 'Continue' : 'Start learning'} <IconArrowRight />
          </Link>
        </div>
      </header>
      {MODULES.map((m, mi) => (
        <section key={m.id} className="module">
          <div className="module-head">
            <span className="module-num">{String(mi + 1).padStart(2, '0')}</span>
            <div>
              <h2>{m.title}</h2>
              <p className="muted">{m.description}</p>
            </div>
          </div>
          <div className="lesson-grid">
            {m.lessons.map((l) => {
              const p = progress.lessons[l.id];
              const status = p?.done ? 'done' : p && p.steps.length ? 'started' : 'new';
              return (
                <Link key={l.id} to={`/learn/${l.id}`} className={`lesson-card ${status}`}>
                  <div className="lesson-card-top">
                    <span className="lesson-card-num">{String(LESSONS.indexOf(l) + 1).padStart(2, '0')}</span>
                    {status === 'done' ? (
                      <span className="badge badge-accent">
                        <IconCheck /> Done
                      </span>
                    ) : status === 'started' ? (
                      <span className="badge">
                        {p!.steps.length}/{l.steps.length} steps
                      </span>
                    ) : (
                      <span className="badge">
                        <IconClock /> {l.minutes} min
                      </span>
                    )}
                  </div>
                  <h3>{l.title}</h3>
                  <p>{l.summary}</p>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
