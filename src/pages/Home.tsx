import { DemoTerminal } from '../components/DemoTerminal';
import { IconArrowRight, IconCheck, IconLock, IconSparkle, IconTerminal, IconBook } from '../components/Icons';
import { usePageTitle } from '../components/usePageTitle';
import { LESSONS, MODULES } from '../lessons';
import { Link } from '../router';
import { useProgress } from '../state/progress';

const FAQ: [string, string][] = [
  [
    'Is this a real Linux computer?',
    "Not quite, and that's the point. It's a faithful simulation of an Ubuntu Linux system with the bash shell, running entirely in your browser. Commands, error messages and keyboard shortcuts behave like the real thing, but nothing runs on a server and nothing can be damaged. When you're ready, everything you learn here works on a real computer.",
  ],
  ['Do I need to install anything?', 'No. Open a lesson and start typing. It works in any modern browser on desktop, laptop or tablet.'],
  [
    'I use a Mac / Windows. Is this still useful?',
    "Yes. The terminal on macOS uses the same commands (its shell is zsh, a close cousin of bash). On Windows you can get exactly this experience with WSL, which runs Ubuntu inside Windows. Lessons point out the differences where they matter.",
  ],
  ['Is my progress saved?', "Yes, in your browser on this device. There's no account and nothing is sent anywhere."],
  ['Can I break something?', 'Go ahead and try! Every lesson and the playground have a Reset button that puts everything back the way it was.'],
];

export function Home() {
  usePageTitle(null);
  const progress = useProgress();
  const doneCount = LESSONS.filter((l) => progress.lessons[l.id]?.done).length;
  const next = LESSONS.find((l) => !progress.lessons[l.id]?.done) ?? LESSONS[0];
  const started = Object.keys(progress.lessons).length > 0;
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <span className="badge badge-accent">
            <IconSparkle /> Free · No sign-up · Runs in your browser
          </span>
          <h1>
            Learn the command line by <span className="hl">actually using one</span>.
          </h1>
          <p className="lead">
            terminal4dummies gives you a real-feeling Linux terminal right in your browser, plus friendly lessons that check your work as you go. No installs, no risk, no jargon you haven't been told about.
          </p>
          <div className="row hero-ctas">
            <Link className="btn btn-primary btn-lg" to={`/learn/${next.id}`}>
              {started ? 'Continue learning' : 'Start the first lesson'} <IconArrowRight />
            </Link>
            <Link className="btn btn-lg" to="/playground">
              <IconTerminal /> Open the playground
            </Link>
          </div>
          {started && (
            <p className="faint hero-progress">
              {doneCount} of {LESSONS.length} lessons complete. Next up: <strong>{next.title}</strong>
            </p>
          )}
        </div>
        <div className="hero-demo">
          <DemoTerminal />
        </div>
      </section>

      <section className="home-section">
        <h2>Why learn the terminal?</h2>
        <div className="feature-grid">
          <div className="feature">
            <h3>Do more, faster</h3>
            <p>Rename a thousand files, search every document for a word, or install software, each with one line instead of a hundred clicks.</p>
          </div>
          <div className="feature">
            <h3>Unlock powerful tools</h3>
            <p>Programming, servers, data science and IT all run on the command line. Many of the best tools have no buttons at all.</p>
          </div>
          <div className="feature">
            <h3>Understand your computer</h3>
            <p>See how files, programs, users and permissions really fit together, without the graphical layer in the way.</p>
          </div>
          <div className="feature">
            <h3>Stop being scared of it</h3>
            <p>The black window with the blinking cursor is just a conversation. Once you know a dozen words, it becomes friendly.</p>
          </div>
        </div>
      </section>

      <section className="home-section how">
        <h2>How it works</h2>
        <ol className="how-steps">
          <li>
            <span className="how-num">1</span>
            <div>
              <h3>Read a short explanation</h3>
              <p>Each lesson starts with the idea in plain English: what a command does and why.</p>
            </div>
          </li>
          <li>
            <span className="how-num">2</span>
            <div>
              <h3>Type it in a real terminal</h3>
              <p>Right next to the lesson is a terminal that looks, feels and behaves like the one on a real Linux computer.</p>
            </div>
          </li>
          <li>
            <span className="how-num">3</span>
            <div>
              <h3>Get instant feedback</h3>
              <p>Steps tick themselves off when you get them right, and a coach explains error messages when you don't.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className="home-section">
        <div className="section-head">
          <h2>The curriculum</h2>
          <Link to="/learn" className="btn btn-ghost">
            See all lessons <IconArrowRight />
          </Link>
        </div>
        <div className="module-list">
          {MODULES.map((m, i) => {
            const done = m.lessons.filter((l) => progress.lessons[l.id]?.done).length;
            return (
              <Link key={m.id} to={`/learn/${m.lessons[0].id}`} className="module-row">
                <span className="module-num">{String(i + 1).padStart(2, '0')}</span>
                <span className="module-row-text">
                  <strong>{m.title}</strong>
                  <span className="muted">{m.description}</span>
                </span>
                <span className="module-row-count faint">
                  {done === m.lessons.length && done > 0 ? (
                    <span className="badge badge-accent">
                      <IconCheck /> Done
                    </span>
                  ) : (
                    `${m.lessons.length} lesson${m.lessons.length === 1 ? '' : 's'}`
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="home-section">
        <h2>A terminal, not a toy</h2>
        <div className="feature-grid">
          <div className="feature">
            <IconTerminal className="feature-icon" />
            <h3>Real behaviour</h3>
            <p>A bash-style shell with pipes, redirection, wildcards, variables, history, Tab completion, job control and scripts, and over a hundred commands with authentic output.</p>
          </div>
          <div className="feature">
            <IconLock className="feature-icon" />
            <h3>Safe to break</h3>
            <p>Delete everything, lock yourself out, run the scary commands. It's all simulated in your browser, and Reset fixes anything.</p>
          </div>
          <div className="feature">
            <IconBook className="feature-icon" />
            <h3>Help built in</h3>
            <p>
              Every command has a manual page (<code>man ls</code>), a <Link to="/reference">command reference</Link> and a <Link to="/glossary">glossary</Link> of terms.
            </p>
          </div>
        </div>
      </section>

      <section className="home-section faq">
        <h2>Questions</h2>
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <section className="home-final">
        <h2>Ready to type your first command?</h2>
        <p className="muted">It takes about five minutes, and you can't get it wrong.</p>
        <Link className="btn btn-primary btn-lg" to={`/learn/${next.id}`}>
          {started ? 'Continue learning' : 'Start the first lesson'} <IconArrowRight />
        </Link>
      </section>
    </div>
  );
}
