<img src="public/favicon.svg" alt="terminal4dummies logo" width="96" />

# terminal4dummies

![license](https://img.shields.io/badge/license-all%20rights%20reserved-red)
![version](https://img.shields.io/badge/version-v0.1-blue)
[![Follow @jordansb_](https://img.shields.io/twitter/follow/jordansb_?style=social)](https://x.com/jordansb_)

A simulated Linux terminal (Ubuntu, bash) that runs entirely in the browser, with lessons that check your work as you type.

**Live:** https://terminal4dummies.vercel.app

- **Terminal emulator.** Built on [xterm.js](https://xtermjs.org/) with a bash-style shell: pipes, redirection, variables, arrays, globbing, history, tab completion, Ctrl+C / Ctrl+Z job control, scripts, `man` pages, `less`, `nano`, `sudo`, `apt`, `tar`, `curl`, `ssh` and more.
- **Nothing real to break.** Everything is simulated in the page; there is no server behind it. Reset puts the machine back.
- **Lessons.** Each lesson sets up a small practice machine and checks the result of your commands (was the folder created? did you run `ls -a`?) rather than matching exact text.

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + interactive terminal tests
npm run build      # production build into dist/
```

The look (modeled on [commitmono.com](https://commitmono.com)) is a layer in `src/skins/commit` over the original styles in `src/styles`. `npm run dev:classic` and `npm run build:classic` give the original look without it.

## Deploying

Hosted on Vercel as a static Vite app with a single-page-app rewrite (see `vercel.json`). Production: https://terminal4dummies.vercel.app

```bash
npx vercel --prod   # build and deploy from this folder
```

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
