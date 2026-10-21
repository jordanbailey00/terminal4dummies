import { describe, expect, it } from 'vitest';
import { settle, startSession, waitFor } from './harness';

async function typeAndWait(term: { type(s: string): void; allText(): string }, input: string, until: string, timeout = 3000) {
  term.type(input);
  await waitFor(() => term.allText().includes(until), timeout, () => term.allText());
}

describe('interactive session', () => {
  it('shows the prompt and runs a command', async () => {
    const { term, session } = await startSession();
    expect(term.screen()[0]).toBe('learner@sandbox:~$');
    await typeAndWait(term, 'echo hi there\r', 'hi there\nlearner@sandbox:~$');
    session.dispose();
  });

  it('cd updates the prompt', async () => {
    const { term, session } = await startSession();
    await typeAndWait(term, 'cd Documents\r', 'learner@sandbox:~/Documents$');
    session.dispose();
  });

  it('ls in columns with colors on the terminal', async () => {
    const { term, session } = await startSession({ cols: 60 });
    await typeAndWait(term, 'ls\r', 'welcome.txt');
    const text = term.allText();
    expect(text).toContain('Desktop    Downloads  Pictures  Templates  welcome.txt');
    session.dispose();
  });

  it('Ctrl+C interrupts sleep', async () => {
    const { term, session } = await startSession();
    term.type('sleep 100\r');
    await settle(50);
    term.type('\x03');
    await waitFor(() => term.allText().includes('^C\nlearner@sandbox:~$'));
    term.type('echo $?\r');
    await waitFor(() => term.allText().includes('130'));
    session.dispose();
  });

  it('history with the up arrow', async () => {
    const { term, session } = await startSession();
    await typeAndWait(term, 'echo first\r', 'first\nlearner');
    term.type('\x1b[A');
    await settle(30);
    expect(term.screen().some((l) => l === 'learner@sandbox:~$ echo first')).toBe(true);
    term.type('\r');
    await waitFor(() => term.allText().split('first').length >= 5);
    session.dispose();
  });

  it('a here-document typed at the prompt keeps ! lines as they are', async () => {
    const { term, session } = await startSession();
    term.type("cat > hello.sh <<'EOF'\r");
    await settle(30);
    term.type('#!/bin/bash\r');
    await settle(30);
    term.type('echo "Hi!"\r');
    await settle(30);
    term.type('EOF\r');
    await settle(30);
    await typeAndWait(term, 'cat hello.sh\r', '#!/bin/bash\necho "Hi!"\nlearner@sandbox:~$');
    expect(term.allText()).not.toContain('event not found');
    session.dispose();
  });

  it('exit says logout in a login shell', async () => {
    const { term, session } = await startSession();
    await typeAndWait(term, 'bash -l\r', 'learner@sandbox:~$ bash -l\n');
    await settle(50);
    await typeAndWait(term, 'exit\r', 'logout\nlearner@sandbox:~$');
    await typeAndWait(term, 'logout\r', 'not login shell');
    session.dispose();
  });

  it('tab completion of a file name', async () => {
    const { term, session } = await startSession();
    term.type('cat wel\t');
    await settle(50);
    expect(term.screen().some((l) => l === 'learner@sandbox:~$ cat welcome.txt')).toBe(true);
    session.dispose();
  });

  it('continuation prompt for an open quote', async () => {
    const { term, session } = await startSession();
    term.type('echo "hello\r');
    await settle(30);
    expect(term.screen().some((l) => l === '>')).toBe(true);
    await typeAndWait(term, 'world"\r', 'hello\nworld\n');
    session.dispose();
  });

  it('cat reads typed lines until Ctrl+D', async () => {
    const { term, session } = await startSession();
    term.type('cat\r');
    await settle(30);
    term.type('abc\r');
    await waitFor(() => term.allText().includes('abc\nabc'));
    term.type('\x04');
    await waitFor(() => term.allText().endsWith('learner@sandbox:~$'), 3000, () => term.allText());
    session.dispose();
  });

  it('background jobs and job control', async () => {
    const { term, session } = await startSession();
    await typeAndWait(term, 'sleep 50 &\r', '[1] ');
    await typeAndWait(term, 'jobs\r', '[1]+  Running                 sleep 50 &');
    await typeAndWait(term, 'kill %1\r', 'learner@sandbox:~$ kill %1\n[1]+  Terminated              sleep 50\nlearner@sandbox:~$');
    session.dispose();
  });

  it('Ctrl+Z stops a job and fg resumes it', async () => {
    const { term, session } = await startSession();
    term.type('sleep 100\r');
    await settle(30);
    term.type('\x1a');
    await waitFor(() => term.allText().includes('[1]+  Stopped                 sleep 100'));
    await typeAndWait(term, 'fg\r', 'learner@sandbox:~$ fg\nsleep 100');
    await settle(50);
    term.type('\x03');
    await waitFor(() => /\^C\nlearner@sandbox:~\$\s*$/.test(term.allText()), 3000, () => term.allText());
    session.dispose();
  });
});
