import { describe, expect, it } from 'vitest';
import { makeShell, run, settle, startSession, waitFor } from './harness';

describe('nano', () => {
  it('creates a file, saves with ^O and exits with ^X', async () => {
    const { term, session, sys } = await startSession();
    term.type('nano shopping.txt\r');
    await waitFor(() => term.screen()[0].includes('GNU nano 7.2'), 3000, () => term.allText());
    expect(term.screen()[0]).toContain('shopping.txt');
    expect(term.screen().join('\n')).toContain('[ New File ]');
    term.type('milk\reggs');
    await settle(30);
    expect(term.screen()[0]).toContain('Modified');
    term.type('\x0f');
    await waitFor(() => term.screen().some((l) => l.startsWith('File Name to Write: shopping.txt')));
    term.type('\r');
    await waitFor(() => term.screen().join('\n').includes('[ Wrote 2 lines ]'));
    term.type('\x18');
    await waitFor(() => /learner@sandbox:~\$\s*$/.test(term.allText()));
    expect(sys.fs.readFile('/home/learner/shopping.txt', { cwd: '/', creds: { uid: 1000, gid: 1000, groups: [1000] } })).toBe('milk\neggs\n');
    session.dispose();
  });

  it('asks to save modified buffer on ^X', async () => {
    const { term, session, sys } = await startSession();
    term.type('nano notes.md\r');
    await waitFor(() => term.screen()[0].includes('GNU nano'));
    term.type('# Title');
    await settle(20);
    term.type('\x18');
    await waitFor(() => term.screen().some((l) => l.includes('Save modified buffer?')));
    term.type('y');
    await waitFor(() => term.screen().some((l) => l.startsWith('File Name to Write: notes.md')));
    term.type('\r');
    await waitFor(() => /learner@sandbox:~\$\s*$/.test(term.allText()));
    expect(sys.fs.readFile('/home/learner/notes.md', { cwd: '/', creds: { uid: 1000, gid: 1000, groups: [1000] } })).toBe('# Title\n');
    session.dispose();
  });

  it('opens an existing file and reports lines read', async () => {
    const { term, session } = await startSession();
    term.type('nano Documents/todo.txt\r');
    await waitFor(() => term.screen().join('\n').includes('[ Read 5 lines ]'));
    expect(term.screen()[1]).toBe('buy milk');
    term.type('\x18');
    await waitFor(() => /learner@sandbox:~\$\s*$/.test(term.allText()));
    session.dispose();
  });

  it('cannot save a root-owned file without sudo', async () => {
    const { term, session } = await startSession();
    term.type('nano /etc/hostname\r');
    await waitFor(() => term.screen()[0].includes('GNU nano'));
    term.type('x\x0f\r');
    await waitFor(() => term.screen().join('\n').includes('Error writing /etc/hostname: Permission denied'));
    term.type('\x18n');
    await waitFor(() => /learner@sandbox:~\$\s*$/.test(term.allText()));
    session.dispose();
  });
});

describe('apt', () => {
  it('refuses to install without root', async () => {
    const r = await run(makeShell(), 'apt install cowsay');
    expect(r.stderr).toContain('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)');
    expect(r.status).toBe(100);
  });

  it('suggests installing unknown commands', async () => {
    const { term, session } = await startSession();
    term.type('cowsay hi\r');
    await waitFor(() => term.allText().includes("Command 'cowsay' not found, but can be installed with:\nsudo apt install cowsay"));
    session.dispose();
  });

  it('installs and removes packages with sudo', async () => {
    const { term, session } = await startSession();
    term.type('sudo apt install sl\r');
    await waitFor(() => term.allText().includes('[sudo] password for learner:'));
    term.type('secret\r');
    await waitFor(() => term.allText().includes('Setting up sl (5.02-1build1) ...'), 8000, () => term.allText());
    await waitFor(() => /learner@sandbox:~\$\s*$/.test(term.allText()), 5000);
    expect(term.allText()).not.toContain('secret');
    term.type('which sl\r');
    await waitFor(() => term.allText().includes('/usr/games/sl'));
    term.type('sudo apt remove -y sl\r');
    await waitFor(() => term.allText().includes('Removing sl (5.02-1build1) ...'), 8000, () => term.allText());
    session.dispose();
  }, 20000);
});
