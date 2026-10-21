# terminal4dummies

Learn the command line by using one. terminal4dummies is a realistic Linux terminal that runs entirely in your browser, paired with friendly, step-by-step lessons that check your work as you go.

- **A real-feeling terminal.** Built on [xterm.js](https://xtermjs.org/) (the terminal used by VS Code) with a bash-style shell: pipes, redirection, variables, globbing, history, tab completion, Ctrl+C / Ctrl+Z job control, scripts, `man` pages, `less`, `nano`, `sudo`, `apt` and more.
- **Safe to break.** Everything is simulated in the page. There is no server and no real computer behind it, so `rm -rf` can't hurt anything; click Reset and start over.
- **Lessons that notice what you do.** Each lesson sets up a small practice computer and checks the result of your commands (did the folder get created? did you run `ls -a`?) instead of matching exact text.

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + interactive terminal tests
npm run build      # production build into dist/
```

## Deploying to Vercel

The project is a static Vite app with a single-page-app rewrite (see `vercel.json`).

1. In Vercel, choose **Add New → Project** and import `jordanbailey00/terminal4dummies` from GitHub.
2. Keep the detected settings (framework **Vite**, build `npm run build`, output `dist`).
3. Deploy. Every push to `main` then deploys automatically.

## How it works

| Path | What lives there |
| --- | --- |
| `src/shell/vfs` | In-memory Unix filesystem: inodes, permissions, symlinks, hard links, quotas |
| `src/shell/parser` | Hand-written bash parser (quoting, expansions, pipelines, `if`/`for`/`while`/`case`, functions, heredocs) |
| `src/shell/interpreter.ts`, `expand.ts` | Executes the syntax tree the way bash does (word splitting, globbing, redirections, job control) |
| `src/shell/tty.ts`, `readline.ts` | Terminal line discipline (Ctrl+C/Ctrl+D/Ctrl+Z) and a readline-style line editor |
| `src/shell/builtins` | Shell builtins (`cd`, `export`, `alias`, `jobs`, `read`, `test`...) |
| `src/shell/commands` | The programs (`ls`, `grep`, `sort`, `less`, `man`, `nano`, `sudo`, `apt`...) with GNU-accurate output and error messages |
| `src/terminal` | xterm.js integration and the terminal window component |
| `src/lessons` | Curriculum and the lesson engine |
| `src/test` | Vitest suites, including full interactive sessions driven through a headless xterm |

The simulated machine is Ubuntu-flavoured (user `learner`, host `sandbox`) because that is what most beginners meet first; lessons point out where macOS and Windows differ.
