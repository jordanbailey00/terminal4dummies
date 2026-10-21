// Builtins for variables, options and aliases.

import { isValidName } from '../parser/parser';
import { ReadonlyError, type ShellOptions, type Variable } from '../state';
import { defineBuiltin, type BuiltinContext } from './registry';

/** Quote a value the way `declare -p` / `export -p` do: "value" with \ " $ ` escaped. */
function declareQuote(v: string): string {
  return '"' + v.replace(/(["\\$`])/g, '\\$1') + '"';
}

/** Quote for `set` output: plain if safe, otherwise single quotes or $'...'. */
export function setQuote(v: string): string {
  if (v === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(v)) return v;
  if (/[\x00-\x1f\x7f]/.test(v)) {
    return "$'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\x1b/g, '\\E') + "'";
  }
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

function declareFlags(v: Variable): string {
  let f = '';
  if (v.integer) f += 'i';
  if (v.readonly) f += 'r';
  if (v.exported) f += 'x';
  return f === '' ? '--' : '-' + f;
}

function sortedVars(ctx: BuiltinContext): [string, Variable][] {
  return [...ctx.sh.state.vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function assignOrMark(ctx: BuiltinContext, arg: string, apply: (name: string, value: string | null) => void): Promise<boolean> {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq).replace(/\+$/, '');
  if (!isValidName(name)) {
    await ctx.error(`\`${arg}': not a valid identifier`);
    return false;
  }
  try {
    if (eq === -1) apply(name, null);
    else {
      let value = arg.slice(eq + 1);
      if (arg[eq - 1] === '+') value = (ctx.sh.state.get(name) ?? '') + value;
      apply(name, value);
    }
  } catch (e) {
    if (e instanceof ReadonlyError) {
      await ctx.error(e.message);
      return false;
    }
    throw e;
  }
  return true;
}

defineBuiltin(
  'export',
  {
    usage: 'export [-fn] [name[=value] ...] or export -p',
    summary: 'Set export attribute for shell variables.',
    body: 'Marks each NAME for automatic export to the environment of subsequently\nexecuted commands.  If VALUE is supplied, assign VALUE before exporting.\n\nOptions:\n  -n\tremove the export property from each NAME\n  -p\tdisplay a list of all exported variables and functions',
  },
  async (ctx) => {
    let args = ctx.args;
    let unexport = false;
    let print = false;
    while (args.length && /^-[nfp]+$/.test(args[0])) {
      if (args[0].includes('n')) unexport = true;
      if (args[0].includes('p')) print = true;
      args = args.slice(1);
    }
    if (args[0] === '--') args = args.slice(1);
    const st = ctx.sh.state;
    if (args.length === 0 || print) {
      let out = '';
      for (const [k, v] of sortedVars(ctx)) {
        if (!v.exported) continue;
        out += `declare ${declareFlags(v)} ${k}${v.value === '' && !st.vars.get(k) ? '' : '=' + declareQuote(v.value)}\n`;
      }
      await ctx.out(out);
      return 0;
    }
    let status = 0;
    for (const a of args) {
      const ok = await assignOrMark(ctx, a, (name, value) => {
        if (value !== null) ctx.sh.setVar(name, value);
        if (unexport) st.setExported(name, false);
        else st.setExported(name, true);
      });
      if (!ok) status = 1;
    }
    return status;
  },
);

defineBuiltin(
  'unset',
  {
    usage: 'unset [-f] [-v] [-n] [name ...]',
    summary: 'Unset values and attributes of shell variables and functions.',
    body: 'For each NAME, remove the corresponding variable or function.\n\nOptions:\n  -f\ttreat each NAME as a shell function\n  -v\ttreat each NAME as a shell variable',
  },
  async (ctx) => {
    let args = ctx.args;
    let funcs = false;
    while (args.length && /^-[fvn]+$/.test(args[0])) {
      if (args[0].includes('f')) funcs = true;
      args = args.slice(1);
    }
    const st = ctx.sh.state;
    let status = 0;
    for (const name of args) {
      if (funcs) {
        st.functions.delete(name);
        continue;
      }
      if (!isValidName(name)) {
        await ctx.error(`\`${name}': not a valid identifier`);
        status = 1;
        continue;
      }
      const v = st.getVar(name);
      if (v?.readonly) {
        await ctx.error(`${name}: cannot unset: readonly variable`);
        status = 1;
        continue;
      }
      if (v) st.vars.delete(name);
      else st.functions.delete(name);
    }
    return status;
  },
);

defineBuiltin(
  'readonly',
  { usage: 'readonly [-aAf] [name[=value] ...] or readonly -p', summary: 'Mark shell variables as unchangeable.', body: 'Mark each NAME as read-only; the values of these NAMEs may not be\nchanged by subsequent assignment.' },
  async (ctx) => {
    const args = ctx.args.filter((a) => !/^-[aAfp]+$/.test(a));
    const st = ctx.sh.state;
    if (args.length === 0) {
      let out = '';
      for (const [k, v] of sortedVars(ctx)) if (v.readonly) out += `declare ${declareFlags(v)} ${k}=${declareQuote(v.value)}\n`;
      await ctx.out(out);
      return 0;
    }
    let status = 0;
    for (const a of args) {
      const ok = await assignOrMark(ctx, a, (name, value) => {
        if (value !== null) ctx.sh.setVar(name, value);
        const v = st.getVar(name);
        if (v) v.readonly = true;
        else st.vars.set(name, { value: '', exported: false, readonly: true, integer: false });
      });
      if (!ok) status = 1;
    }
    return status;
  },
);

async function declareImpl(ctx: BuiltinContext, isLocal: boolean): Promise<number> {
  const st = ctx.sh.state;
  if (isLocal && st.funcNest === 0) {
    await ctx.error('can only be used in a function');
    return 1;
  }
  let args = ctx.args;
  const on = new Set<string>();
  const off = new Set<string>();
  while (args.length && /^[-+][a-zA-Z]+$/.test(args[0])) {
    const target = args[0][0] === '-' ? on : off;
    for (const ch of args[0].slice(1)) target.add(ch);
    args = args.slice(1);
  }
  if (args[0] === '--') args = args.slice(1);
  if (on.has('f') || on.has('F')) {
    const names = args.length ? args : [...st.functions.keys()].sort();
    let out = '';
    for (const n of names) {
      const fn = st.functions.get(n);
      if (!fn) return 1;
      out += on.has('F') ? `declare -f ${n}\n` : `${fn.source}\n`;
    }
    await ctx.out(out);
    return 0;
  }
  if (args.length === 0 || on.has('p')) {
    let out = '';
    const names = args.length ? args : null;
    for (const [k, v] of sortedVars(ctx)) {
      if (names && !names.includes(k)) continue;
      if (on.has('x') && !v.exported) continue;
      if (on.has('r') && !v.readonly) continue;
      out += on.has('p') || names ? `declare ${declareFlags(v)} ${k}=${declareQuote(v.value)}\n` : `${k}=${setQuote(v.value)}\n`;
    }
    if (names) {
      let status = 0;
      for (const n of names) {
        if (!st.vars.has(n)) {
          await ctx.error(`${n}: not found`);
          status = 1;
        }
      }
      await ctx.out(out);
      return status;
    }
    await ctx.out(out);
    return 0;
  }
  let status = 0;
  for (const a of args) {
    const ok = await assignOrMark(ctx, a, (name, value) => {
      if (isLocal || (st.funcNest > 0 && !on.has('g'))) st.makeLocal(name);
      if (on.has('i')) {
        const v = st.getVar(name);
        if (v) v.integer = true;
        else st.vars.set(name, { value: '', exported: false, readonly: false, integer: true });
      }
      if (value !== null) ctx.sh.setVar(name, value);
      else if (!st.vars.has(name)) st.vars.set(name, { value: '', exported: false, readonly: false, integer: on.has('i') });
      const v = st.getVar(name)!;
      if (on.has('x')) v.exported = true;
      if (off.has('x')) v.exported = false;
      if (on.has('r')) v.readonly = true;
      if (off.has('i')) v.integer = false;
    });
    if (!ok) status = 1;
  }
  return status;
}

const DECLARE_HELP = {
  usage: 'declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]',
  summary: 'Set variable values and attributes.',
  body: 'Declare variables and give them attributes.  If no NAMEs are given,\ndisplay the attributes and values of all variables.\n\nOptions:\n  -f\trestrict action or display to function names and definitions\n  -p\tdisplay the attributes and value of each NAME\n  -i\tto make NAMEs have the `integer\' attribute\n  -r\tto make NAMEs readonly\n  -x\tto make NAMEs export',
};
defineBuiltin('declare', DECLARE_HELP, (ctx) => declareImpl(ctx, false));
defineBuiltin('typeset', { ...DECLARE_HELP, usage: 'typeset [-aAfFgiIlnrtux] name[=value] ...', summary: 'Set variable values and attributes.' }, (ctx) => declareImpl(ctx, false));
defineBuiltin(
  'local',
  { usage: 'local [option] name[=value] ...', summary: 'Define local variables.', body: 'Create a local variable called NAME, and give it VALUE.  OPTION can\nbe any option accepted by `declare\'.\n\nLocal variables can only be used within a function; they are visible\nonly to the function where they are defined and its children.' },
  (ctx) => declareImpl(ctx, true),
);

// --- set / shopt -------------------------------------------------------------------

const SET_LONG: Record<string, keyof ShellOptions> = {
  errexit: 'errexit',
  nounset: 'nounset',
  xtrace: 'xtrace',
  pipefail: 'pipefail',
  noclobber: 'noclobber',
  noglob: 'noglob',
};
const SET_SHORT: Record<string, keyof ShellOptions> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  C: 'noclobber',
  f: 'noglob',
};
const SET_O_ALL = [
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof',
  'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd',
  'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace',
];

defineBuiltin(
  'set',
  {
    usage: 'set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]',
    summary: 'Set or unset values of shell options and positional parameters.',
    body:
      'Change the value of shell attributes and positional parameters, or\ndisplay the names and values of shell variables.\n\nOptions:\n' +
      '  -e  Exit immediately if a command exits with a non-zero status.\n  -u  Treat unset variables as an error when substituting.\n' +
      '  -x  Print commands and their arguments as they are executed.\n  -o pipefail  the return value of a pipeline is the status of\n                the last command to exit with a non-zero status\n\n' +
      'Using + rather than - causes these flags to be turned off.',
  },
  async (ctx) => {
    const st = ctx.sh.state;
    const args = ctx.args;
    if (args.length === 0) {
      let out = '';
      for (const [k, v] of sortedVars(ctx)) out += `${k}=${setQuote(v.value)}\n`;
      for (const name of [...st.functions.keys()].sort()) out += st.functions.get(name)!.source + '\n';
      await ctx.out(out);
      return 0;
    }
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        st.positional = args.slice(i + 1);
        return 0;
      }
      if (a === '-') {
        st.options.xtrace = false;
        st.positional = args.slice(i + 1);
        return 0;
      }
      if (!/^[-+]/.test(a)) break;
      const enable = a[0] === '-';
      if (a.slice(1) === 'o') {
        const name = args[++i];
        if (name === undefined) {
          let out = '';
          for (const o of SET_O_ALL) {
            const key = SET_LONG[o];
            const val = key ? st.options[key] : ['braceexpand', 'emacs', 'hashall', 'histexpand', 'history', 'interactive-comments', 'monitor'].includes(o) && (st.interactive || ['braceexpand', 'hashall', 'interactive-comments'].includes(o));
            out += enable ? `${o.padEnd(15)}\t${val ? 'on' : 'off'}\n` : `set ${val ? '-' : '+'}o ${o}\n`;
          }
          await ctx.out(out);
          continue;
        }
        const key = SET_LONG[name];
        if (!key) {
          if (SET_O_ALL.includes(name)) continue;
          await ctx.error(`${name}: invalid option name`);
          return 1;
        }
        st.options[key] = enable;
        continue;
      }
      for (const ch of a.slice(1)) {
        const key = SET_SHORT[ch];
        if (key) st.options[key] = enable;
        else if (!'abhkmnptvBEHPT'.includes(ch)) {
          await ctx.error(`${a[0]}${ch}: invalid option`);
          await ctx.err('set: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]\n');
          return 2;
        }
      }
    }
    if (i < args.length) st.positional = args.slice(i);
    return 0;
  },
);

const SHOPT_NAMES: Record<string, keyof ShellOptions | null> = {
  autocd: null,
  cdspell: null,
  checkwinsize: null,
  cmdhist: null,
  dotglob: 'dotglob',
  expand_aliases: 'expand_aliases',
  extglob: null,
  failglob: 'failglob',
  globstar: null,
  histappend: null,
  nocaseglob: 'nocaseglob',
  nocasematch: null,
  nullglob: 'nullglob',
  progcomp: null,
  sourcepath: null,
};
const SHOPT_DEFAULT_ON = new Set(['checkwinsize', 'cmdhist', 'histappend', 'progcomp', 'sourcepath', 'extglob']);

defineBuiltin(
  'shopt',
  { usage: 'shopt [-pqsu] [-o] [optname ...]', summary: 'Set and unset shell options.', body: 'Change the setting of each shell option OPTNAME.  Without any option\narguments, list each supplied OPTNAME, or all shell options if no\nOPTNAMEs are given, with an indication of whether or not each is set.\n\nOptions:\n  -s\tenable (set) each OPTNAME\n  -u\tdisable (unset) each OPTNAME\n  -q\tsuppresses normal output' },
  async (ctx) => {
    const st = ctx.sh.state;
    let set: boolean | null = null;
    let quiet = false;
    const names: string[] = [];
    for (const a of ctx.args) {
      if (a === '-s') set = true;
      else if (a === '-u') set = false;
      else if (a === '-q') quiet = true;
      else if (a === '-p') {
        /* print format is default */
      } else names.push(a);
    }
    const value = (n: string) => {
      const key = SHOPT_NAMES[n];
      return key ? st.options[key] : SHOPT_DEFAULT_ON.has(n);
    };
    for (const n of names) {
      if (!(n in SHOPT_NAMES)) {
        await ctx.error(`${n}: invalid shell option name`);
        return 1;
      }
    }
    if (set !== null) {
      for (const n of names) {
        const key = SHOPT_NAMES[n];
        if (key) st.options[key] = set;
        else if (set) SHOPT_DEFAULT_ON.add(n);
        else SHOPT_DEFAULT_ON.delete(n);
      }
      return 0;
    }
    const list = names.length ? names : Object.keys(SHOPT_NAMES).sort();
    if (quiet) return list.every(value) ? 0 : 1;
    let out = '';
    for (const n of list) out += `${n.padEnd(15)}\t${value(n) ? 'on' : 'off'}\n`;
    await ctx.out(out);
    return list.every(value) ? 0 : 1;
  },
);

// --- aliases -------------------------------------------------------------------------

function aliasQuote(v: string): string {
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

defineBuiltin(
  'alias',
  {
    usage: 'alias [-p] [name[=value] ... ]',
    summary: 'Define or display aliases.',
    body: "Without arguments, `alias' prints the list of aliases in the reusable\nform `alias NAME=VALUE' on standard output.\n\nOtherwise, an alias is defined for each NAME whose VALUE is given.\nA trailing space in VALUE causes the next word to be checked for\nalias substitution when the alias is expanded.",
  },
  async (ctx) => {
    const aliases = ctx.sh.state.aliases;
    const args = ctx.args.filter((a) => a !== '-p');
    if (args.length === 0) {
      const names = [...aliases.keys()].sort();
      await ctx.out(names.map((n) => `alias ${n}=${aliasQuote(aliases.get(n)!)}\n`).join(''));
      return 0;
    }
    let status = 0;
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const v = aliases.get(a);
        if (v === undefined) {
          await ctx.error(`${a}: not found`);
          status = 1;
        } else await ctx.out(`alias ${a}=${aliasQuote(v)}\n`);
        continue;
      }
      const name = a.slice(0, eq);
      if (name === '' || /[\s/$`=|&;<>()'"\\]/.test(name)) {
        await ctx.error(`\`${name}': invalid alias name`);
        status = 1;
        continue;
      }
      aliases.set(name, a.slice(eq + 1));
    }
    return status;
  },
);

defineBuiltin(
  'unalias',
  { usage: 'unalias [-a] name [name ...]', summary: 'Remove each NAME from the list of defined aliases.', body: 'Options:\n  -a\tremove all alias definitions' },
  async (ctx) => {
    const aliases = ctx.sh.state.aliases;
    if (ctx.args.length === 0) {
      await ctx.err('unalias: usage: unalias [-a] name [name ...]\n');
      return 2;
    }
    if (ctx.args[0] === '-a') {
      aliases.clear();
      return 0;
    }
    let status = 0;
    for (const n of ctx.args) {
      if (!aliases.delete(n)) {
        await ctx.error(`${n}: not found`);
        status = 1;
      }
    }
    return status;
  },
);
