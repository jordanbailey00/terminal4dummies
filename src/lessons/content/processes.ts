// Module: Processes and jobs.

import { all, any, everRan, interrupted, lineMatches, ran, stoppedJob } from '../checks';
import type { CheckContext, Lesson } from '../types';

type Check = (c: CheckContext) => boolean;

function jobCount(n: number) {
  return (c: CheckContext) => c.sh.jobs.all().filter((j) => j.state !== 'done').length === n;
}

/** The `sleep` processes that are still alive (running or paused). */
function liveSleeps(c: CheckContext) {
  return c.sys.processes.list().filter((p) => p.argv[0]?.split('/').pop() === 'sleep');
}

function sleepPids(c: CheckContext): number[] {
  return liveSleeps(c).map((p) => p.pid);
}

/** A `sleep` job is running in the background. */
const sleepJobRunning: Check = (c) => c.sh.jobs.all().some((j) => j.state === 'running' && /\bsleep\b/.test(j.command));

/**
 * Since the question came up, `fg` brought a job back and it ended there.
 * (`fg` fails with status 1 when there is no such job, and returns 148 when
 * the job was paused again with Ctrl+Z.)
 */
const fgEnded: Check = (c) => c.commands.some((ev) => ev.execs.some((e) => e.argv[0] === 'fg' && e.status !== 1 && e.status !== 148));

/**
 * A `sleep` that was paused with Ctrl+Z since the question came up is running
 * again in the background. (When the job was paused after `fg` brought it
 * back, any running `sleep` job counts.)
 */
const pausedSleepResumed: Check = (c) => {
  const paused = new Set(c.commands.filter((ev) => ev.stopped).map((ev) => ev.line.trim()));
  const afterFg = c.commands.some((ev) => ev.execs.some((e) => e.argv[0] === 'fg' && e.status === 148));
  return c.sh.jobs.all().some((j) => j.state === 'running' && /\bsleep\b/.test(j.command) && (afterFg || paused.has(j.command.trim())));
};

/** A `sleep` was ended by a signal since the question came up. */
const sleepKilled: Check = (c) =>
  c.commands.some((ev) => ev.execs.some((e) => e.argv[0]?.split('/').pop() === 'sleep' && e.status > 128 && e.status !== 148));

/** The last command ran ps with options that select every process: BSD style (aux, ax...) or -e / -A. */
const listedAllProcesses: Check = (c) =>
  !!c.ev &&
  c.ev.execs.some(
    (e) =>
      e.argv[0]?.split('/').pop() === 'ps' &&
      e.status === 0 &&
      e.argv.slice(1).some((a) => (/^[a-zA-Z]+$/.test(a) && a.includes('a') && a.includes('x')) || /^-[a-zA-Z]*[eA]/.test(a)),
  );

