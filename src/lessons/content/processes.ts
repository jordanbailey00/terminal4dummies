// Module: Processes and jobs.

import { all, any, interrupted, lineMatches, ran, stoppedJob } from '../checks';
import type { CheckContext, Lesson } from '../types';

function jobCount(n: number) {
  return (c: CheckContext) => c.sh.jobs.all().filter((j) => j.state !== 'done').length === n;
}

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
      prompt: 'You start `sleep 500 &`, and the shell prints `[1] 4721`. What do the two numbers mean?',
      options: [
        '`1` is the process ID (PID), and `4721` is the job number',
        '`1` is the exit status, and `4721` is the process ID (PID)',
        '`1` is how many programs are running, and `4721` is the process ID (PID)',
        '`1` is the job number, and `4721` is the process ID (PID)',
      ],
      answer: 3,
      explain: 'The number in brackets is the job number this shell gave it, and the other is the PID the system gave the process. So `kill %1` and `kill 4721` would stop the same `sleep`.',
    },
    {
      kind: 'command',
      prompt: 'Type the command that lists **every** process on the computer, with its owner and its CPU and memory use.',
      accept: ['ps aux', /^ps (aux|axu|uax|uxa|xau|xua)$/],
      explain: 'On its own, `ps` only shows the processes in this terminal. `ps aux` (written without a dash) shows every process, with columns for its owner (`USER`) and its CPU and memory use (`%CPU`, `%MEM`).',
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
    {
      prompt: 'Which command prints the PIDs of the running processes called `sleep`?',
      options: ['`which sleep`', '`ps sleep`', '`pgrep -l sleep`'],
      answer: 2,
      explain: '`pgrep` searches the running processes by name and prints their PIDs (`-l` adds the names). `which sleep` only shows where the program file is stored, and `ps` does not accept a program name on its own.',
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
      prompt: 'What is the difference between <kbd>Ctrl</kbd>+<kbd>C</kbd> and <kbd>Ctrl</kbd>+<kbd>Z</kbd>?',
      options: [
        '<kbd>Ctrl</kbd>+<kbd>C</kbd> copies the selected text, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the last command',
        '<kbd>Ctrl</kbd>+<kbd>C</kbd> stops the foreground program for good, while <kbd>Ctrl</kbd>+<kbd>Z</kbd> only pauses it',
        'There is no difference: both stop the program for good',
        '<kbd>Ctrl</kbd>+<kbd>C</kbd> pauses the program, while <kbd>Ctrl</kbd>+<kbd>Z</kbd> stops it for good',
      ],
      answer: 1,
      explain: '<kbd>Ctrl</kbd>+<kbd>C</kbd> ends the foreground program for good. After <kbd>Ctrl</kbd>+<kbd>Z</kbd> it is only *stopped*: it still exists, waiting for you to resume it with `fg` or `bg`.',
    },
    {
      kind: 'command',
      prompt:
        'You were running `sleep 400` and pressed <kbd>Ctrl</kbd>+<kbd>Z</kbd> by accident. The shell printed:\n\n```\n[1]+  Stopped                 sleep 400\n```\n\nType the command that brings it back to the foreground.',
      accept: ['fg', 'fg %1', 'fg 1', 'fg %+', 'fg %%', 'fg %', 'fg %sleep', '%1', '%+', '%%', '%', '%sleep'],
      explain: '`fg` (short for *foreground*) resumes the stopped job and gives it the keyboard again. When you have several jobs, add the job number, as in `fg %2`.',
    },
    {
      prompt: 'You paused a long job with <kbd>Ctrl</kbd>+<kbd>Z</kbd>. Now you want it to continue running while you keep typing other commands. What do you type?',
      options: ['`fg`', '`jobs`', '`&`', '`bg`'],
      answer: 3,
      explain: '`bg` resumes a stopped job in the **background**, so the prompt stays free for you. `fg` would resume it too, but in the foreground, where it keeps the keyboard until it finishes.',
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