export const processes: Lesson = {
  id: 'processes',
  title: "What's running? Processes",
  summary: 'See every running program with ps and top, and stop the ones you no longer want with kill.',
  moduleId: 'processes',
  minutes: 8,
  intro: `
Every running program is a **process**. The system gives each one a number, its **PID** (process ID), so you can refer to it. Even your shell is a process, and every command you run starts a new one.

\`\`\`
  PID TTY          TIME CMD
 1203 pts/0    00:00:00 bash      ← your shell
 1219 pts/0    00:00:00 ps        ← the command you just ran
\`\`\`

To stop a process you send it a **signal**:

| Signal | How | Meaning |
| --- | --- | --- |
| SIGINT | <kbd>Ctrl</kbd>+<kbd>C</kbd> | "please stop" (the foreground program) |
| SIGTERM | \`kill PID\` | "please exit" (the polite default) |
| SIGKILL | \`kill -9 PID\` | "stop immediately"; can't be ignored |

> [!HOW]
> A program can catch SIGINT and SIGTERM to clean up first (save files, close connections). SIGKILL is handled by the system itself, so the program gets no say, which is why it is the last resort.
`,
  steps: [
    {
      id: 'ps',
      title: 'Your processes',
      instruction: 'List the processes running in this terminal:\n\n`$ ps`',
      solution: ['ps'],
      explain: '`bash` is your shell and `ps` is the command you just ran: it shows up in its own list. The numbers on the left are PIDs.',
      check: ran('ps'),
    },
    {
      id: 'ps-aux',
      title: 'Every process',
      instruction: 'Show **every** process on the computer, with its owner and resource use:\n\n`$ ps aux`',
      hint: '`aux` is written without a dash. It is an old BSD-style option.',
      solution: ['ps aux'],
      explain: 'Most of these belong to `root` and were started when the computer booted: the system logger, the scheduler (cron), the SSH server and so on.',
      check: ran('ps', { args: [/^-?aux$/] }),
    },
    {
      id: 'background',
      title: 'Start something long',
      instruction: 'Start a long-running command **in the background** by ending the line with `&`, so the prompt comes straight back:\n\n`$ sleep 500 &`',
      solution: ['sleep 500 &'],
      explain: 'The shell printed a job number in brackets and the PID of the new process. `sleep` is now quietly waiting while you keep working.',
      // a background job reports its exec only when it finishes, so check the line and the job table
      check: all(lineMatches(/\bsleep\b.*&\s*$/), (c) => c.sh.jobs.size >= 1),
    },
    {
      id: 'find-it',
      title: 'Find its PID',
      instruction: 'Find the sleeping process with `pgrep`, which prints the PIDs of processes with a matching name:\n\n`$ pgrep -l sleep`',
      hint: 'You could also use `ps aux | grep sleep`.',
      solution: ['pgrep -l sleep'],
      check: any(ran('pgrep'), all(ran('ps'), ran('grep'))),
    },
    {
      id: 'kill',
      title: 'Stop it with kill',
      instruction: 'Now stop it. Type `kill` followed by the PID that pgrep printed (your number will be different), or use the job number:\n\n`$ kill %1`',
      hint: '`%1` means "job number 1". You can also write the PID, e.g. `kill 1234`.',
      solution: ['kill %1'],
      explain: '`kill` sent SIGTERM and the process ended. Despite the name, `kill` just sends signals; most of them ask a program to stop.',
      check: all(ran('kill'), jobCount(0)),
    },
    {
      id: 'top',
      title: 'Watch processes live',
      instruction: '`top` shows processes live, busiest first, updating every few seconds. Open it, look around, then press <kbd>q</kbd> to quit:\n\n`$ top`',
      solution: ['top', { keys: 'q', label: 'Press q to quit', delay: 800 }],
      explain: 'The top of the screen shows how long the computer has been running, the load, and memory use. Press <kbd>q</kbd> to quit at any time.',
      check: ran('top'),
    },
  ],
  quiz: [
    {
      kind: 'task',
      prompt: 'List **every** process running on this computer, not just the ones started from this terminal.',
      hint: 'On its own, `ps` only shows the processes of this terminal. It needs an option that selects them all.',
      solution: ['ps aux'],
      explain:
        '`ps aux` (written without a dash) lists every process, with columns for its owner (`USER`) and its CPU and memory use (`%CPU`, `%MEM`). `ps -e` and `ps -ef` are other common ways to select every process.',
      check: listedAllProcesses,
    },
    {
      kind: 'task',
      prompt: 'Start a `sleep` that lasts 900 seconds **in the background**, so that the prompt comes straight back while it keeps running.',
      hint: 'A single character at the end of the line sends a command to the background.',
      solution: ['sleep 900 &'],
      explain: 'The shell printed the job number in brackets and the PID of the new process. `sleep` is now quietly waiting while you keep working.',
      check: sleepJobRunning,
    },
    {
      kind: 'task',
      prompt: 'Find out the process ID (PID) of the `sleep` that is running.',
      hint: 'There is a command that searches the running processes by name. `ps` would show it too.',
      solution: ['pgrep sleep'],
      explain: '`pgrep` searched the running processes by name and printed the PID of each match (add `-l` to see the names too). `ps` and `jobs -l` show it as well.',
      check: any(
        (c) => !!c.ev && sleepPids(c).some((pid) => new RegExp(`(^|\\D)${pid}(\\D|$)`).test(c.ev?.output ?? '')),
        // ps read in a pager, or the live view of top: they draw on a screen of their own, so their output isn't captured
        all((c) => sleepPids(c).length > 0, any(all(ran('ps', { status: 0 }), any(ran('less'), ran('more'))), ran('top'), ran('htop'))),
      ),
    },
    {
      kind: 'task',
      prompt: 'Now stop that `sleep` process.',
      hint: 'The command that sends signals to processes has a rather dramatic name. Give it the PID, or the job number with a `%` in front.',
      solution: ['kill %1'],
      explain:
        '`kill` sent the polite SIGTERM signal and `sleep` ended. Using the PID (`kill` followed by the number that pgrep printed) or the name (`pkill sleep`) would have done the same.',
      check: all(any((c) => sleepPids(c).length === 0, sleepKilled), any(everRan('kill', { status: 0 }), everRan('pkill', { status: 0 }), fgEnded)),
    },
    {
      prompt: 'Which statement about `kill -9 4721` is true?',
      options: [
        'It politely asks process 4721 to exit, so the program can save its work first',
        "It forces process 4721 to stop at once; the program can't catch or ignore it",
        'It pauses process 4721, so that you can let it continue later',
        'It only works when you are root, because it is too dangerous for other users',
      ],
      answer: 1,
      explain: '`-9` sends SIGKILL, which the system carries out itself, so the program gets no say and no chance to clean up. That is why it is the last resort; a plain `kill 4721` sends the polite SIGTERM.',
    },
  ],
  recap: `
- A **process** is a running program; each has a **PID**.
- \`ps\` lists your processes, \`ps aux\` lists them all, \`pgrep NAME\` finds PIDs, \`top\` shows them live.
- \`kill PID\` (or \`kill %JOB\`) asks a process to stop; \`kill -9 PID\` forces it.
`,
  cheatsheet: [
    ['ps', 'processes in this terminal'],
    ['ps aux', 'every process'],
    ['pgrep -l NAME', 'find processes by name'],
    ['top', 'live view (q to quit)'],
    ['kill PID', 'ask a process to stop'],
    ['kill -9 PID', 'force it to stop'],
  ],
  realWorld: `
- **macOS:** \`ps aux\`, \`top\`, \`kill\` and \`pgrep\` all work. The graphical equivalent is *Activity Monitor*.
- **Windows:** the graphical equivalent is *Task Manager*; in PowerShell use \`Get-Process\` and \`Stop-Process\`.
`,
};

export const jobControl: Lesson = {
  id: 'job-control',
  title: 'Juggling jobs: &, Ctrl+Z, fg and bg',
  summary: 'Pause programs, send them to the background, bring them back, and know the difference between stopping and quitting.',
  moduleId: 'processes',
  minutes: 8,
  intro: `
Your shell can juggle several **jobs** at once. A job is a command you started from this shell. At any moment one job can be in the **foreground** (it owns the keyboard) and any number can be in the **background** (running, or paused).

| Action | Result |
| --- | --- |
| \`command &\` | start a job in the background |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | stop the foreground job for good |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | **pause** the foreground job (it is *stopped*, not finished) |
| \`jobs\` | list your jobs |
| \`fg\` | bring a job to the foreground |
| \`bg\` | let a paused job continue in the background |

> [!WARNING]
> A very common beginner mix-up: <kbd>Ctrl</kbd>+<kbd>Z</kbd> does **not** quit a program. It only pauses it. If you press it by accident, type \`fg\` to get your program back.
`,
  steps: [
    {
      id: 'ctrl-c',
      title: 'Quit with Ctrl+C',
      instruction: 'Warm-up: start a long wait and cancel it with <kbd>Ctrl</kbd>+<kbd>C</kbd>:\n\n`$ sleep 400`',
      solution: ['sleep 400', { keys: '\x03', label: 'Press Ctrl+C', delay: 500 }],
      check: all(ran('sleep'), interrupted()),
    },
    {
      id: 'ctrl-z',
      title: 'Pause with Ctrl+Z',
      instruction: 'Start it again, but this time press <kbd>Ctrl</kbd>+<kbd>Z</kbd>:\n\n`$ sleep 400`',
      solution: ['sleep 400', { keys: '\x1a', label: 'Press Ctrl+Z', delay: 500 }],
      explain: 'The shell says `Stopped`. The process still exists; it is just frozen, waiting for you to decide what to do with it.',
      check: stoppedJob(),
    },
    {
      id: 'jobs',
      title: 'List your jobs',
      instruction: 'See the paused job:\n\n`$ jobs`',
      solution: ['jobs'],
      explain: '`[1]` is the job number and `+` marks the "current" job, the one `fg` and `bg` act on by default.',
      check: ran('jobs'),
    },
    {
      id: 'bg',
      title: 'Let it run in the background',
      instruction: 'Resume the job, but keep it in the background so you can still type:\n\n`$ bg`',
      solution: ['bg'],
      explain: 'The job is running again (its line now ends in `&`). Background jobs are great for long tasks you do not need to watch.',
      check: all(ran('bg'), (c) => c.sh.jobs.all().some((j) => j.state === 'running')),
    },
    {
      id: 'fg',
      title: 'Bring it back',
      instruction: 'Bring the job back to the foreground, then stop it for good with <kbd>Ctrl</kbd>+<kbd>C</kbd>:\n\n`$ fg`',
      solution: ['fg', { keys: '\x03', label: 'Press Ctrl+C', delay: 600 }],
      explain: '`fg` printed the command it resumed and gave it the keyboard again, so <kbd>Ctrl</kbd>+<kbd>C</kbd> could reach it.',
      check: all(ran('fg'), jobCount(0)),
    },
    {
      id: 'two-jobs',
      title: 'Juggle two jobs',
      instruction: 'Start two background jobs, list them, and kill the first:\n\n`$ sleep 600 &`\n\n`$ sleep 700 &`\n\n`$ jobs`\n\n`$ kill %1`',
      solution: ['sleep 600 &', 'sleep 700 &', 'jobs', 'kill %1'],
      explain: '`%1` and `%2` refer to jobs by number. When a background job ends, the shell tells you before the next prompt.',
      check: all(ran('kill'), (c) => c.commands.filter((e) => /\bsleep\b.*&\s*$/.test(e.line)).length >= 2),
    },
  ],
  quiz: [
    {
      kind: 'task',
      prompt: 'Start a `sleep` that lasts 200 seconds, then end it for good from the keyboard, without waiting for it to finish.',
      hint: 'One key combination ends the foreground program for good; another only pauses it.',
      solution: ['sleep 200', { keys: '\x03', label: 'Press Ctrl+C', delay: 500 }],
      explain: '<kbd>Ctrl</kbd>+<kbd>C</kbd> sent the interrupt signal (SIGINT) to the program in the foreground, which ended it and gave you your prompt back.',
      check: all(ran('sleep'), interrupted()),
    },
    {
      kind: 'task',
      prompt:
        'Start a `sleep` that lasts 300 seconds, in the foreground as usual. Then pause it, and let it carry on running in the background, so that you get your prompt back while it runs.',
      hint: 'First press the keys that pause the foreground program, then use the command that resumes a paused job in the background.',
      solution: ['sleep 300', { keys: '\x1a', label: 'Press Ctrl+Z', delay: 500 }, 'bg'],
      explain:
        '<kbd>Ctrl</kbd>+<kbd>Z</kbd> paused the job (`Stopped`), and `bg` let it continue in the background: `jobs` now lists it as `Running`. `fg` would have resumed it too, but in the foreground, where it keeps the keyboard until it finishes.',
      check: pausedSleepResumed,
    },
    {
      kind: 'task',
      prompt: 'Start a second job in the background: a `sleep` of 700 seconds. Then end the first job (the 300-second `sleep`), and leave the new one running.',
      hint: '`jobs` lists your jobs with their numbers. You can refer to a job by its number with a `%` in front.',
      solution: ['sleep 700 &', 'kill %1'],
      explain: '`%1` means *job number 1*, the 300-second `sleep`, while the new one was job 2. You could also have used the PID of the first one, which `jobs -l` shows.',
      check: all(
        (c) => liveSleeps(c).some((p) => /^700s?$/.test(p.argv[1] ?? '') && p.state !== 'T'),
        (c) => !liveSleeps(c).some((p) => /^300s?$/.test(p.argv[1] ?? '')),
        any(everRan('kill', { status: 0 }), everRan('pkill', { status: 0 }), fgEnded),
      ),
    },
    {
      kind: 'task',
      prompt: 'Bring the `sleep` that is still running back to the foreground, then end it for good.',
      hint: 'The command you need is short for *foreground*. Once the job has the keyboard again, the usual keys can reach it.',
      solution: ['fg', { keys: '\x03', label: 'Press Ctrl+C', delay: 600 }],
      explain: '`fg` printed the command it resumed and gave it the keyboard again, so <kbd>Ctrl</kbd>+<kbd>C</kbd> could reach it. When you have several jobs, add the job number, as in `fg %2`.',
      check: all(fgEnded, (c) => !liveSleeps(c).some((p) => p.state !== 'T')),
    },
    {
      prompt: '`jobs` shows:\n\n```\n[1]-  Running                 sleep 600 &\n[2]+  Running                 sleep 700 &\n```\n\nWhich command ends `sleep 700`?',
      options: ['`kill 2`', '`kill %700`', '`kill %2`', '`kill sleep`'],
      answer: 2,
      explain: '`%2` means *job number 2*. Without the `%`, `kill 2` would mean the process whose **PID** is 2, which is a different process altogether.',
    },
  ],
  recap: `
- \`&\` starts a job in the background; \`jobs\` lists jobs.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> quits the foreground job; <kbd>Ctrl</kbd>+<kbd>Z</kbd> only pauses it.
- \`fg\` brings a job to the foreground, \`bg\` resumes it in the background, \`kill %N\` ends job N.
`,
  cheatsheet: [
    ['COMMAND &', 'run in the background'],
    ['jobs', 'list jobs'],
    ['Ctrl+Z', 'pause the foreground job'],
    ['fg / fg %2', 'bring a job to the foreground'],
    ['bg', 'resume a paused job in the background'],
    ['kill %1', 'end job 1'],
  ],
};

export const processesLessons: Lesson[] = [processes, jobControl];
