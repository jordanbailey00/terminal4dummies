// Networking programs and the small simulated internet they talk to:
// curl, wget, ping, ssh, scp, ip and ss.
//
// Nothing here touches the real network. Host names resolve through the
// simulated computer's /etc/hosts and then through SIMULATED_HOSTS below
// (documentation addresses from RFC 5737). Web servers are JavaScript
// functions; `ssh webserver` logs in to a second simulated computer.

import { ExitException } from '../control';
import { IO } from '../io';
import { InputStream, OutputStream, SignalError } from '../streams';
import type { System } from '../system';
import { TtyInput } from '../tty';
import type { CommandContext } from '../types';
import { sha1, sha256 } from '../util/hash';
import { ROOT_CREDS, dataSize, type BlobData, type FileData, type Inode, type OpContext } from '../vfs/fs';
import { basename, dirname, normalize } from '../vfs/path';
import { asBinary, makeCompressedBlob, makeTarBlob, makeZipBlob, writeDataToStdout, type TarEntry, type ZipEntry } from './archive';
import { DAYS, MONTHS, defineCommand, errText, gnuHelp, pad2, type CommandDef } from './util';

// ===========================================================================
// Types

export interface HttpRequest {
  method: string;
  scheme: 'http' | 'https';
  /** Host name as it appears in the URL (lower case). */
  host: string;
  port: number;
  /** Decoded path, starting with "/". */
  path: string;
  /** Raw query string without "?". */
  rawQuery: string;
  query: Record<string, string>;
  /** Request headers with lower-case names. */
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: [string, string][];
  body: FileData;
}

export interface NetContext {
  /** The computer the request comes from. */
  system: System;
  /** The computer serving the request (for sites stored on a simulated disk). */
  server?: System;
}

export type HttpHandler = (req: HttpRequest, net: NetContext) => HttpResponse | Promise<HttpResponse>;

export interface SshHostConfig {
  /** Host name of the remote computer (its prompt shows this). */
  hostname: string;
  /** Adds the remote computer's distinctive files. */
  setup: (sys: System) => void;
}

export interface SimHost {
  /** Names that resolve to this host. The first one is its canonical name. */
  names: string[];
  ip: string;
  /** Reverse DNS name shown by ping. */
  ptr?: string;
  /** Round-trip time in milliseconds and the TTL ping sees. */
  rtt: number;
  ttl: number;
  /** Download speed in bytes per second. */
  bandwidth: number;
  /** Web server on port 80 and 443. */
  http?: HttpHandler;
  https?: HttpHandler;
  /** SSH server on port 22: a separate simulated computer. */
  ssh?: SshHostConfig;
  /** Connections to closed ports time out instead of being refused. */
  firewalled?: boolean;
  /** Does not answer ping. */
  noPing?: boolean;
  description: string;
}

// ===========================================================================
// Shared helpers

const NGINX = 'nginx/1.24.0 (Ubuntu)';
const CURL_UA = 'curl/8.5.0';
const WGET_UA = 'Wget/1.21.4';
const SITE_TIME = Date.UTC(2026, 8, 15, 10, 0, 0);
const USER_CREDS_WWW = { uid: 33, gid: 33, groups: [33] };

function httpDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} GMT`;
}

function localDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Deterministic pseudo-random number in [0, 1) from a string. */
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function b64FromHex(hex: string): string {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/=+$/, '');
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 418: "I'm a teapot",
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

function statusText(code: number): string {
  return STATUS_TEXT[code] ?? '';
}

function header(res: HttpResponse, name: string): string | undefined {
  const n = name.toLowerCase();
  return res.headers.find(([k]) => k.toLowerCase() === n)?.[1];
}

function bodyLength(body: FileData): number {
  return dataSize(body);
}

function nginxError(code: number, now: number, extra: [string, string][] = []): HttpResponse {
  const title = `${code} ${code === 405 ? 'Not Allowed' : statusText(code)}`;
  const body = `<html>\r\n<head><title>${title}</title></head>\r\n<body>\r\n<center><h1>${title}</h1></center>\r\n<hr><center>${NGINX}</center>\r\n</body>\r\n</html>\r\n`;
  return {
    status: code,
    headers: [['Server', NGINX], ['Date', httpDate(now)], ['Content-Type', 'text/html'], ['Content-Length', String(body.length)], ['Connection', 'keep-alive'], ...extra],
    body,
  };
}

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css', js: 'application/javascript', json: 'application/json',
  csv: 'text/csv', md: 'text/markdown', xml: 'text/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip',
  tar: 'application/x-tar', mp4: 'video/mp4', mp3: 'audio/mpeg', sh: 'text/x-sh', log: 'text/plain', conf: 'text/plain',
};

function mimeFor(path: string, fallback = 'application/octet-stream'): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && MIME[m[1].toLowerCase()]) || fallback;
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** nginx serving static files from a simulated disk. */
function serveStatic(fsSys: System, root: string, req: HttpRequest, now: number): HttpResponse {
  const fs = fsSys.fs;
  const ctx: OpContext = { cwd: '/', creds: USER_CREDS_WWW, umask: 0o022 };
  if (req.method !== 'GET' && req.method !== 'HEAD') return nginxError(405, now);
  const rel = normalize('/' + req.path).replace(/^\/+/, '');
  let path = rel ? `${root}/${rel}` : root;
  let node: Inode | null;
  try {
    node = fs.stat(path, ctx);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return nginxError(code === 'EACCES' ? 403 : 404, now);
  }
  if (node.type === 'dir') {
    if (!req.path.endsWith('/')) {
      const loc = `${req.scheme}://${req.host}${(req.scheme === 'http' && req.port !== 80) || (req.scheme === 'https' && req.port !== 443) ? ':' + req.port : ''}${req.path}/`;
      return nginxError(301, now, [['Location', loc]]);
    }
    path = `${path.replace(/\/+$/, '')}/index.html`;
    try {
      node = fs.stat(path, ctx);
    } catch {
      return nginxError(403, now);
    }
  }
  if (node.type !== 'file') return nginxError(403, now);
  let data: FileData;
  try {
    data = fs.readData(path, ctx);
  } catch {
    return nginxError(403, now);
  }
  const size = dataSize(data);
  const type = mimeFor(path);
  return {
    status: 200,
    headers: [
      ['Server', NGINX],
      ['Date', httpDate(now)],
      ['Content-Type', type],
      ['Content-Length', String(size)],
      ['Last-Modified', httpDate(node.mtime)],
      ['Connection', 'keep-alive'],
      ['ETag', `"${Math.floor(node.mtime / 1000).toString(16)}-${size.toString(16)}"`],
      ['Accept-Ranges', 'bytes'],
    ],
    body: req.method === 'HEAD' ? '' : typeof data === 'string' ? data : { ...data },
  };
}

// ===========================================================================
// The web sites

const EXAMPLE_HTML = `<!doctype html>
<html>
<head>
    <title>Example Domain</title>

    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
    body {
        background-color: #f2f2f4;
        margin: 0;
        font-family: system-ui, sans-serif;
    }
    div {
        max-width: 36em;
        margin: 5em auto;
        padding: 2em;
        background-color: #ffffff;
        border-radius: 0.5em;
    }
    a:link, a:visited {
        color: #3a4a90;
    }
    </style>
</head>

<body>
<div>
    <h1>Example Domain</h1>
    <p>This domain is set aside for use in examples, tutorials and
    documentation. Anyone may mention it in their writing without asking
    for permission first.</p>
    <p><a href="https://www.iana.org/help/example-domains">More information...</a></p>
</div>
</body>
</html>
`;

function exampleSite(req: HttpRequest, net: NetContext): HttpResponse {
  const now = net.system.now();
  const ok = req.path === '/' || req.path === '/index.html';
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return { status: 405, headers: [['Content-Type', 'text/html'], ['Date', httpDate(now)], ['Server', 'ECS (sim/2F1A)'], ['Content-Length', '0']], body: '' };
  return {
    status: ok ? 200 : 404,
    headers: [
      ['Content-Type', 'text/html; charset=UTF-8'],
      ['Content-Length', String(EXAMPLE_HTML.length)],
      ['Date', httpDate(now)],
      ['Last-Modified', httpDate(SITE_TIME)],
      ['Cache-Control', 'max-age=604800'],
      ['Server', 'ECS (sim/2F1A)'],
    ],
    body: req.method === 'HEAD' ? '' : EXAMPLE_HTML,
  };
}

interface ApiUser {
  id: number;
  name: string;
  username: string;
  email: string;
  city: string;
}

export const API_USERS: ApiUser[] = [
  { id: 1, name: 'Alice Moreno', username: 'alice', email: 'alice@example.com', city: 'Lisbon' },
  { id: 2, name: 'Bilal Khan', username: 'bilal', email: 'bilal@example.com', city: 'Toronto' },
  { id: 3, name: 'Chen Wei', username: 'chenwei', email: 'chen.wei@example.com', city: 'Singapore' },
  { id: 4, name: 'Dana Okafor', username: 'dana', email: 'dana@example.com', city: 'Lagos' },
  { id: 5, name: 'Erik Lund', username: 'erik', email: 'erik@example.com', city: 'Oslo' },
];

const WEATHER: Record<string, [string, number, string, number, number]> = {
  london: ['GB', 14, 'Light rain', 82, 18],
  paris: ['FR', 16, 'Partly cloudy', 68, 12],
  tokyo: ['JP', 21, 'Clear', 55, 9],
  'new york': ['US', 17, 'Sunny', 48, 15],
  sydney: ['AU', 23, 'Windy', 60, 31],
  lisbon: ['PT', 22, 'Sunny', 58, 14],
  toronto: ['CA', 9, 'Overcast', 77, 20],
  singapore: ['SG', 31, 'Thunderstorms', 88, 7],
  lagos: ['NG', 30, 'Humid', 84, 10],
  oslo: ['NO', 6, 'Drizzle', 90, 16],
  berlin: ['DE', 12, 'Cloudy', 74, 19],
  cairo: ['EG', 29, 'Clear', 30, 11],
  mumbai: ['IN', 32, 'Hazy', 70, 13],
  'mexico city': ['MX', 19, 'Scattered showers', 66, 8],
  'san francisco': ['US', 18, 'Fog', 85, 22],
};

function json(status: number, value: unknown, now: number, extra: [string, string][] = []): HttpResponse {
  const body = JSON.stringify(value, null, 2) + '\n';
  return {
    status,
    headers: [
      ['Date', httpDate(now)],
      ['Content-Type', 'application/json; charset=utf-8'],
      ['Content-Length', String(new TextEncoder().encode(body).length)],
      ['Connection', 'keep-alive'],
      ['Server', 'nginx'],
      ['Access-Control-Allow-Origin', '*'],
      ...extra,
    ],
    body,
  };
}

function parseBody(req: HttpRequest): Record<string, unknown> | null {
  const type = req.headers['content-type'] ?? '';
  const text = req.body.trim();
  if (text === '') return null;
  if (type.includes('json') || text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const out: Record<string, unknown> = {};
  for (const part of text.split('&')) {
    const [k, v = ''] = part.split('=');
    if (k) out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

function apiSite(req: HttpRequest, net: NetContext): HttpResponse {
  const now = net.system.now();
  const path = req.path.replace(/\/+$/, '') || '/';
  const m = req.method;
  const head = m === 'HEAD';
  const done = (r: HttpResponse) => (head ? { ...r, body: '' } : r);
  if (path === '/') {
    return done(json(200, {
      name: 'Example API',
      version: '1.0',
      endpoints: ['GET /users', 'GET /users/{id}', 'POST /users', 'GET /weather?city={name}', 'GET /time', 'GET /headers', 'ANY /echo', 'GET /status/{code}'],
    }, now));
  }
  if (path === '/users') {
    if (m === 'GET' || head) return done(json(200, API_USERS, now));
    if (m === 'POST') {
      const body = parseBody(req);
      if (!body || typeof body.name !== 'string' || body.name.trim() === '') return json(400, { error: 'Request body must include a "name"' }, now);
      return json(201, { id: API_USERS.length + 1, ...body }, now, [['Location', `/users/${API_USERS.length + 1}`]]);
    }
    return json(405, { error: `Method ${m} not allowed on /users` }, now, [['Allow', 'GET, POST, HEAD']]);
  }
  const um = /^\/users\/([^/]+)$/.exec(path);
  if (um) {
    const id = Number(um[1]);
    const user = API_USERS.find((u) => u.id === id);
    if (!user) return done(json(404, { error: `User ${um[1]} not found` }, now));
    if (m === 'GET' || head) return done(json(200, user, now));
    if (m === 'PUT' || m === 'PATCH') return json(200, { ...user, ...(parseBody(req) ?? {}), id }, now);
    if (m === 'DELETE') return json(200, { deleted: true, id }, now);
    return json(405, { error: `Method ${m} not allowed` }, now);
  }
  if (path === '/weather') {
    const city = (req.query.city ?? '').trim();
    if (!city) return done(json(400, { error: 'Missing required query parameter: city', example: '/weather?city=London' }, now));
    const key = city.toLowerCase();
    const known = WEATHER[key];
    const h = hashUnit(key);
    const [country, temp, conditions, humidity, wind] = known ?? ['??', Math.round(5 + h * 25), ['Clear', 'Cloudy', 'Light rain', 'Sunny', 'Windy'][Math.floor(h * 5)], Math.round(40 + h * 50), Math.round(5 + h * 25)];
    const name = city.replace(/\b\w/g, (c) => c.toUpperCase());
    return done(json(200, { city: name, country, temperature_c: temp, temperature_f: Math.round((temp * 9) / 5 + 32), conditions, humidity, wind_kph: wind }, now));
  }
  if (path === '/time') {
    const d = new Date(now);
    return done(json(200, { utc_datetime: d.toISOString(), unixtime: Math.floor(now / 1000), timezone: 'UTC', day_of_week: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()] }, now));
  }
  if (path === '/headers') {
    const hs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) hs[k.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = v;
    return done(json(200, { headers: hs }, now));
  }
  if (path === '/echo') {
    const parsed = parseBody(req);
    return done(json(200, { method: m, path: req.path, query: req.query, headers: req.headers, body: req.body, ...(parsed && (req.headers['content-type'] ?? '').includes('json') ? { json: parsed } : {}) }, now));
  }
  const sm = /^\/status\/(\d{3})$/.exec(path);
  if (sm) {
    const code = Number(sm[1]);
    return done(json(code, { status: code, message: statusText(code) || 'Unknown' }, now));
  }
  return done(json(404, { error: `No such endpoint: ${req.path}` }, now));
}

const FILES_TIME = Date.UTC(2026, 9, 1, 9, 0, 0);

const HELLO_TXT = `Hello from files.example.com!

If you can read this, your download worked. Try these next:
  curl -O https://files.example.com/data.csv
  wget https://files.example.com/project.tar.gz
`;

const DATA_CSV = `date,city,temperature_c,rain_mm
2026-10-12,London,13,2.4
2026-10-12,Paris,15,0.0
2026-10-12,Tokyo,21,0.0
2026-10-13,London,12,5.1
2026-10-13,Paris,14,1.2
2026-10-13,Tokyo,20,8.3
2026-10-14,London,14,0.0
2026-10-14,Paris,16,0.0
2026-10-14,Tokyo,19,12.0
`;

function tarEntry(name: string, data: string | null, mode = 0o644): TarEntry {
  const dir = data === null;
  return {
    name: dir ? name.replace(/\/?$/, '/') : name,
    type: dir ? 'dir' : 'file',
    mode: dir ? 0o755 : mode,
    uid: 1000,
    gid: 1000,
    uname: 'dev',
    gname: 'dev',
    mtime: FILES_TIME - 86400000,
    size: data === null ? 0 : new TextEncoder().encode(data).length,
    data: data ?? undefined,
  };
}

let projectTarGz: BlobData | null = null;
function projectArchive(): BlobData {
  if (!projectTarGz) {
    const entries = [
      tarEntry('project/', null),
      tarEntry('project/README.md', '# Project\n\nA tiny example project that came from a .tar.gz download.\n\nRun ./install.sh to "install" it, or read docs/usage.txt.\n'),
      tarEntry('project/install.sh', '#!/bin/bash\n# Pretend installer\necho "Installing project..."\nsleep 1\necho "Done! Nothing was really installed."\n', 0o755),
      tarEntry('project/docs/', null),
      tarEntry('project/docs/usage.txt', 'Usage: ./install.sh\n\nThis project does nothing useful. It exists so you can practise\nunpacking archives with: tar -xzf project.tar.gz\n'),
      tarEntry('project/src/', null),
      tarEntry('project/src/hello.sh', '#!/bin/bash\necho "Hello, $USER!"\n', 0o755),
      tarEntry('project/LICENSE', 'Released into the public domain. Do whatever you like with it.\n'),
    ];
    projectTarGz = makeCompressedBlob('gzip', makeTarBlob(entries), { level: 6 });
  }
  return projectTarGz;
}

let notesZip: BlobData | null = null;
function notesArchive(): BlobData {
  if (!notesZip) {
    const mk = (name: string, data: string | null): ZipEntry => ({
      name,
      kind: data === null ? 'dir' : 'file',
      mode: data === null ? 0o755 : 0o644,
      mtime: FILES_TIME,
      size: data === null ? 0 : data.length,
      csize: data === null ? 0 : data.length,
      method: 'store',
      crc: 0,
      data: data ?? undefined,
    });
    notesZip = makeZipBlob([
      mk('notes/', null),
      mk('notes/todo.txt', 'water the plants\nreply to Sam\nlearn tar and zip\n'),
      mk('notes/ideas.md', '# Ideas\n\n- a website for the bakery\n- automate backups with a script\n'),
    ]);
  }
  return notesZip;
}

const FILES: Record<string, () => FileData> = {
  '/hello.txt': () => HELLO_TXT,
  '/data.csv': () => DATA_CSV,
  '/project.tar.gz': () => ({ ...projectArchive() }),
  '/notes.zip': () => ({ ...notesArchive() }),
  '/logo.png': () => ({ kind: 'blob', description: 'PNG image data, 256 x 256, 8-bit/color RGBA, non-interlaced', payload: null, size: 4823 }),
  '/sample-video.mp4': () => ({ kind: 'blob', description: 'ISO Media, MP4 Base Media v1 [ISO 14496-12:2003]', payload: null, size: 12582912 }),
};

function filesIndex(): string {
  const rows = Object.keys(FILES)
    .map((p) => `<a href="${p.slice(1)}">${p.slice(1)}</a>`.padEnd(70) + `${dataSize(FILES[p]())}`.padStart(10))
    .join('\n');
  return `<html>\n<head><title>Index of /</title></head>\n<body>\n<h1>Index of /</h1><hr><pre><a href="../">../</a>\n${rows}\n</pre><hr></body>\n</html>\n`;
}

function filesSite(req: HttpRequest, net: NetContext): HttpResponse {
  const now = net.system.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') return nginxError(405, now);
  if (req.path === '/latest' || req.path === '/latest.tar.gz') {
    return { ...nginxError(302, now, [['Location', `${req.scheme}://${req.host}/project.tar.gz`]]), status: 302 };
  }
  const head = req.method === 'HEAD';
  if (req.path === '/' || req.path === '/index.html') {
    const body = filesIndex();
    return { status: 200, headers: [['Server', 'nginx'], ['Date', httpDate(now)], ['Content-Type', 'text/html'], ['Content-Length', String(body.length)], ['Connection', 'keep-alive']], body: head ? '' : body };
  }
  const make = FILES[req.path];
  if (!make) return nginxError(404, now);
  const body = make();
  const size = dataSize(body);
  return {
    status: 200,
    headers: [
      ['Server', 'nginx'],
      ['Date', httpDate(now)],
      ['Content-Type', mimeFor(req.path)],
      ['Content-Length', String(size)],
      ['Last-Modified', httpDate(FILES_TIME)],
      ['Connection', 'keep-alive'],
      ['ETag', `"${Math.floor(FILES_TIME / 1000).toString(16)}-${size.toString(16)}"`],
      ['Accept-Ranges', 'bytes'],
    ],
    body: head ? '' : body,
  };
}

async function webserverSite(req: HttpRequest, net: NetContext): Promise<HttpResponse> {
  const server = net.server ?? (await remoteSystem(net.system, 'webserver'));
  if (!server) return nginxError(502, net.system.now());
  return serveStatic(server, '/var/www/html', req, net.system.now());
}

// ===========================================================================
// The remote server "webserver"

const BAKERY_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sunrise Bakery</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <h1>Sunrise Bakery</h1>
  <p>Fresh bread every morning since 1998.</p>
  <ul>
    <li><a href="menu.html">Our menu</a></li>
    <li><a href="about.html">About us</a></li>
  </ul>
  <p>Open Tuesday to Sunday, 7am to 2pm.</p>
</body>
</html>
`;

const BAKERY_MENU = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Menu - Sunrise Bakery</title></head>
<body>
  <h1>Menu</h1>
  <ul>
    <li>Sourdough loaf - 5.50</li>
    <li>Croissant - 2.20</li>
    <li>Cinnamon roll - 3.00</li>
    <li>Rye bread - 4.80</li>
  </ul>
  <p><a href="index.html">Back</a></p>
</body>
</html>
`;

const BAKERY_ABOUT = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>About - Sunrise Bakery</title></head>
<body>
  <h1>About us</h1>
  <p>We are a small family bakery. This page is served by nginx on the
  computer called "webserver".</p>
  <p><a href="index.html">Back</a></p>
</body>
</html>
`;

const BAKERY_CSS = `body { font-family: Georgia, serif; max-width: 40em; margin: 2em auto; color: #3b2a1a; }
h1 { color: #c0612b; }
a { color: #8a4b20; }
`;

const NGINX_DEFAULT = `# Default server configuration
#
server {
	listen 80 default_server;
	listen [::]:80 default_server;

	root /var/www/html;

	# Add index.php to the list if you are using PHP
	index index.html index.htm index.nginx-debian.html;

	server_name webserver.example.com webserver;

	location / {
		# First attempt to serve request as file, then
		# as directory, then fall back to displaying a 404.
		try_files $uri $uri/ =404;
	}
}
`;

const REMOTE_README = `Welcome to webserver!

You are logged in to a DIFFERENT computer from your practice machine.
Everything you do here happens on webserver, not on sandbox. Look at the
prompt: it says learner@webserver.

Things to try:
  hostname                       which computer am I on?
  ls /var/www/html               the bakery website served by nginx
  tail /var/log/nginx/access.log who has been visiting the site
  df -h                          how full is this server's disk?
  exit                           log out and go back to sandbox

From sandbox you can fetch the website with: curl http://webserver/
`;

function accessLog(now: number): string {
  const ips = ['198.51.100.23', '203.0.113.45', '198.51.100.7', '192.0.2.88', '203.0.113.9', '198.51.100.150', '10.0.2.15'];
  const pages: [string, number, number][] = [
    ['/', 200, 412], ['/menu.html', 200, 389], ['/about.html', 200, 331], ['/css/style.css', 200, 141], ['/favicon.ico', 404, 162],
    ['/wp-login.php', 404, 162], ['/images/logo.png', 200, 4823], ['/.env', 404, 162], ['/menu.html', 304, 0], ['/contact.html', 404, 162],
  ];
  const agents = ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'curl/8.5.0', 'Mozilla/5.0 (compatible; ExampleBot/2.1)'];
  let out = '';
  const start = now - 6 * 3600 * 1000;
  for (let i = 0; i < 48; i++) {
    const t = new Date(start + i * 7 * 60 * 1000 + Math.floor(hashUnit('t' + i) * 300000));
    const ip = ips[Math.floor(hashUnit('ip' + i) * ips.length)];
    const [page, status, bytes] = pages[Math.floor(hashUnit('p' + i) * pages.length)];
    const agent = page.endsWith('.php') || page === '/.env' ? agents[3] : agents[Math.floor(hashUnit('a' + i) * 3)];
    const stamp = `${pad2(t.getUTCDate())}/${MONTHS[t.getUTCMonth()]}/${t.getUTCFullYear()}:${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())} +0000`;
    out += `${ip} - - [${stamp}] "GET ${page} HTTP/1.1" ${status} ${bytes} "-" "${agent}"\n`;
  }
  return out;
}

function setupWebserver(sys: System): void {
  const fs = sys.fs;
  const root: OpContext = { cwd: '/', creds: ROOT_CREDS, umask: 0o022 };
  const now = sys.now();
  const learner = sys.userByName('learner');
  const lu = learner?.uid ?? 1000;
  const lg = learner?.gid ?? 1000;
  const mkdirp = (p: string) => {
    let cur = '';
    for (const part of p.split('/').filter(Boolean)) {
      cur += '/' + part;
      if (!fs.tryStat(cur, root)) fs.mkdir(cur, root, 0o755);
    }
  };
  const put = (path: string, data: FileData, o: { uid?: number; gid?: number; mode?: number; time?: number } = {}) => {
    mkdirp(dirname(path));
    const node = fs.writeFile(path, data, root, { mode: o.mode ?? 0o644 });
    node.mode = o.mode ?? 0o644;
    node.uid = o.uid ?? 0;
    node.gid = o.gid ?? 0;
    node.mtime = node.atime = node.ctime = o.time ?? now - 3 * 86400000;
  };
  const www = sys.groupByName('www-data')?.gid ?? 33;
  const adm = sys.groupByName('adm')?.gid ?? 4;
  put('/var/www/html/index.html', BAKERY_INDEX, { uid: lu, gid: www, mode: 0o664 });
  put('/var/www/html/menu.html', BAKERY_MENU, { uid: lu, gid: www, mode: 0o664 });
  put('/var/www/html/about.html', BAKERY_ABOUT, { uid: lu, gid: www, mode: 0o664 });
  put('/var/www/html/css/style.css', BAKERY_CSS, { uid: lu, gid: www, mode: 0o664 });
  put('/var/www/html/images/logo.png', { kind: 'blob', description: 'PNG image data, 256 x 256, 8-bit/color RGBA, non-interlaced', payload: null, size: 4823 }, { uid: lu, gid: www, mode: 0o664 });
  for (const d of ['/var/www/html', '/var/www/html/css', '/var/www/html/images']) {
    const n = fs.stat(d, root);
    n.uid = lu;
    n.gid = www;
    n.mode = 0o2775;
  }
  put('/etc/nginx/sites-available/default', NGINX_DEFAULT);
  put('/etc/nginx/nginx.conf', 'user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n\tworker_connections 768;\n}\n\nhttp {\n\tsendfile on;\n\taccess_log /var/log/nginx/access.log;\n\terror_log /var/log/nginx/error.log;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n');
  mkdirp('/etc/nginx/sites-enabled');
  if (!fs.tryStat('/etc/nginx/sites-enabled/default', root, false)) fs.symlink('/etc/nginx/sites-available/default', '/etc/nginx/sites-enabled/default', root);
  put('/var/log/nginx/access.log', accessLog(now), { uid: 33, gid: adm, mode: 0o640, time: now - 60000 });
  put('/var/log/nginx/error.log', `${localDateTime(now - 5 * 3600 * 1000).replace(/-/g, '/')} [error] 812#812: *41 open() "/var/www/html/wp-login.php" failed (2: No such file or directory), client: 203.0.113.9, server: webserver.example.com, request: "GET /wp-login.php HTTP/1.1", host: "webserver.example.com"\n`, { uid: 33, gid: adm, mode: 0o640 });
  put('/home/learner/README.txt', REMOTE_README, { uid: lu, gid: lg, mode: 0o644 });
  put('/home/learner/backup.sh', '#!/bin/bash\n# Back up the website into ~/backups\nmkdir -p ~/backups\ntar -czf ~/backups/site-$(date +%F).tar.gz -C /var/www html\necho "Backup saved in ~/backups"\n', { uid: lu, gid: lg, mode: 0o755 });
  put('/etc/motd', '');
}

const WEBSERVER_SSH: SshHostConfig = { hostname: 'webserver', setup: setupWebserver };

// ===========================================================================
// The host registry

export const LOCAL_IP = '10.0.2.15';
export const GATEWAY_IP = '10.0.2.2';

export const SIMULATED_HOSTS: SimHost[] = [
  { names: ['example.com', 'www.example.com'], ip: '203.0.113.80', rtt: 11.6, ttl: 56, bandwidth: 8 * 1024 * 1024, http: exampleSite, https: exampleSite, firewalled: true, description: 'The classic "Example Domain" web page.' },
  { names: ['example.org', 'www.example.org'], ip: '203.0.113.81', rtt: 12.3, ttl: 56, bandwidth: 8 * 1024 * 1024, http: exampleSite, https: exampleSite, firewalled: true, description: 'Another "Example Domain" web page.' },
  { names: ['example.net', 'www.example.net'], ip: '203.0.113.82', rtt: 13.1, ttl: 56, bandwidth: 8 * 1024 * 1024, http: exampleSite, https: exampleSite, firewalled: true, description: 'Another "Example Domain" web page.' },
  { names: ['api.example.com'], ip: '203.0.113.20', rtt: 22.4, ttl: 54, bandwidth: 4 * 1024 * 1024, http: apiSite, https: apiSite, firewalled: true, description: 'A small JSON API: /users, /users/1, /weather?city=London, /time, /headers, /echo, /status/404.' },
  { names: ['files.example.com', 'downloads.example.com'], ip: '203.0.113.30', rtt: 34.8, ttl: 52, bandwidth: 5 * 1024 * 1024, http: filesSite, https: filesSite, firewalled: true, description: 'Files to download: hello.txt, data.csv, project.tar.gz, notes.zip, logo.png, sample-video.mp4 (/latest redirects).' },
  { names: ['webserver', 'webserver.example.com'], ip: '192.0.2.10', ptr: 'webserver.example.com', rtt: 2.4, ttl: 63, bandwidth: 40 * 1024 * 1024, http: webserverSite, ssh: WEBSERVER_SSH, description: 'A remote Ubuntu server running nginx; log in with: ssh webserver (any password).' },
  { names: ['_gateway'], ip: GATEWAY_IP, ptr: '_gateway', rtt: 0.31, ttl: 64, bandwidth: 1e8, description: 'The router (default gateway) of the local network.' },
  { names: [], ip: '10.0.2.3', rtt: 0.35, ttl: 64, bandwidth: 1e8, description: 'The local network\'s DNS forwarder.' },
  { names: ['dns.google'], ip: '8.8.8.8', ptr: 'dns.google', rtt: 9.8, ttl: 117, bandwidth: 1e6, firewalled: true, description: "Google's public DNS resolver (answers ping)." },
  { names: [], ip: '8.8.4.4', ptr: 'dns.google', rtt: 10.4, ttl: 117, bandwidth: 1e6, firewalled: true, description: "Google's second public DNS resolver (answers ping)." },
  { names: ['one.one.one.one'], ip: '1.1.1.1', ptr: 'one.one.one.one', rtt: 8.1, ttl: 57, bandwidth: 1e6, firewalled: true, description: "Cloudflare's public DNS resolver (answers ping)." },
  { names: [], ip: '1.0.0.1', ptr: 'one.one.one.one', rtt: 8.4, ttl: 57, bandwidth: 1e6, firewalled: true, description: "Cloudflare's second public DNS resolver (answers ping)." },
  { names: ['dns.quad9.net'], ip: '9.9.9.9', ptr: 'dns9.quad9.net', rtt: 11.2, ttl: 58, bandwidth: 1e6, firewalled: true, description: 'Quad9 public DNS resolver (answers ping).' },
];

/** Network settings of one simulated computer (shown by ip and ss). */
interface NetProfile {
  ip: string;
  prefix: number;
  gateway: string;
  mac: string;
  ifname: string;
  services: ('ssh' | 'http' | 'dns' | 'dhcp' | 'cups')[];
  extraAddrs: string[];
  extraRoutes: string[];
  linkDown: Set<string>;
}

const profiles = new WeakMap<System, NetProfile>();

/** The IPv4 address of a simulated computer's network card (10.0.2.15 for the learner's machine). */
export function systemIp(sys: System): string {
  return profileOf(sys).ip;
}

function profileOf(sys: System): NetProfile {
  let p = profiles.get(sys);
  if (!p) {
    p = { ip: LOCAL_IP, prefix: 24, gateway: GATEWAY_IP, mac: '08:00:27:3a:5c:7e', ifname: 'eth0', services: ['ssh', 'http', 'dns', 'dhcp'], extraAddrs: [], extraRoutes: [], linkDown: new Set() };
    profiles.set(sys, p);
  }
  return p;
}

interface Connection {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  process: string;
}

const connections = new WeakMap<System, Connection[]>();

function connectionsOf(sys: System): Connection[] {
  let c = connections.get(sys);
  if (!c) {
    // The learner's own login to this computer (see `w`): an SSH session from the host machine.
    c = [{ localIp: profileOf(sys).ip, localPort: 22, remoteIp: GATEWAY_IP, remotePort: 52144, process: 'sshd' }];
    connections.set(sys, c);
  }
  return c;
}

function isIPv4(s: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((p) => Number(p) <= 255);
}

/** Read /etc/hosts of a simulated computer. */
function hostsFile(sys: System): [string, string[]][] {
  let text = '';
  try {
    text = sys.fs.readFile('/etc/hosts', { cwd: '/', creds: ROOT_CREDS });
  } catch {
    return [];
  }
  const out: [string, string[]][] = [];
  for (const line of text.split('\n')) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const [ip, ...names] = clean.split(/\s+/);
    if (isIPv4(ip) && names.length) out.push([ip, names.map((n) => n.toLowerCase())]);
  }
  return out;
}

/** Resolve a host name to an IPv4 address the way getaddrinfo would. */
export function resolveName(sys: System, name: string): string | null {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (isIPv4(n)) return n;
  for (const [ip, names] of hostsFile(sys)) if (names.includes(n)) return ip;
  if (n === 'localhost' || n.endsWith('.localhost')) return '127.0.0.1';
  if (n === sys.hostname.toLowerCase()) return '127.0.1.1';
  const host = SIMULATED_HOSTS.find((h) => h.names.includes(n));
  return host ? host.ip : null;
}

/** Name for an address (reverse lookup), as ping prints it. */
function reverseName(sys: System, ip: string): string | null {
  for (const [hip, names] of hostsFile(sys)) if (hip === ip) return names[0];
  if (ip === '127.0.0.1') return 'localhost';
  const host = SIMULATED_HOSTS.find((h) => h.ip === ip);
  return host?.ptr ?? null;
}

type Target = { kind: 'local' } | { kind: 'host'; host: SimHost } | { kind: 'lan-missing' } | { kind: 'nothing' };

/** What answers at an IP address, seen from `sys`. */
function targetFor(sys: System, ip: string): Target {
  const prof = profileOf(sys);
  if (ip.startsWith('127.') || ip === prof.ip || prof.extraAddrs.some((a) => a.split('/')[0] === ip)) return { kind: 'local' };
  const host = SIMULATED_HOSTS.find((h) => h.ip === ip);
  if (host && !(host.ip === prof.ip)) return { kind: 'host', host };
  const [a, b, c] = prof.ip.split('.');
  if (ip.startsWith(`${a}.${b}.${c}.`)) return { kind: 'lan-missing' };
  return { kind: 'nothing' };
}

const remoteSystems = new WeakMap<System, Map<string, System>>();

/**
 * The simulated computer behind an SSH host (created on first use and kept
 * for the rest of the session). Lessons can use this to inspect its files.
 */
export async function remoteSystem(local: System, name: string): Promise<System | null> {
  const ip = resolveName(local, name);
  const host = SIMULATED_HOSTS.find((h) => h.names.includes(name.toLowerCase()) || (ip !== null && h.ip === ip));
  if (!host || !host.ssh) return null;
  let map = remoteSystems.get(local);
  if (!map) {
    map = new Map();
    remoteSystems.set(local, map);
  }
  const existing = map.get(host.ssh.hostname);
  if (existing) return existing;
  const { createSystem } = await import('../index');
  const sys = createSystem({ hostname: host.ssh.hostname, now: local.now, delay: local.delay, random: local.random, samples: false });
  profiles.set(sys, { ip: host.ip, prefix: 24, gateway: '192.0.2.1', mac: '52:54:00:8e:21:4b', ifname: 'eth0', services: ['ssh', 'http', 'dns', 'dhcp'], extraAddrs: [], extraRoutes: [], linkDown: new Set() });
  connections.set(sys, []);
  host.ssh.setup(sys);
  map.set(host.ssh.hostname, sys);
  return sys;
}

/** Sleep in small steps so a flag (set by a signal handler) can cut it short. */
async function napUntil(ctx: CommandContext, ms: number, stop: () => boolean): Promise<void> {
  let left = ms;
  while (left > 0 && !stop()) {
    const step = Math.min(left, 50);
    await ctx.sleep(step);
    left -= step;
  }
}

// ===========================================================================
// URLs and HTTP transfers

interface ParsedUrl {
  scheme: string;
  host: string;
  port: number;
  explicitPort: boolean;
  user?: string;
  /** Path as written (still percent-encoded), starting with "/". */
  path: string;
  rawQuery: string;
}

type UrlResult = { ok: true; url: ParsedUrl } | { ok: false; code: number; message: string };

function parseUrl(raw: string): UrlResult {
  let s = raw.trim();
  if (/\s/.test(s)) return { ok: false, code: 3, message: 'URL rejected: Malformed input to a URL function' };
  let scheme = 'http';
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    s = s.slice(m[0].length);
  }
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, code: 1, message: `Protocol "${scheme}" not supported or disabled in libcurl` };
  const hashAt = s.indexOf('#');
  if (hashAt !== -1) s = s.slice(0, hashAt);
  const slash = s.search(/[/?]/);
  let authority = slash === -1 ? s : s.slice(0, slash);
  let rest = slash === -1 ? '/' : s.slice(slash);
  if (!rest.startsWith('/')) rest = '/' + rest;
  let user: string | undefined;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    user = authority.slice(0, at);
    authority = authority.slice(at + 1);
  }
  let host = authority;
  let port = scheme === 'https' ? 443 : 80;
  let explicitPort = false;
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    host = authority.slice(0, colon);
    const p = authority.slice(colon + 1);
    if (p !== '') {
      if (!/^\d+$/.test(p) || Number(p) > 65535) return { ok: false, code: 3, message: 'URL rejected: Port number was not a decimal number between 0 and 65535' };
      port = Number(p);
      explicitPort = true;
    }
  }
  if (host === '') return { ok: false, code: 3, message: 'URL rejected: No host part in the URL' };
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const rawQuery = q === -1 ? '' : rest.slice(q + 1);
  return { ok: true, url: { scheme, host: host.toLowerCase(), port, explicitPort, user, path, rawQuery } };
}

function urlString(u: ParsedUrl): string {
  const defPort = u.scheme === 'https' ? 443 : 80;
  return `${u.scheme}://${u.host}${u.port !== defPort ? ':' + u.port : ''}${u.path}${u.rawQuery ? '?' + u.rawQuery : ''}`;
}

function resolveRelative(base: ParsedUrl, location: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(location)) return location;
  if (location.startsWith('//')) return `${base.scheme}:${location}`;
  const defPort = base.scheme === 'https' ? 443 : 80;
  const origin = `${base.scheme}://${base.host}${base.port !== defPort ? ':' + base.port : ''}`;
  if (location.startsWith('/')) return origin + location;
  const dir = base.path.replace(/[^/]*$/, '');
  return origin + dir + location;
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

type ConnectFailure = { reason: 'resolve' } | { reason: 'refused'; ip: string; ms: number } | { reason: 'timeout'; ip: string; ms: number } | { reason: 'noroute'; ip: string; ms: number };

interface Connected {
  ip: string;
  handler: HttpHandler;
  rtt: number;
  bandwidth: number;
  server?: System;
}

/** Open a "TCP connection" to a web server. */
async function connectHttp(ctx: CommandContext, u: ParsedUrl, timeoutMs: number): Promise<Connected | ConnectFailure> {
  const ip = resolveName(ctx.system, u.host);
  if (!ip) return { reason: 'resolve' };
  const t = targetFor(ctx.system, ip);
  if (t.kind === 'local') {
    if (u.port === 80 && profileOf(ctx.system).services.includes('http')) {
      const sys = ctx.system;
      return { ip, rtt: 0.05, bandwidth: 200 * 1024 * 1024, handler: (req) => serveStatic(sys, '/var/www/html', req, sys.now()) };
    }
    return { reason: 'refused', ip, ms: 0 };
  }
  if (t.kind === 'host') {
    const h = t.host;
    const handler = u.port === 80 ? h.http : u.port === 443 ? h.https : undefined;
    await ctx.sleep(Math.round(h.rtt));
    if (handler) return { ip, handler, rtt: h.rtt, bandwidth: h.bandwidth };
    if (h.firewalled) {
      await ctx.sleep(timeoutMs);
      return { reason: 'timeout', ip, ms: timeoutMs + Math.round(h.rtt) };
    }
    return { reason: 'refused', ip, ms: Math.round(h.rtt) };
  }
  if (t.kind === 'lan-missing') {
    await ctx.sleep(3000);
    return { reason: 'noroute', ip, ms: 3071 };
  }
  await ctx.sleep(timeoutMs);
  return { reason: 'timeout', ip, ms: timeoutMs };
}

function buildRequest(u: ParsedUrl, method: string, headers: Record<string, string>, body: string): HttpRequest {
  return { method, scheme: u.scheme as 'http' | 'https', host: u.host, port: u.port, path: decodePath(u.path), rawQuery: u.rawQuery, query: parseQuery(u.rawQuery), headers, body };
}

// ===========================================================================
// curl

class CurlUsage extends Error {}

interface CurlUrl {
  url: string;
  output?: string;
  remoteName?: boolean;
}

interface CurlOpts {
  urls: CurlUrl[];
  silent: boolean;
  showError: boolean;
  location: boolean;
  head: boolean;
  include: boolean;
  verbose: boolean;
  method: string | null;
  data: string[];
  dataMode: 'form' | 'raw' | 'binary' | 'json' | 'urlencode';
  json: boolean;
  headers: string[];
  fail: boolean;
  userAgent: string | null;
  user: string | null;
  writeOut: string | null;
  progressBar: boolean;
  maxTime: number | null;
  connectTimeout: number | null;
  get: boolean;
  createDirs: boolean;
  outputDir: string | null;
  http11: boolean;
  noProgress: boolean;
  remoteNameAll: boolean;
}

const CURL_LONG: Record<string, { key: string; arg: boolean }> = {
  output: { key: 'o', arg: true }, 'remote-name': { key: 'O', arg: false }, silent: { key: 's', arg: false }, 'show-error': { key: 'S', arg: false },
  location: { key: 'L', arg: false }, head: { key: 'I', arg: false }, include: { key: 'i', arg: false }, verbose: { key: 'v', arg: false },
  request: { key: 'X', arg: true }, data: { key: 'd', arg: true }, 'data-ascii': { key: 'd', arg: true }, 'data-raw': { key: 'data-raw', arg: true },
  'data-binary': { key: 'data-binary', arg: true }, 'data-urlencode': { key: 'data-urlencode', arg: true }, json: { key: 'json', arg: true },
  header: { key: 'H', arg: true }, fail: { key: 'f', arg: false }, 'fail-with-body': { key: 'f', arg: false }, 'user-agent': { key: 'A', arg: true },
  user: { key: 'u', arg: true }, 'write-out': { key: 'w', arg: true }, 'progress-bar': { key: '#', arg: false }, 'max-time': { key: 'm', arg: true },
  'connect-timeout': { key: 'connect-timeout', arg: true }, get: { key: 'G', arg: false }, 'create-dirs': { key: 'create-dirs', arg: false },
  'output-dir': { key: 'output-dir', arg: true }, insecure: { key: 'k', arg: false }, compressed: { key: 'compressed', arg: false },
  'http1.1': { key: 'http1.1', arg: false }, http2: { key: 'http2', arg: false }, ipv4: { key: '4', arg: false }, ipv6: { key: '6', arg: false },
  'no-progress-meter': { key: 'no-progress-meter', arg: false }, url: { key: 'url', arg: true }, 'remote-name-all': { key: 'remote-name-all', arg: false },
  retry: { key: 'retry', arg: true }, referer: { key: 'e', arg: true }, cookie: { key: 'b', arg: true }, 'cookie-jar': { key: 'c', arg: true },
  'remote-header-name': { key: 'J', arg: false }, 'no-buffer': { key: 'N', arg: false }, globoff: { key: 'g', arg: false }, 'tlsv1.2': { key: 'tls', arg: false },
  'tlsv1.3': { key: 'tls', arg: false }, 'ssl-reqd': { key: 'tls', arg: false }, 'keepalive-time': { key: 'kat', arg: true }, 'path-as-is': { key: 'pai', arg: false },
};

const CURL_SHORT_ARG = new Set(['o', 'X', 'd', 'H', 'A', 'u', 'w', 'm', 'e', 'b', 'c', 'T', 'F', 'r', 'C', 'x', 'E', 'K', 'Y', 'y', 'z', 'U', 'Q', 'P']);
const CURL_SHORT_FLAG = new Set(['O', 's', 'S', 'L', 'I', 'i', 'v', 'f', '#', 'G', 'k', '4', '6', 'J', 'N', 'g', 'q', 'n', 'R', 'Z', '0', '1', '2', '3', 'l', 'B', 'j', 'p', 'a', 't']);

function curlParse(args: string[]): CurlOpts {
  const o: CurlOpts = {
    urls: [], silent: false, showError: false, location: false, head: false, include: false, verbose: false, method: null, data: [], dataMode: 'form', json: false,
    headers: [], fail: false, userAgent: null, user: null, writeOut: null, progressBar: false, maxTime: null, connectTimeout: null, get: false, createDirs: false,
    outputDir: null, http11: false, noProgress: false, remoteNameAll: false,
  };
  const outputs: { file?: string; remote?: boolean }[] = [];
  const apply = (key: string, value: string | null) => {
    switch (key) {
      case 'o': outputs.push({ file: value! }); break;
      case 'O': outputs.push({ remote: true }); break;
      case 's': o.silent = true; break;
      case 'S': o.showError = true; break;
      case 'L': o.location = true; break;
      case 'I': o.head = true; break;
      case 'i': o.include = true; break;
      case 'v': o.verbose = true; break;
      case 'X': o.method = value; break;
      case 'd': o.data.push(value!); break;
      case 'data-raw': o.data.push(value!); o.dataMode = 'raw'; break;
      case 'data-binary': o.data.push(value!); o.dataMode = 'binary'; break;
      case 'data-urlencode': o.data.push(value!); o.dataMode = 'urlencode'; break;
      case 'json': o.data.push(value!); o.json = true; break;
      case 'H': o.headers.push(value!); break;
      case 'f': o.fail = true; break;
      case 'A': o.userAgent = value; break;
      case 'u': o.user = value; break;
      case 'w': o.writeOut = value; break;
      case '#': o.progressBar = true; break;
      case 'm': o.maxTime = Number(value); break;
      case 'connect-timeout': o.connectTimeout = Number(value); break;
      case 'G': o.get = true; break;
      case 'create-dirs': o.createDirs = true; break;
      case 'output-dir': o.outputDir = value; break;
      case 'http1.1': o.http11 = true; break;
      case 'no-progress-meter': o.noProgress = true; break;
      case 'url': o.urls.push({ url: value! }); break;
      case 'remote-name-all': o.remoteNameAll = true; break;
      case 'T': case 'F': case 'x': case 'E': case 'K': case 'Y': case 'y': case 'z': case 'U': case 'Q': case 'P': case 'r': case 'C': case 'c': case 'b': case 'e':
        break;
      default:
        break;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      for (const u of args.slice(i + 1)) o.urls.push({ url: u });
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      let name = a.slice(2);
      let inline: string | null = null;
      const eq = name.indexOf('=');
      if (eq !== -1 && CURL_LONG[name.slice(0, eq)]?.arg) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const neg = name.startsWith('no-') && CURL_LONG[name.slice(3)] && !CURL_LONG[name.slice(3)].arg;
      const def = CURL_LONG[name] ?? (neg ? CURL_LONG[name.slice(3)] : undefined);
      if (!def) throw new CurlUsage(`option ${a}: is unknown`);
      if (neg) continue;
      if (def.arg) {
        const v = inline ?? args[++i];
        if (v === undefined) throw new CurlUsage(`option ${a}: requires parameter`);
        apply(def.key, v);
      } else apply(def.key, null);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (CURL_SHORT_ARG.has(c)) {
          const rest = a.slice(j + 1);
          const v = rest !== '' ? rest : args[++i];
          if (v === undefined) throw new CurlUsage(`option -${c}: requires parameter`);
          apply(c, v);
          break;
        }
        if (!CURL_SHORT_FLAG.has(c)) throw new CurlUsage(`option -${c}: is unknown`);
        apply(c, null);
      }
      continue;
    }
    o.urls.push({ url: a });
  }
  outputs.forEach((out, idx) => {
    const u = o.urls[idx];
    if (!u) return;
    if (out.file !== undefined) u.output = out.file;
    if (out.remote) u.remoteName = true;
  });
  if (o.remoteNameAll) for (const u of o.urls) if (u.output === undefined) u.remoteName = true;
  return o;
}

/** curl's max5data(): a number in at most five columns. */
function max5(n: number): string {
  if (n < 100000) return String(Math.round(n)).padStart(5);
  if (n < 10000 * 1024) return (String(Math.floor(n / 1024)) + 'k').padStart(5);
  if (n < 100 * 1024 * 1024) return `${String(Math.floor(n / 1048576)).padStart(2)}.${Math.floor((n % 1048576) / 104858)}M`;
  return (String(Math.floor(n / 1048576)) + 'M').padStart(5);
}

function curlTime(sec: number): string {
  if (sec <= 0) return '--:--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2)}:${pad2(m)}:${pad2(s)}`;
}

function meterLine(total: number | null, got: number, speed: number, spent: number, current: number): string {
  const pct = total ? Math.floor((100 * got) / total) : got > 0 && total === null ? 0 : 0;
  const totalPct = total ? Math.floor((100 * got) / total) : 0;
  const tTotal = total && speed > 0 ? curlTime(Math.floor(total / speed)) : '--:--:--';
  const tSpent = spent >= 1 ? curlTime(Math.floor(spent)) : '--:--:--';
  const tLeft = total && speed > 0 && spent >= 1 ? curlTime(Math.max(0, Math.ceil((total - got) / speed))) : '--:--:--';
  return `${String(totalPct).padStart(3)} ${max5(total ?? 0)}  ${String(pct).padStart(3)} ${max5(got)}    0     0  ${max5(speed)}      0 ${tTotal} ${tSpent} ${tLeft} ${max5(current)}`;
}

const METER_HEADER = '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n';

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function readPasswordTty(ctx: CommandContext, prompt: string): Promise<string | null> {
  const tty = ctx.tty;
  if (!tty) return null;
  await tty.write(prompt);
  const saved = tty.getModes();
  tty.setModes({ icanon: true, echo: false, isig: true });
  try {
    const input = new TtyInput(tty, ctx.proc.job);
    const line = await input.readLine(ctx.signal);
    await tty.write('\n');
    return line === null ? null : line.replace(/\n$/, '');
  } finally {
    tty.setModes(saved);
  }
}

async function readLineTty(ctx: CommandContext): Promise<string | null> {
  const tty = ctx.tty;
  if (!tty) return null;
  const input = new TtyInput(tty, ctx.proc.job);
  const line = await input.readLine(ctx.signal);
  return line === null ? null : line.replace(/\n$/, '');
}

function writeOutFormat(fmt: string, vars: Record<string, string>): string {
  return fmt
    .replace(/%\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

async function curlMain(ctx: CommandContext): Promise<number> {
  let o: CurlOpts;
  try {
    o = curlParse(ctx.args);
  } catch (e) {
    if (e instanceof CurlUsage) {
      await ctx.err(`curl: ${e.message}\ncurl: try 'curl --help' or 'curl --manual' for more information\n`);
      return 2;
    }
    throw e;
  }
  if (o.urls.length === 0) {
    await ctx.err("curl: try 'curl --help' or 'curl --manual' for more information\n");
    return 2;
  }
  // Request body.
  let body = '';
  for (const d of o.data) {
    let piece = d;
    if (d.startsWith('@') && o.dataMode !== 'raw') {
      const file = d.slice(1);
      try {
        piece = file === '-' ? await ctx.stdin.readAll() : ctx.fs.readFile(file);
      } catch {
        await ctx.err(`curl: Failed to open ${file}\ncurl: option -d: error encountered when reading a file\ncurl: try 'curl --help' or 'curl --manual' for more information\n`);
        return 26;
      }
      if (o.dataMode === 'form') piece = piece.replace(/[\r\n]/g, '');
    } else if (o.dataMode === 'urlencode') {
      const eq = d.indexOf('=');
      piece = eq === -1 ? encodeURIComponent(d) : d.slice(0, eq + 1) + encodeURIComponent(d.slice(eq + 1));
    }
    body = body === '' ? piece : body + '&' + piece;
  }
  let status = 0;
  for (const target of o.urls) {
    await ctx.checkpoint();
    const r = await curlOne(ctx, o, target, body);
    if (r !== 0) status = r;
  }
  return status;
}

async function curlOne(ctx: CommandContext, o: CurlOpts, target: CurlUrl, reqBody: string): Promise<number> {
  const showErr = !o.silent || o.showError;
  const fail = async (code: number, msg: string): Promise<number> => {
    if (showErr) await ctx.err(`curl: (${code}) ${msg}\n`);
    return code;
  };
  let rawUrl = target.url;
  let method = o.method ?? (o.head ? 'HEAD' : o.data.length && !o.get ? 'POST' : 'GET');
  if (o.get && reqBody) rawUrl += (rawUrl.includes('?') ? '&' : '?') + reqBody;
  const meterOn = !o.silent && !o.noProgress && (target.output !== undefined || target.remoteName || !ctx.stdout.isTTY);
  const bar = o.progressBar && meterOn;
  let meterStarted = false;
  const startMeter = async () => {
    if (!meterOn || meterStarted) return;
    meterStarted = true;
    if (bar) return;
    await ctx.err(METER_HEADER + '\r' + meterLine(null, 0, 0, 0, 0));
  };
  const endMeterError = async () => {
    if (meterOn && meterStarted && !bar) await ctx.err('\n');
  };
  await startMeter();
  let redirects = 0;
  const verbose = (s: string) => (o.verbose ? ctx.err(s) : Promise.resolve());
  for (;;) {
    const parsed = parseUrl(rawUrl);
    if (!parsed.ok) {
      await endMeterError();
      return fail(parsed.code, parsed.message);
    }
    const u = parsed.url;
    const timeoutMs = Math.round(((o.connectTimeout ?? o.maxTime ?? 10) as number) * 1000);
    const conn = await connectHttp(ctx, u, timeoutMs);
    if ('reason' in conn) {
      if (conn.reason === 'resolve') {
        await verbose(`* Could not resolve host: ${u.host}\n* Closing connection\n`);
        await endMeterError();
        return fail(6, `Could not resolve host: ${u.host}`);
      }
      await verbose(`* Host ${u.host}:${u.port} was resolved.\n* IPv6: (none)\n* IPv4: ${conn.ip}\n*   Trying ${conn.ip}:${u.port}...\n`);
      await endMeterError();
      if (conn.reason === 'timeout') return fail(28, `Failed to connect to ${u.host} port ${u.port} after ${conn.ms} ms: Couldn't connect to server`);
      if (conn.reason === 'noroute') return fail(7, `Failed to connect to ${u.host} port ${u.port} after ${conn.ms} ms: No route to host`);
      return fail(7, `Failed to connect to ${u.host} port ${u.port} after ${conn.ms} ms: Couldn't connect to server`);
    }
    const h2 = u.scheme === 'https' && !o.http11 && !(targetFor(ctx.system, conn.ip).kind === 'local');
    const headers: Record<string, string> = { host: u.host + (u.explicitPort ? ':' + u.port : ''), 'user-agent': o.userAgent ?? CURL_UA, accept: o.json ? 'application/json' : '*/*' };
    const order: string[] = ['host'];
    if (o.user ?? u.user) {
      let cred = o.user ?? decodePath(u.user!);
      if (!cred.includes(':')) {
        const pw = await readPasswordTty(ctx, `Enter host password for user '${cred}':`);
        cred += ':' + (pw ?? '');
      }
      headers.authorization = 'Basic ' + base64(cred);
      order.push('authorization');
    }
    order.push('user-agent', 'accept');
    if (reqBody && method !== 'GET' && method !== 'HEAD') {
      headers['content-length'] = String(new TextEncoder().encode(reqBody).length);
      headers['content-type'] = o.json ? 'application/json' : 'application/x-www-form-urlencoded';
      order.push('content-type', 'content-length');
    }
    for (const hline of o.headers) {
      const ci = hline.indexOf(':');
      const si = hline.indexOf(';');
      if (ci === -1 && si !== -1 && si === hline.length - 1) {
        const k = hline.slice(0, -1).trim().toLowerCase();
        headers[k] = '';
        if (!order.includes(k)) order.push(k);
        continue;
      }
      if (ci === -1) continue;
      const k = hline.slice(0, ci).trim().toLowerCase();
      const v = hline.slice(ci + 1).trim();
      if (v === '') {
        delete headers[k];
        continue;
      }
      headers[k] = v;
      if (!order.includes(k)) order.push(k);
    }
    const shownHeaders = order.filter((k) => k in headers);
    const titled = (k: string) => (h2 ? k : k.replace(/(^|-)\w/g, (c) => c.toUpperCase()));
    // Verbose: connection and request.
    if (o.verbose) {
      let v = `* Host ${u.host}:${u.port} was resolved.\n* IPv6: (none)\n* IPv4: ${conn.ip}\n*   Trying ${conn.ip}:${u.port}...\n* Connected to ${u.host} (${conn.ip}) port ${u.port}\n`;
      if (u.scheme === 'https') {
        v += `* ALPN: curl offers ${o.http11 ? 'http/1.1' : 'h2,http/1.1'}\n* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n*  CAfile: /etc/ssl/certs/ca-certificates.crt\n*  CApath: /etc/ssl/certs\n`;
        v += '* TLSv1.3 (IN), TLS handshake, Server hello (2):\n* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):\n* TLSv1.3 (IN), TLS handshake, Certificate (11):\n* TLSv1.3 (IN), TLS handshake, CERT verify (15):\n* TLSv1.3 (IN), TLS handshake, Finished (20):\n* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):\n* TLSv1.3 (OUT), TLS handshake, Finished (20):\n';
        v += `* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384 / X25519 / RSASSA-PSS\n* ALPN: server accepted ${h2 ? 'h2' : 'http/1.1'}\n* Server certificate:\n*  subject: CN=${u.host}\n*  start date: Sep 15 00:00:00 2026 GMT\n*  expire date: Dec 14 23:59:59 2026 GMT\n*  subjectAltName: host "${u.host}" matched cert's "${u.host}"\n*  issuer: C=US; O=Example Trust Services; CN=Example TLS RSA CA 1\n*  SSL certificate verify ok.\n`;
      }
      if (h2) {
        v += `* using HTTP/2\n* [HTTP/2] [1] OPENED stream for ${urlString(u)}\n* [HTTP/2] [1] [:method: ${method}]\n* [HTTP/2] [1] [:scheme: https]\n* [HTTP/2] [1] [:authority: ${headers.host}]\n* [HTTP/2] [1] [:path: ${u.path}${u.rawQuery ? '?' + u.rawQuery : ''}]\n`;
        for (const k of shownHeaders) if (k !== 'host') v += `* [HTTP/2] [1] [${k}: ${headers[k]}]\n`;
      } else if (u.scheme === 'https') {
        v += '* using HTTP/1.x\n';
      }
      v += `> ${method} ${u.path}${u.rawQuery ? '?' + u.rawQuery : ''} ${h2 ? 'HTTP/2' : 'HTTP/1.1'}\r\n`;
      for (const k of shownHeaders) v += `> ${titled(k === 'host' ? 'Host' : k)}: ${headers[k]}\r\n`;
      v += '> \r\n';
      if (reqBody && method !== 'GET' && method !== 'HEAD') v += `} [${headers['content-length']} bytes data]\n* upload completely sent off: ${headers['content-length']} bytes\n`;
      await ctx.err(v);
    }
    const req = buildRequest(u, method, headers, method === 'GET' || method === 'HEAD' ? '' : reqBody);
    let res: HttpResponse;
    try {
      res = await conn.handler(req, { system: ctx.system, server: conn.server });
    } catch (e) {
      if (e instanceof SignalError) throw e;
      await endMeterError();
      return fail(52, 'Empty reply from server');
    }
    await ctx.sleep(Math.round(conn.rtt));
    const headLines = (styled: boolean): string => {
      let out = h2 ? `HTTP/2 ${res.status} \r\n` : `HTTP/1.1 ${res.status} ${statusText(res.status)}\r\n`;
      for (const [k, v] of res.headers) {
        const name = h2 ? k.toLowerCase() : k;
        out += `${styled ? `\x1b[1m${name}\x1b[0m` : name}: ${v}\r\n`;
      }
      return out + '\r\n';
    };
    if (o.verbose) {
      const lines = headLines(false).split('\r\n').slice(0, -1);
      await ctx.err(lines.map((l) => `< ${l}\r\n`).join(''));
    }
    const location = header(res, 'location');
    if (o.location && location && res.status >= 300 && res.status < 400) {
      if (o.include || o.head) await ctx.out(headLines(ctx.stdout.isTTY));
      if (++redirects > 50) {
        await endMeterError();
        return fail(47, 'Maximum (50) redirects followed');
      }
      const next = resolveRelative(u, location);
      await verbose(`* Ignoring the response-body\n* Connection #0 to host ${u.host} left intact\n* Issue another request to this URL: '${next}'\n`);
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        if (method === 'POST' && o.method === null) method = 'GET';
      }
      rawUrl = next;
      continue;
    }
    // The response body.
    const bodyData = asBinary(res.body);
    const size = method === 'HEAD' ? 0 : bodyLength(bodyData);
    const lenHeader = header(res, 'content-length');
    const total = lenHeader !== undefined ? Number(lenHeader) : null;
    const httpFail = o.fail && res.status >= 400;
    // Progress while "downloading".
    const seconds = size / conn.bandwidth;
    const speed = Math.max(1, Math.round(size / Math.max(seconds + (conn.rtt * 2) / 1000, 0.00004)));
    if (meterOn && !bar && seconds >= 1) {
      let got = 0;
      for (let t = 1; t <= Math.floor(seconds); t++) {
        await ctx.sleep(1000);
        got = Math.min(size, Math.round(conn.bandwidth * t));
        await ctx.err('\r' + meterLine(total, got, Math.round(conn.bandwidth), t, Math.round(conn.bandwidth)));
      }
      await ctx.sleep(Math.round((seconds - Math.floor(seconds)) * 1000));
    } else if (bar && seconds >= 0.5) {
      const steps = Math.max(1, Math.floor(seconds * 4));
      for (let k = 1; k < steps; k++) {
        await ctx.sleep(250);
        const frac = k / steps;
        await ctx.err('\r' + '#'.repeat(Math.floor(frac * 72)).padEnd(72) + ` ${(frac * 100).toFixed(1).padStart(5)}%`);
      }
    } else if (seconds > 0) {
      await ctx.sleep(Math.round(seconds * 1000));
    }
    const finishMeter = async () => {
      if (!meterOn) return;
      if (bar) await ctx.err('\r' + '#'.repeat(72) + ' 100.0%\n');
      else await ctx.err('\r' + meterLine(total ?? (size || null), size, speed, seconds, speed) + '\n');
    };
    if (httpFail) {
      await finishMeter();
      return fail(22, `The requested URL returned error: ${res.status}`);
    }
    // Where does the body go?
    let outFile = target.output;
    if (target.remoteName && outFile === undefined) {
      const name = basename(decodePath(u.path));
      if (!name || u.path.endsWith('/')) {
        await finishMeter();
        if (showErr) await ctx.err('curl: Remote file name has no length\n');
        return fail(23, 'Failed writing received data to disk/application');
      }
      outFile = name;
    }
    if (outFile !== undefined && o.outputDir) outFile = `${o.outputDir.replace(/\/+$/, '')}/${outFile}`;
    const headText = o.include || o.head ? headLines(ctx.stdout.isTTY && outFile === undefined) : '';
    if (outFile !== undefined && outFile !== '-') {
      try {
        if (o.createDirs) {
          let cur = outFile.startsWith('/') ? '' : '.';
          for (const part of dirname(outFile).split('/').filter(Boolean)) {
            cur = cur === '' ? '/' + part : cur + '/' + part;
            if (!ctx.fs.tryStat(cur)) ctx.fs.mkdir(cur);
          }
        }
        const content: FileData = headText ? headText + (typeof bodyData === 'string' ? bodyData : '') : bodyData;
        ctx.fs.writeFile(outFile, typeof content === 'string' ? content : { ...content });
        if (o.verbose && size > 0 && !ctx.stdout.isTTY) await ctx.err(`{ [${size} bytes data]\n`);
      } catch (e) {
        if (showErr) await ctx.err(`Warning: Failed to open the file ${outFile}: ${errText(e)}\n`);
        await finishMeter();
        return fail(23, 'Failure writing output to destination');
      }
      await finishMeter();
    } else {
      await finishMeter();
      if (headText) await ctx.out(headText);
      if (method !== 'HEAD' && size > 0) {
        if (typeof bodyData !== 'string' && ctx.stdout.isTTY && outFile !== '-') {
          await ctx.err('Warning: Binary output can mess up your terminal. Use "--output -" to tell \nWarning: curl to output it to your terminal anyway, or consider "--output \nWarning: <FILE>" to save to a file.\n');
          return 23;
        }
        if (o.verbose && !ctx.stdout.isTTY) await ctx.err(`{ [${size} bytes data]\n`);
        await writeDataToStdout(ctx, bodyData);
      }
    }
    await verbose(`* Connection #0 to host ${u.host} left intact\n`);
    if (o.writeOut !== null) {
      await ctx.out(writeOutFormat(o.writeOut, {
        http_code: String(res.status),
        response_code: String(res.status),
        content_type: header(res, 'content-type') ?? '',
        size_download: String(size),
        size_header: String(headLines(false).length),
        url_effective: urlString(u),
        remote_ip: conn.ip,
        remote_port: String(u.port),
        num_redirects: String(redirects),
        time_total: (seconds + conn.rtt / 500).toFixed(6),
        method,
        scheme: u.scheme.toUpperCase(),
        http_version: h2 ? '2' : '1.1',
        filename_effective: outFile ?? '',
      }));
    }
    return 0;
  }
}

const CURL_DEF: CommandDef = {
  name: 'curl',
  pkg: 'curl',
  size: 289712,
  gnu: false,
  doc: {
    category: 'network',
    summary: 'transfer a URL',
    synopsis: ['curl [options...] <url>'],
    description:
      'curl downloads (or uploads) data from a server, given a URL such as https://example.com/. By default it prints what it receives to standard output, so you can read a web page, pipe JSON into another program, or redirect it into a file. Use -o FILE or -O to save it instead; then curl shows a progress meter.\n\n' +
      'curl speaks HTTP like a web browser: -I shows only the response headers, -i shows them before the body, -L follows redirects, -X sets the method (GET, POST, PUT, DELETE...), -d sends data in the request body and -H adds a request header. -v shows the whole conversation with the server.\n\n' +
      'In this simulator the internet is pretend: try example.com, api.example.com (a small JSON API), files.example.com (files to download), localhost (this computer\'s web server) and webserver.',
    options: [
      { flags: '-o, --output <file>', desc: 'Write output to <file> instead of stdout' },
      { flags: '-O, --remote-name', desc: 'Write output to a file named like the remote file' },
      { flags: '-s, --silent', desc: 'Silent mode: no progress meter or error messages' },
      { flags: '-S, --show-error', desc: 'Show error messages even when -s is used' },
      { flags: '-L, --location', desc: 'Follow redirects' },
      { flags: '-I, --head', desc: 'Show document info (headers) only' },
      { flags: '-i, --include', desc: 'Include protocol response headers in the output' },
      { flags: '-v, --verbose', desc: 'Make the operation more talkative' },
      { flags: '-X, --request <method>', desc: 'Specify request method to use' },
      { flags: '-d, --data <data>', desc: 'HTTP POST data (@file reads it from a file)' },
      { flags: '--json <data>', desc: 'HTTP POST JSON' },
      { flags: '-H, --header <header>', desc: 'Pass custom header(s) to server' },
      { flags: '-f, --fail', desc: 'Fail silently (no output at all) on HTTP errors' },
      { flags: '-A, --user-agent <name>', desc: 'Send User-Agent <name> to server' },
      { flags: '-u, --user <user:password>', desc: 'Server user and password' },
      { flags: '-w, --write-out <format>', desc: 'Use output FORMAT after completion, e.g. %{http_code}' },
      { flags: '-#, --progress-bar', desc: 'Display transfer progress as a bar' },
      { flags: '-G, --get', desc: 'Put the post data in the URL and use GET' },
      { flags: '-k, --insecure', desc: 'Allow insecure server connections' },
      { flags: '-m, --max-time <seconds>', desc: 'Maximum time allowed for transfer' },
      { flags: '--create-dirs', desc: 'Create necessary local directory hierarchy' },
    ],
    examples: [
      { cmd: 'curl https://example.com', desc: 'Print a web page (its HTML source).' },
      { cmd: 'curl -O https://files.example.com/hello.txt', desc: 'Download a file, keeping its name.' },
      { cmd: 'curl -o page.html https://example.com', desc: 'Save to a file name of your choice.' },
      { cmd: 'curl -I https://example.com', desc: 'Show only the response headers.' },
      { cmd: 'curl https://api.example.com/users/1', desc: 'Get JSON from an API.' },
      { cmd: 'curl -X POST -H "Content-Type: application/json" -d \'{"name":"Sam"}\' https://api.example.com/users', desc: 'Send JSON to an API.' },
      { cmd: 'curl -sL https://files.example.com/latest | tar -xz', desc: 'Download and unpack an archive in one go.' },
    ],
    seeAlso: ['wget', 'ping', 'ssh'],
    tip: 'curl prints to the screen by default. To save a download use -O (keep the remote name) or -o name.',
  },
  run: async (ctx) => {
    if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
      await ctx.out(gnuHelp(CURL_DEF));
      return 0;
    }
    if (ctx.args.includes('--version') || ctx.args.includes('-V')) {
      await ctx.out('curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.7\nRelease-Date: 2023-12-06, security patched: 8.5.0-2ubuntu10.6\nProtocols: dict file ftp ftps gopher gophers http https imap imaps ldap ldaps mqtt pop3 pop3s rtmp rtsp scp sftp smb smbs smtp smtps telnet tftp\nFeatures: alt-svc AsynchDNS brotli GSS-API HSTS HTTP2 HTTPS-proxy IDN IPv6 Kerberos Largefile libz NTLM PSL SPNEGO SSL threadsafe TLS-SRP UnixSockets zstd\n');
      return 0;
    }
    return curlMain(ctx);
  },
};

defineCommand(CURL_DEF);

// ===========================================================================
// wget

function wgetHuman(n: number, acc: number, decimals: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n;
  for (let i = 0; i < units.length; i++) {
    if (v / 1024 < 1024 || i === units.length - 1) {
      const val = v / 1024;
      return `${val < acc ? val.toFixed(decimals) : val.toFixed(0)}${units[i]}`;
    }
    v /= 1024;
  }
  return String(n);
}

function wgetRate(bytesPerSec: number, short: boolean): string {
  const units = short ? [' B/s', 'KB/s', 'MB/s', 'GB/s'] : ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let r = bytesPerSec;
  let u = 0;
  while (r >= 1024 && u < units.length - 1) {
    r /= 1024;
    u++;
  }
  const p = r >= 99.95 ? 0 : r >= 9.995 ? 1 : 2;
  return short ? `${r.toFixed(p).padStart(4)}${units[u]}` : `${r.toFixed(p)} ${units[u]}`;
}

function wgetDecimal(sec: number): string {
  const n = Math.abs(sec);
  if (n >= 9.95) return sec.toFixed(0);
  if (n >= 0.95) return sec.toFixed(1);
  if (n >= 0.001) return String(Number(sec.toPrecision(1)));
  if (n >= 0.0005) return sec.toFixed(3);
  return '0';
}

/** One frame of wget's progress bar. */
function wgetBar(name: string, width: number, total: number | null, got: number, rate: number | null, done: boolean, elapsed: number, tick: number): string {
  const maxName = Math.floor(width / 4);
  let s = '';
  const cols = [...name].length;
  if (cols < maxName) s += name + ' '.repeat(maxName - cols + 1);
  else {
    let offset = 0;
    if (cols > maxName + 5 && !done) offset = (tick + cols + Math.floor(maxName / 2)) % (cols + maxName);
    let pad = 0;
    if (offset > cols) {
      pad = maxName - (offset - cols);
      offset = 0;
    }
    const shown = [...name].slice(offset, offset + maxName - pad).join('');
    s += ' '.repeat(pad) + shown + ' '.repeat(maxName - (pad + [...shown].length) + 1);
  }
  const progressSize = width - (maxName + 1 + 4 + 2 + 8 + 10 + 15);
  if (total && total > 0) {
    const pct = Math.floor((100 * got) / total);
    s += String(pct).padStart(3) + '%';
    const dl = Math.floor((got / total) * progressSize);
    let barText = '';
    if (dl > 0) barText = '='.repeat(dl - 1) + '>';
    s += '[' + barText.padEnd(progressSize) + ']';
  } else {
    s += '    ';
    const pos = tick % (2 * (progressSize - 3));
    const at = pos < progressSize - 3 ? pos : 2 * (progressSize - 3) - pos;
    s += '[' + (' '.repeat(at) + '<=>').padEnd(progressSize) + ']';
  }
  const size = wgetHuman(got, 1000, 2);
  s += size.padStart(8);
  s += rate === null ? '  --.-KB/s' : `  ${wgetRate(rate, true)}`;
  if (done) {
    const t = `    in ${elapsed >= 10 ? `${Math.round(elapsed)}s` : `${wgetDecimal(elapsed)}s`}`;
    s += t.padEnd(15);
  } else if (total && total > 0) {
    if (elapsed > 3 && rate) {
      const eta = Math.max(0, Math.round((total - got) / rate));
      s += `    eta ${eta >= 60 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : `${eta}s`}`;
    } else s += '             ';
  }
  return s.padEnd(width);
}

interface WgetOpts {
  output: string | null;
  quiet: boolean;
  noVerbose: boolean;
  continue: boolean;
  prefix: string | null;
  serverResponse: boolean;
  spider: boolean;
  userAgent: string | null;
  headers: string[];
  postData: string | null;
  method: string | null;
  tries: number;
  timeout: number;
  limitRate: number | null;
  progress: 'bar' | 'dot' | null;
  urls: string[];
}

class WgetUsage extends Error {}

function wgetParse(args: string[]): WgetOpts {
  const o: WgetOpts = { output: null, quiet: false, noVerbose: false, continue: false, prefix: null, serverResponse: false, spider: false, userAgent: null, headers: [], postData: null, method: null, tries: 20, timeout: 10, limitRate: null, progress: null, urls: [] };
  const withArg = new Set(['O', 'P', 'U', 't', 'T', 'o', 'a', 'i', 'e', 'w', 'l', 'A', 'R', 'D', 'B', 'Q']);
  const long: Record<string, [string, boolean]> = {
    'output-document': ['O', true], quiet: ['q', false], 'no-verbose': ['nv', false], verbose: ['v', false], continue: ['c', false], 'directory-prefix': ['P', true],
    'server-response': ['S', false], spider: ['spider', false], 'user-agent': ['U', true], header: ['header', true], 'post-data': ['post-data', true],
    method: ['method', true], 'body-data': ['body-data', true], tries: ['t', true], timeout: ['T', true], 'limit-rate': ['limit-rate', true],
    progress: ['progress', true], 'show-progress': ['show-progress', false], 'no-check-certificate': ['ncc', false], 'output-file': ['o', true],
    'append-output': ['a', true], 'input-file': ['i', true], timestamping: ['N', false], 'no-clobber': ['nc', false], 'content-disposition': ['cd', false],
    'inet4-only': ['4', false], 'inet6-only': ['6', false], recursive: ['r', false], 'no-parent': ['np', false], level: ['l', true], 'wait': ['w', true],
    'max-redirect': ['mr', true], 'user': ['user', true], 'password': ['password', true], 'ask-password': ['ap', false],
  };
  const apply = (k: string, v: string | null) => {
    switch (k) {
      case 'O': o.output = v; break;
      case 'q': o.quiet = true; break;
      case 'nv': o.noVerbose = true; break;
      case 'v': o.quiet = false; o.noVerbose = false; break;
      case 'c': o.continue = true; break;
      case 'P': o.prefix = v; break;
      case 'S': o.serverResponse = true; break;
      case 'spider': o.spider = true; break;
      case 'U': o.userAgent = v; break;
      case 'header': o.headers.push(v!); break;
      case 'post-data': o.postData = v; o.method = o.method ?? 'POST'; break;
      case 'body-data': o.postData = v; break;
      case 'method': o.method = (v ?? 'GET').toUpperCase(); break;
      case 't': o.tries = Number(v); break;
      case 'T': o.timeout = Number(v); break;
      case 'limit-rate': {
        const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(v ?? '');
        if (m) o.limitRate = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1024 : m[2].toLowerCase() === 'm' ? 1048576 : 1);
        break;
      }
      case 'progress': o.progress = (v ?? '').startsWith('dot') ? 'dot' : 'bar'; break;
      default: break;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      o.urls.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let def = long[name];
      if (!def) {
        const ms = Object.keys(long).filter((k) => k.startsWith(name));
        if (ms.length === 1) def = long[ms[0]];
        else if (ms.length > 1) throw new WgetUsage(`option '${a}' is ambiguous; possibilities:${ms.map((m) => ` '--${m}'`).join('')}`);
        else throw new WgetUsage(`unrecognized option '${a}'`);
      }
      if (def[1]) {
        const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
        if (v === undefined) throw new WgetUsage(`option '${a}' requires an argument`);
        apply(def[0], v);
      } else apply(def[0], null);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (a === '-nv') {
        apply('nv', null);
        continue;
      }
      if (a === '-nc') continue;
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withArg.has(c)) {
          const rest = a.slice(j + 1);
          const v = rest !== '' ? rest : args[++i];
          if (v === undefined) throw new WgetUsage(`option requires an argument -- '${c}'`);
          apply(c, v);
          break;
        }
        if (!'qvcSNrkK46bmpxEnhH'.includes(c)) throw new WgetUsage(`invalid option -- '${c}'`);
        apply(c, null);
      }
      continue;
    }
    o.urls.push(a);
  }
  return o;
}

/** Pick the local file name like wget: index.html for "/", name.1 if taken. */
function wgetFileName(ctx: CommandContext, u: ParsedUrl, prefix: string | null, unique: boolean): string {
  let name = basename(decodePath(u.path));
  if (!name || u.path.endsWith('/')) name = 'index.html';
  if (u.rawQuery) name += '?' + u.rawQuery;
  let path = prefix ? `${prefix.replace(/\/+$/, '')}/${name}` : name;
  if (unique && ctx.fs.tryStat(path, false)) {
    for (let n = 1; ; n++) {
      const cand = `${path}.${n}`;
      if (!ctx.fs.tryStat(cand, false)) {
        path = cand;
        break;
      }
    }
  }
  return path;
}

async function wgetMain(ctx: CommandContext): Promise<number> {
  let o: WgetOpts;
  try {
    o = wgetParse(ctx.args);
  } catch (e) {
    if (e instanceof WgetUsage) {
      await ctx.err(`wget: ${e.message}\nUsage: wget [OPTION]... [URL]...\n\nTry \`wget --help' for more options.\n`);
      return 2;
    }
    throw e;
  }
  if (o.urls.length === 0) {
    await ctx.err("wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options.\n");
    return 1;
  }
  const log = (s: string) => (o.quiet || o.noVerbose ? Promise.resolve() : ctx.err(s));
  const ttyBar = (o.progress ?? (ctx.stderr.isTTY ? 'bar' : 'dot')) === 'bar' && ctx.stderr.isTTY;
  let status = 0;
  for (const raw of o.urls) {
    await ctx.checkpoint();
    let rawUrl = raw;
    let redirects = 0;
    let reused = false;
    for (;;) {
      const parsed = parseUrl(rawUrl);
      if (!parsed.ok) {
        const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rawUrl)?.[1];
        if (parsed.code === 1 && scheme) await ctx.err(`${rawUrl}: Unsupported scheme ‘${scheme}’.\n`);
        else await ctx.err(`${rawUrl}: Invalid URL ${rawUrl}: ${parsed.message.replace(/^URL rejected: /, '')}\n`);
        status = 1;
        break;
      }
      const u = parsed.url;
      const now = ctx.system.now();
      await log(`--${localDateTime(now)}--  ${urlString(u)}\n`);
      const ip = resolveName(ctx.system, u.host);
      const literal = isIPv4(u.host);
      if (!reused) {
        if (!literal) {
          if (!ip) {
            await log(`Resolving ${u.host} (${u.host})... failed: Name or service not known.\n`);
            await ctx.err(`wget: unable to resolve host address ‘${u.host}’\n`);
            status = 4;
            break;
          }
          await log(`Resolving ${u.host} (${u.host})... ${ip}\n`);
        }
        await log(literal ? `Connecting to ${u.host}:${u.port}... ` : `Connecting to ${u.host} (${u.host})|${ip}|:${u.port}... `);
      } else {
        await log(`Reusing existing connection to ${u.host}:${u.port}.\n`);
      }
      const conn = await connectHttp(ctx, u, Math.round(o.timeout * 1000));
      if ('reason' in conn) {
        if (conn.reason === 'refused') await log('failed: Connection refused.\n');
        else if (conn.reason === 'noroute') await log('failed: No route to host.\n');
        else await log('failed: Connection timed out.\n');
        if (o.noVerbose && !o.quiet) await ctx.err(`failed: ${conn.reason === 'refused' ? 'Connection refused' : conn.reason === 'noroute' ? 'No route to host' : 'Connection timed out'}.\n`);
        status = 4;
        break;
      }
      if (!reused) await log('connected.\n');
      const headers: Record<string, string> = { host: u.host + (u.explicitPort ? ':' + u.port : ''), 'user-agent': o.userAgent ?? WGET_UA, accept: '*/*', 'accept-encoding': 'identity', connection: 'Keep-Alive' };
      for (const h of o.headers) {
        const ci = h.indexOf(':');
        if (ci > 0) headers[h.slice(0, ci).trim().toLowerCase()] = h.slice(ci + 1).trim();
      }
      const method = o.spider ? 'HEAD' : o.method ?? 'GET';
      const body = o.postData ?? '';
      if (body) {
        headers['content-type'] = headers['content-type'] ?? 'application/x-www-form-urlencoded';
        headers['content-length'] = String(body.length);
      }
      const res = await conn.handler(buildRequest(u, method, headers, body), { system: ctx.system, server: conn.server });
      await ctx.sleep(Math.round(conn.rtt));
      await log(`HTTP request sent, awaiting response... ${o.serverResponse ? '\n' : ''}`);
      if (o.serverResponse && !o.quiet) {
        let sr = `  HTTP/1.1 ${res.status} ${statusText(res.status)}\n`;
        for (const [k, v] of res.headers) sr += `  ${k}: ${v}\n`;
        await ctx.err(sr);
      }
      if (!o.serverResponse) await log(`${res.status} ${statusText(res.status)}\n`);
      const location = header(res, 'location');
      if (res.status >= 300 && res.status < 400 && location) {
        await log(`Location: ${location} [following]\n`);
        if (++redirects > 20) {
          await ctx.err('20 redirections exceeded.\n');
          status = 8;
          break;
        }
        const next = resolveRelative(u, location);
        const nu = parseUrl(next);
        reused = nu.ok && nu.url.host === u.host && nu.url.port === u.port;
        rawUrl = next;
        continue;
      }
      if (res.status >= 400) {
        await log(`${localDateTime(ctx.system.now())} ERROR ${res.status}: ${statusText(res.status)}.\n\n`);
        if (o.noVerbose && !o.quiet) await ctx.err(`${urlString(u)}:\n${localDateTime(ctx.system.now())} ERROR ${res.status}: ${statusText(res.status)}.\n`);
        status = 8;
        break;
      }
      const data = asBinary(res.body);
      const lenH = header(res, 'content-length');
      const total = lenH !== undefined ? Number(lenH) : null;
      const type = (header(res, 'content-type') ?? 'application/octet-stream').split(';')[0];
      const lenText = total === null ? 'unspecified' : total >= 1024 ? `${total} (${wgetHuman(total, 10, 1)})` : String(total);
      if (o.spider) {
        await log(`Length: ${lenText} [${type}]\nRemote file exists.\n\n`);
        break;
      }
      const toStdout = o.output === '-';
      const fileName = toStdout ? '-' : o.output ?? wgetFileName(ctx, u, o.prefix, !o.continue);
      const size = dataSize(data);
      if (o.continue && !toStdout) {
        const existing = ctx.fs.tryStat(fileName);
        if (existing && existing.type === 'file' && dataSize(existing.data) >= size) {
          await log(`Length: ${lenText} [${type}]\n\n    The file is already fully retrieved; nothing to do.\n\n`);
          break;
        }
      }
      await log(`Length: ${lenText} [${type}]\nSaving to: ‘${toStdout ? 'STDOUT' : fileName}’\n\n`);
      if (!toStdout && o.prefix) {
        let cur = o.prefix.startsWith('/') ? '' : '.';
        for (const part of o.prefix.split('/').filter(Boolean)) {
          cur = cur === '' ? '/' + part : cur + '/' + part;
          if (!ctx.fs.tryStat(cur)) {
            try {
              ctx.fs.mkdir(cur);
            } catch {
              // reported when saving
            }
          }
        }
      }
      // Transfer.
      const bandwidth = o.limitRate ? Math.min(o.limitRate, conn.bandwidth) : conn.bandwidth;
      const seconds = size / bandwidth;
      const elapsed = seconds + 0.00002 * (1 + (size % 7));
      const rate = size / Math.max(elapsed, 0.000001);
      const quietProgress = o.quiet || o.noVerbose;
      const width = Math.max(40, (ctx.tty?.cols ?? 80) - 1);
      const label = toStdout ? '-' : basename(fileName);
      if (!quietProgress) {
        if (ttyBar) {
          await ctx.err('\r' + wgetBar(label, width, total, 0, null, false, 0, 0));
          const steps = Math.floor(seconds * 5);
          for (let k = 1; k <= steps; k++) {
            await ctx.sleep(200);
            const got = Math.min(size, Math.round(bandwidth * k * 0.2));
            await ctx.err('\r' + wgetBar(label, width, total, got, bandwidth, false, k * 0.2, k));
          }
          await ctx.sleep(Math.round((seconds - steps * 0.2) * 1000));
          await ctx.err('\r' + wgetBar(label, width, total, size, elapsed < 0.1 ? null : rate, true, elapsed, steps + 1) + '\n');
        } else {
          // dot progress: one dot per KiB, 50 per row
          let out = '';
          const rows = Math.floor(size / (50 * 1024));
          for (let r = 0; r < rows; r++) {
            await ctx.sleep(Math.round(((50 * 1024) / bandwidth) * 1000));
            out = `${r === 0 ? '' : '\n'}${String(r * 50).padStart(6)}K .......... .......... .......... .......... ..........`;
            const shown = (r + 1) * 50 * 1024;
            const eta = Math.max(0, Math.round((size - shown) / bandwidth));
            const rowRate = wgetRate(bandwidth, true).replace(/B\/s$/, '').trimEnd();
            out += `${total ? String(Math.floor((100 * shown) / total)).padStart(3) + '%' : ''} ${rowRate.padStart(5)} ${eta}s`;
            await ctx.err(out);
          }
          const rem = size - rows * 50 * 1024;
          const dots = Math.floor(rem / 1024);
          let last = `${rows === 0 ? '' : '\n'}${String(rows * 50).padStart(6)}K`;
          for (let i = 0; i < 50; i++) {
            if (i % 10 === 0) last += ' ';
            last += i < dots ? '.' : ' ';
          }
          const lastRate = wgetRate(rem > 0 ? rate : rate, true).replace(/B\/s$/, '').trimEnd();
          last += `${total ? '100%' : ''} ${lastRate.padStart(5)}=${elapsed >= 10 ? Math.round(elapsed) + 's' : wgetDecimal(elapsed) + 's'}\n`;
          await ctx.sleep(Math.round((rem / bandwidth) * 1000));
          await ctx.err(last);
        }
      } else {
        await ctx.sleep(Math.round(seconds * 1000));
      }
      // Save.
      if (toStdout) {
        await writeDataToStdout(ctx, data);
      } else {
        try {
          ctx.fs.writeFile(fileName, typeof data === 'string' ? data : { ...data });
          const lm = header(res, 'last-modified');
          const t = lm ? Date.parse(lm) : NaN;
          if (!Number.isNaN(t)) ctx.fs.setTimes(fileName, ctx.system.now(), t);
        } catch (e) {
          await ctx.err(`${fileName}: ${errText(e)}\n\nCannot write to ‘${fileName}’ (${errText(e)}).\n`);
          status = 3;
          break;
        }
      }
      const savedSize = total !== null ? `[${size}/${total}]` : `[${size}]`;
      if (!o.quiet && o.noVerbose) {
        await ctx.err(`${localDateTime(ctx.system.now())} URL:${urlString(u)} ${savedSize} -> "${toStdout ? '-' : fileName}" [1]\n`);
      }
      await log(`\n${localDateTime(ctx.system.now())} (${wgetRate(rate, false)}) - ${toStdout ? '‘-’ written to stdout' : `‘${fileName}’ saved`} ${savedSize}\n\n`);
      break;
    }
  }
  return status;
}

const WGET_DEF: CommandDef = {
  name: 'wget',
  pkg: 'wget',
  size: 543360,
  gnu: false,
  doc: {
    category: 'network',
    summary: 'The non-interactive network downloader.',
    synopsis: ['wget [option]... [URL]...'],
    description:
      'GNU Wget is a free utility for non-interactive download of files from the Web. Give it a URL and it saves the file in the current directory, showing a progress bar while it downloads. When the URL ends in "/" the file is saved as index.html, and if a file with the same name already exists wget saves it as name.1, name.2 and so on instead of overwriting it.\n\n' +
      'Unlike curl, wget saves to a file by default. Use -O to choose the file name (-O - writes to standard output), -q to work quietly and -c to continue a partial download.',
    options: [
      { flags: '-O,  --output-document=FILE', desc: 'write documents to FILE' },
      { flags: '-P,  --directory-prefix=PREFIX', desc: 'save files to PREFIX/..' },
      { flags: '-q,  --quiet', desc: 'quiet (no output)' },
      { flags: '-nv, --no-verbose', desc: 'turn off verboseness, without being quiet' },
      { flags: '-c,  --continue', desc: 'resume getting a partially-downloaded file' },
      { flags: '-S,  --server-response', desc: 'print server response' },
      { flags: '--spider', desc: "don't download anything, just check that the file exists" },
      { flags: '-U,  --user-agent=AGENT', desc: 'identify as AGENT instead of Wget/VERSION' },
      { flags: '--header=STRING', desc: 'insert STRING among the headers' },
      { flags: '--post-data=STRING', desc: 'use the POST method; send STRING as the data' },
      { flags: '--limit-rate=RATE', desc: 'limit download rate to RATE (e.g. 200k)' },
      { flags: '-T,  --timeout=SECONDS', desc: 'set all timeout values to SECONDS' },
    ],
    examples: [
      { cmd: 'wget https://files.example.com/project.tar.gz', desc: 'Download a file into the current directory.' },
      { cmd: 'wget -O page.html https://example.com', desc: 'Choose the name of the saved file.' },
      { cmd: 'wget -q -O - https://api.example.com/time', desc: 'Print a download instead of saving it.' },
      { cmd: 'wget -P Downloads https://files.example.com/data.csv', desc: 'Save into another directory.' },
    ],
    seeAlso: ['curl'],
    tip: 'wget never overwrites an existing file unless you ask: a second download of hello.txt is saved as hello.txt.1.',
  },
  run: async (ctx) => {
    if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
      await ctx.out(gnuHelp(WGET_DEF));
      return 0;
    }
    if (ctx.args.includes('--version') || ctx.args.includes('-V')) {
      await ctx.out('GNU Wget 1.21.4 built on linux-gnu.\n\n-cares +digest -gpgme +https +ipv6 +iri +large-file -metalink +nls \n+ntlm +opie +psl +ssl/openssl \n\nCopyright (C) 2015 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later\n<http://www.gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nOriginally written by Hrvoje Niksic <hniksic@xemacs.org>.\nPlease send bug reports and questions to <bug-wget@gnu.org>.\n');
      return 0;
    }
    return wgetMain(ctx);
  },
};

defineCommand(WGET_DEF);

// ===========================================================================
// ping

const PING_USAGE = `
Usage
  ping [options] <destination>

Options:
  <destination>      DNS name or IP address
  -a                 use audible ping
  -A                 use adaptive ping
  -B                 sticky source address
  -c <count>         stop after <count> replies
  -C                 call connect() syscall on socket creation
  -D                 print timestamps
  -d                 use SO_DEBUG socket option
  -e <identifier>    define identifier for ping session, default is random for
                     SOCK_RAW and kernel defined for SOCK_DGRAM
                     Imply using SOCK_RAW (for IPv4 only for identifier 0)
  -f                 flood ping
  -h                 print help and exit
  -H                 force reverse DNS name resolution (useful for numeric
                     destinations or for -f), override -n
  -I <interface>     either interface name or address
  -i <interval>      seconds between sending each packet
  -L                 suppress loopback of multicast packets
  -l <preload>       send <preload> number of packages while waiting replies
  -m <mark>          tag the packets going out
  -M <pmtud opt>     define path MTU discovery, can be one of <do|dont|want|probe>
  -n                 no reverse DNS name resolution, override -H
  -O                 report outstanding replies
  -p <pattern>       contents of padding byte
  -q                 quiet output
  -Q <tclass>        use quality of service <tclass> bits
  -s <size>          use <size> as number of data bytes to be sent
  -S <size>          use <size> as SO_SNDBUF socket option value
  -t <ttl>           define time to live
  -U                 print user-to-user latency
  -v                 verbose output
  -V                 print version and exit
  -w <deadline>      reply wait <deadline> in seconds
  -W <timeout>       time to wait for response

IPv4 options:
  -4                 use IPv4
  -b                 allow pinging broadcast
  -R                 record route
  -T <timestamp>     define timestamp, can be one of <tsonly|tsandaddr|tsprespec>

IPv6 options:
  -6                 use IPv6
  -F <flowlabel>     define flow label, default is random
  -N <nodeinfo opt>  use IPv6 node info query, try <help> as argument

For more details see ping(8).
`;

function pingMs(ms: number): string {
  const us = Math.round(ms * 1000);
  if (us >= 100000 - 50) return String(Math.floor((us + 500) / 1000));
  if (us >= 10000 - 5) return `${Math.floor((us + 50) / 1000)}.${Math.floor(((us + 50) % 1000) / 100)}`;
  if (us >= 1000) return `${Math.floor((us + 5) / 1000)}.${pad2(Math.floor(((us + 5) % 1000) / 10))}`;
  return `${Math.floor(us / 1000)}.${String(us % 1000).padStart(3, '0')}`;
}

function fmt3(ms: number): string {
  return ms.toFixed(3);
}

function fmtG(n: number): string {
  return String(Number(n.toPrecision(6)));
}

const PING_DEF: CommandDef = {
  name: 'ping',
  pkg: 'iputils-ping',
  dir: '/usr/bin',
  size: 89768,
  gnu: false,
  doc: {
    category: 'network',
    section: 8,
    summary: 'send ICMP ECHO_REQUEST to network hosts',
    synopsis: ['ping [-aAbBdCDfhHLnOqrRUvV46] [-c count] [-i interval] [-s packetsize] [-t ttl] [-w deadline] [-W timeout] destination'],
    description:
      'ping sends small "echo request" packets to a computer on the network and waits for it to answer. Every answer is printed with the time it took (the round-trip time, in milliseconds), which tells you whether the other computer is reachable and how fast the connection is.\n\n' +
      'ping keeps going until you press Ctrl+C, then prints a summary: how many packets were sent and received, the percentage lost, and the minimum, average and maximum round-trip times. Use -c to send a fixed number of packets instead.',
    options: [
      { flags: '-c count', desc: 'Stop after sending count ECHO_REQUEST packets.' },
      { flags: '-i interval', desc: 'Wait interval seconds between sending each packet (default 1).' },
      { flags: '-q', desc: 'Quiet output: only the summary lines are displayed.' },
      { flags: '-n', desc: 'Numeric output only: do not look up names for addresses.' },
      { flags: '-s packetsize', desc: 'Number of data bytes to send (default 56, which makes 64 ICMP bytes).' },
      { flags: '-t ttl', desc: 'Set the IP Time to Live.' },
      { flags: '-w deadline', desc: 'Stop after deadline seconds, whatever happens.' },
      { flags: '-W timeout', desc: 'Time to wait for a response, in seconds.' },
      { flags: '-D', desc: 'Print a timestamp before each line.' },
      { flags: '-4', desc: 'Use IPv4 only.' },
    ],
    examples: [
      { cmd: 'ping example.com', desc: 'Check that a host answers; press Ctrl+C to stop.' },
      { cmd: 'ping -c 4 8.8.8.8', desc: 'Send exactly four packets, then show the summary.' },
      { cmd: 'ping -c 2 localhost', desc: 'Talk to your own computer.' },
    ],
    seeAlso: ['ip', 'ss', 'curl'],
    tip: 'ping runs forever until you press Ctrl+C. If you want it to stop by itself, use -c, e.g. ping -c 3 example.com.',
  },
  run: async (ctx) => pingMain(ctx),
};

async function pingMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  let count = Infinity;
  let interval = 1;
  let quiet = false;
  let numeric = false;
  let size = 56;
  let ttlOverride: number | null = null;
  let deadline: number | null = null;
  let timeout = 10;
  let timestamps = false;
  let audible = false;
  let outstanding = false;
  let v6 = false;
  let dest: string | null = null;
  const withArg = new Set(['c', 'i', 's', 't', 'w', 'W', 'I', 'l', 'm', 'M', 'p', 'Q', 'S', 'e', 'F', 'T', 'N']);
  const numArg = (v: string, min: number, max: number, float = false): number | null => {
    const ok = float ? /^\d+(\.\d+)?$/.test(v) : /^\d+$/.test(v);
    if (!ok) return null;
    const n = Number(v);
    if (n < min || n > max) return null;
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help') {
      await ctx.out(PING_USAGE.replace(/^\n/, ''));
      return 0;
    }
    if (a.startsWith('-') && a.length > 1 && dest === null) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withArg.has(c)) {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) {
            await ctx.err(`ping: option requires an argument -- '${c}'\n${PING_USAGE}`);
            return 2;
          }
          switch (c) {
            case 'c': {
              const n = numArg(v, 1, Number.MAX_SAFE_INTEGER);
              if (n === null) {
                await ctx.err(/^\d+$/.test(v) ? `ping: invalid argument: '${v}': out of range: 1 <= value <= 9223372036854775807\n` : `ping: invalid argument: '${v}'\n`);
                return 1;
              }
              count = n;
              break;
            }
            case 'i': {
              const n = numArg(v, 0, 2147483, true);
              if (n === null) {
                await ctx.err(`ping: bad timing interval: ${v}\n`);
                return 1;
              }
              if (n < 0.002 && ctx.creds.uid !== 0) {
                await ctx.err('ping: cannot flood, minimal interval for user must be >= 2 ms, use -i 0.002 (or higher)\n');
                return 1;
              }
              interval = n;
              break;
            }
            case 's': {
              const n = numArg(v, 0, 65507);
              if (n === null) {
                await ctx.err(`ping: invalid argument: '${v}'\n`);
                return 1;
              }
              size = n;
              break;
            }
            case 't': {
              const n = numArg(v, 0, 255);
              if (n === null) {
                await ctx.err(`ping: invalid argument: '${v}': out of range: 0 <= value <= 255\n`);
                return 1;
              }
              ttlOverride = n;
              break;
            }
            case 'w': {
              const n = numArg(v, 0, 2147483, true);
              if (n === null) {
                await ctx.err(`ping: invalid argument: '${v}'\n`);
                return 1;
              }
              deadline = n;
              break;
            }
            case 'W': {
              const n = numArg(v, 0, 2147483, true);
              if (n === null) {
                await ctx.err(`ping: bad linger time: ${v}\n`);
                return 1;
              }
              timeout = n;
              break;
            }
            default:
              break;
          }
          break;
        }
        switch (c) {
          case 'q': quiet = true; break;
          case 'n': numeric = true; break;
          case 'D': timestamps = true; break;
          case 'a': audible = true; break;
          case 'O': outstanding = true; break;
          case '4': v6 = false; break;
          case '6': v6 = true; break;
          case 'h':
            await ctx.out(PING_USAGE.replace(/^\n/, ''));
            return 2;
          case 'V':
            await ctx.out('ping from iputils 20240117\nlibcap: yes, IDN: yes, NLS: no, error.h: yes, getrandom(): yes, __fpending(): yes\n');
            return 0;
          case 'f':
            if (ctx.creds.uid !== 0) {
              await ctx.err('ping: cannot flood, minimal interval for user must be >= 2 ms, use -i 0.002 (or higher)\n');
              return 1;
            }
            interval = 0.01;
            break;
          case 'A': case 'b': case 'B': case 'C': case 'd': case 'H': case 'L': case 'r': case 'R': case 'U': case 'v':
            break;
          default:
            await ctx.err(`ping: invalid option -- '${c}'\n${PING_USAGE}`);
            return 2;
        }
      }
      continue;
    }
    if (dest === null) dest = a;
  }
  if (dest === null) {
    await ctx.err('ping: usage error: Destination address required\n');
    return 1;
  }
  const ip = resolveName(ctx.system, dest);
  if (!ip) {
    await ctx.err(`ping: ${dest}: Name or service not known\n`);
    return 2;
  }
  if (v6) {
    await ctx.err(isIPv4(dest) ? `ping: ${dest}: Address family for hostname not supported\n` : 'ping: connect: Network is unreachable\n');
    return 2;
  }
  const target = targetFor(ctx.system, ip);
  const literal = isIPv4(dest);
  const who = (() => {
    if (literal || numeric) return ip;
    const r = reverseName(ctx.system, ip);
    return r ? `${r} (${ip})` : ip;
  })();
  let rtt = 0.04;
  let ttl = 64;
  let replies = true;
  let unreachable = false;
  if (target.kind === 'host') {
    rtt = target.host.rtt;
    ttl = target.host.ttl;
    replies = !target.host.noPing;
  } else if (target.kind === 'lan-missing') {
    replies = false;
    unreachable = true;
  } else if (target.kind === 'nothing') {
    replies = false;
  }
  if (ttlOverride !== null && target.kind === 'host' && ttlOverride < 64 - ttl + 1) {
    replies = false;
  }
  await ctx.out(`PING ${dest} (${ip}) ${size}(${size + 28}) bytes of data.\n`);
  let interrupted = false;
  const off = ctx.onSignal('SIGINT', () => {
    interrupted = true;
  });
  const times: number[] = [];
  let sent = 0;
  let errors = 0;
  const start = ctx.system.now();
  let elapsed = 0;
  const intervalMs = Math.round(interval * 1000);
  try {
    while (!interrupted && sent < count) {
      if (deadline !== null && elapsed >= deadline * 1000) break;
      sent++;
      const seq = sent;
      if (replies) {
        const jitter = 0.86 + 0.32 * hashUnit(`${ip}:${seq}`);
        const t = Math.max(0.011, rtt * jitter + (size > 56 ? size / 125000 : 0));
        await napUntil(ctx, Math.max(0, Math.round(t)), () => interrupted);
        if (interrupted && t >= 1) {
          sent--;
          break;
        }
        times.push(t);
        if (!quiet) {
          const stamp = timestamps ? `[${((start + elapsed) / 1000).toFixed(6)}] ` : '';
          await ctx.out(`${audible ? '\x07' : ''}${stamp}${size + 8} bytes from ${who}: icmp_seq=${seq} ttl=${ttl}${size >= 16 ? ` time=${pingMs(t)} ms` : ''}\n`);
        }
      } else if (unreachable && seq > 3) {
        errors++;
        if (!quiet) await ctx.out(`From ${profileOf(ctx.system).ip} icmp_seq=${seq - 3} Destination Host Unreachable\n`);
      } else if (outstanding && seq > 1 && !quiet) {
        await ctx.out(`no answer yet for icmp_seq=${seq - 1}\n`);
      }
      if (sent >= count) break;
      const wait = intervalMs - (replies ? Math.round(times[times.length - 1] ?? 0) : 0);
      await napUntil(ctx, Math.max(0, wait), () => interrupted);
      elapsed += intervalMs;
    }
    if (!replies && !interrupted && sent >= count) {
      const linger = Math.min(timeout, deadline ?? timeout) * 1000;
      await napUntil(ctx, Math.round(linger), () => interrupted);
    }
  } finally {
    off();
  }
  const received = times.length;
  const totalMs = sent <= 1 ? (replies ? 0 : 0) : (sent - 1) * intervalMs + 1 + Math.floor(hashUnit(`${ip}:t`) * 3);
  const loss = sent === 0 ? 0 : ((sent - received) * 100) / sent;
  let out = `\n--- ${dest} ping statistics ---\n`;
  out += `${sent} packets transmitted, ${received} received${errors ? `, +${errors} errors` : ''}, ${fmtG(loss)}% packet loss, time ${totalMs}ms\n`;
  if (received > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / received;
    const mdev = Math.sqrt(Math.max(0, times.reduce((a, b) => a + b * b, 0) / received - avg * avg));
    out += `rtt min/avg/max/mdev = ${fmt3(min)}/${fmt3(avg)}/${fmt3(max)}/${fmt3(mdev)} ms\n`;
  } else {
    out += '\n';
  }
  await ctx.out(out);
  return received > 0 ? 0 : 1;
}

defineCommand(PING_DEF);

// ===========================================================================
// SSH: host keys, known_hosts, authentication and remote sessions

interface HostKey {
  type: string;
  blob: string;
  fingerprint: string;
}

function hostKeyFor(identity: string): HostKey {
  const keyHex = sha256('ssh-host-key:' + identity);
  const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAI' + b64FromHex(keyHex).replace(/[+/]/g, (c) => (c === '+' ? 'K' : 'q')).slice(0, 43);
  const fingerprint = 'SHA256:' + b64FromHex(sha256(blob));
  return { type: 'ssh-ed25519', blob, fingerprint };
}

interface KnownHostsEntry {
  line: number;
  names: string[] | null;
  hashed: { salt: string; hash: string } | null;
  type: string;
  blob: string;
}

function hashHostName(salt: string, name: string): string {
  return b64FromHex(sha1(`${salt}|${name}`)) + '=';
}

function parseKnownHosts(text: string): KnownHostsEntry[] {
  const out: KnownHostsEntry[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    if (parts.length < 3) return;
    const [hosts, type, blob] = parts;
    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|');
      out.push({ line: i + 1, names: null, hashed: { salt, hash }, type, blob });
    } else {
      out.push({ line: i + 1, names: hosts.toLowerCase().split(','), hashed: null, type, blob });
    }
  });
  return out;
}

function entryMatches(e: KnownHostsEntry, name: string): boolean {
  if (e.names) return e.names.includes(name);
  if (e.hashed) return hashHostName(e.hashed.salt, name) === e.hashed.hash;
  return false;
}

interface SshTarget {
  /** Name as typed (lower case), used in messages and known_hosts. */
  label: string;
  ip: string;
  port: number;
  remote: System;
  /** Key identity: same computer, same key. */
  identity: string;
  hostKey: HostKey;
  /** For remote computers: the registry entry. */
  host?: SimHost;
}

type SshConnect = { ok: true; target: SshTarget } | { ok: false; message: string };

async function sshConnect(ctx: CommandContext, name: string, port: number, connectTimeout: number): Promise<SshConnect> {
  const label = name.toLowerCase();
  const ip = resolveName(ctx.system, label);
  if (!ip) return { ok: false, message: `ssh: Could not resolve hostname ${label}: Name or service not known` };
  const t = targetFor(ctx.system, ip);
  if (t.kind === 'local') {
    if (port !== 22 || !profileOf(ctx.system).services.includes('ssh')) return { ok: false, message: `ssh: connect to host ${label} port ${port}: Connection refused` };
    const identity = 'local:' + ctx.system.hostname;
    return { ok: true, target: { label, ip, port, remote: ctx.system, identity, hostKey: hostKeyFor(identity) } };
  }
  if (t.kind === 'host') {
    await ctx.sleep(Math.round(t.host.rtt * 2));
    if (t.host.ssh && port === 22) {
      const remote = await remoteSystem(ctx.system, t.host.names[0]);
      if (remote) {
        const identity = 'remote:' + t.host.ssh.hostname;
        return { ok: true, target: { label, ip, port, remote, identity, hostKey: hostKeyFor(identity), host: t.host } };
      }
    }
    if (t.host.firewalled) {
      await ctx.sleep(connectTimeout * 1000);
      return { ok: false, message: `ssh: connect to host ${label} port ${port}: Connection timed out` };
    }
    return { ok: false, message: `ssh: connect to host ${label} port ${port}: Connection refused` };
  }
  if (t.kind === 'lan-missing') {
    await ctx.sleep(3000);
    return { ok: false, message: `ssh: connect to host ${label} port ${port}: No route to host` };
  }
  await ctx.sleep(connectTimeout * 1000);
  return { ok: false, message: `ssh: connect to host ${label} port ${port}: Connection timed out` };
}

function localHome(ctx: CommandContext): string {
  return ctx.env.get('HOME') ?? ctx.system.userByUid(ctx.creds.uid)?.home ?? '/';
}

/** Check (and maybe record) the server's host key. Returns false when the connection must stop. */
async function sshVerifyHostKey(ctx: CommandContext, t: SshTarget, strict: string, batch: boolean, quiet: boolean, knownFile: string | null): Promise<boolean> {
  const file = knownFile ?? `${localHome(ctx)}/.ssh/known_hosts`;
  const key = t.port === 22 ? t.label : `[${t.label}]:${t.port}`;
  let text = '';
  try {
    text = file === '/dev/null' ? '' : ctx.fs.readFile(file);
  } catch {
    text = '';
  }
  const entries = parseKnownHosts(text);
  const mine = entries.filter((e) => entryMatches(e, key));
  if (mine.length) {
    if (mine.some((e) => e.blob === t.hostKey.blob)) return true;
    const bad = mine[0];
    await ctx.err(
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
        'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n' +
        'Someone could be eavesdropping on you right now (man-in-the-middle attack)!\n' +
        'It is also possible that a host key has just been changed.\n' +
        'The fingerprint for the ED25519 key sent by the remote host is\n' +
        `${t.hostKey.fingerprint}.\n` +
        'Please contact your system administrator.\n' +
        `Add correct host key in ${file.replace(localHome(ctx), '~')} to get rid of this message.\n` +
        `Offending ECDSA key in ${file.replace(localHome(ctx), '~')}:${bad.line}\n` +
        `  remove with:\n  ssh-keygen -f "${file}" -R "${key}"\n` +
        'Host key for ' + key + ' has changed and you have requested strict checking.\nHost key verification failed.\n',
    );
    return false;
  }
  const others = entries.filter((e) => e.blob === t.hostKey.blob);
  const add = async (): Promise<void> => {
    if (file === '/dev/null') {
      if (!quiet) await ctx.err(`Warning: Permanently added '${key}' (ED25519) to the list of known hosts.\n`);
      return;
    }
    const salt = btoa(String.fromCharCode(...Array.from({ length: 20 }, () => Math.floor(ctx.system.random() * 256))));
    const line = `|1|${salt}|${hashHostName(salt, key)} ${t.hostKey.type} ${t.hostKey.blob}\n`;
    try {
      const dir = dirname(file);
      if (!ctx.fs.tryStat(dir)) ctx.fs.mkdir(dir, 0o700);
      const existed = ctx.fs.tryStat(file);
      ctx.fs.writeFile(file, line, { append: true, mode: 0o600 });
      if (!existed) ctx.fs.chmod(file, 0o600);
      if (!quiet) await ctx.err(`Warning: Permanently added '${key}' (ED25519) to the list of known hosts.\n`);
    } catch (e) {
      await ctx.err(`Failed to add the host to the list of known hosts (${file}).\n`);
      void e;
    }
  };
  if (strict === 'no' || strict === 'accept-new' || strict === 'off') {
    await add();
    return true;
  }
  if (strict === 'yes' || batch || !ctx.tty) {
    if (strict === 'yes') await ctx.err(`No ED25519 host key is known for ${key} and you have requested strict checking.\n`);
    await ctx.err('Host key verification failed.\n');
    return false;
  }
  let msg = `The authenticity of host '${key} (${t.ip})' can't be established.\nED25519 key fingerprint is ${t.hostKey.fingerprint}.\n`;
  if (others.length) {
    msg += 'This host key is known by the following other names/addresses:\n';
    for (const o of others) msg += `    ${file.replace(localHome(ctx), '~')}:${o.line}: ${o.names ? o.names.join(',') : '[hashed name]'}\n`;
  } else {
    msg += 'This key is not known by any other names.\n';
  }
  msg += 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';
  await ctx.tty.write(msg);
  for (;;) {
    const ans = await readLineTty(ctx);
    if (ans === null) {
      await ctx.tty.write('\n');
      await ctx.err('Host key verification failed.\n');
      return false;
    }
    const a = ans.trim();
    if (a.toLowerCase() === 'yes' || a === t.hostKey.fingerprint) {
      await add();
      return true;
    }
    if (a.toLowerCase() === 'no') {
      await ctx.err('Host key verification failed.\n');
      return false;
    }
    await ctx.tty.write("Please type 'yes', 'no' or the fingerprint: ");
  }
}

/** Password (or public key) authentication. */
async function sshAuthenticate(ctx: CommandContext, t: SshTarget, user: string, batch: boolean): Promise<boolean> {
  const remoteUser = t.remote.userByName(user);
  // Public keys from ~/.ssh/*.pub listed in the remote's authorized_keys log in without a password.
  if (remoteUser) {
    try {
      const auth = t.remote.fs.readFile(`${remoteUser.home}/.ssh/authorized_keys`, { cwd: '/', creds: ROOT_CREDS });
      const sshDir = `${localHome(ctx)}/.ssh`;
      for (const f of ctx.fs.readdir(sshDir)) {
        if (!f.endsWith('.pub')) continue;
        const pub = ctx.fs.readFile(`${sshDir}/${f}`).trim().split(/\s+/).slice(0, 2).join(' ');
        if (pub && auth.split('\n').some((l) => l.trim().split(/\s+/).slice(0, 2).join(' ') === pub)) return true;
      }
    } catch {
      // no keys
    }
  }
  if (batch || !ctx.tty) {
    await ctx.err(`${user}@${t.label}: Permission denied (publickey,password).\n`);
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const pw = await readPasswordTty(ctx, `${user}@${t.label}'s password: `);
    if (pw === null) break;
    await ctx.sleep(400);
    if (pw.length > 0 && remoteUser && remoteUser.uid !== 0 && remoteUser.shell !== '/usr/sbin/nologin') return true;
    if (attempt < 2) await ctx.err('Permission denied, please try again.\n');
  }
  await ctx.err(`${user}@${t.label}: Permission denied (publickey,password).\n`);
  return false;
}

const lastLogins = new WeakMap<System, Map<string, { time: number; from: string }>>();

/** Standard input as a remote command sees it without a pseudo-terminal: a pipe. */
class PipedInput extends InputStream {
  readonly isTTY = false;
  private readonly inner: InputStream;
  constructor(inner: InputStream) {
    super();
    this.inner = inner;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    return this.inner.read(signal);
  }
}

/** Output of a remote command without a pseudo-terminal. */
class PipedOutput extends OutputStream {
  readonly isTTY = false;
  private readonly inner: OutputStream;
  constructor(inner: OutputStream) {
    super();
    this.inner = inner;
  }
  write(data: string, signal?: AbortSignal): Promise<void> {
    return this.inner.write(data, signal);
  }
}

function motd(remote: System, user: string, fromIp: string): string {
  const now = remote.now();
  const d = new Date(now);
  const prof = profileOf(remote);
  let map = lastLogins.get(remote);
  if (!map) {
    map = new Map();
    lastLogins.set(remote, map);
  }
  const last = map.get(user) ?? { time: now - 26 * 3600 * 1000 - 17 * 60000, from: prof.gateway === GATEWAY_IP ? GATEWAY_IP : '198.51.100.23' };
  map.set(user, { time: now, from: fromIp });
  const ld = new Date(last.time);
  const stamp = `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  const lastStamp = `${DAYS[ld.getDay()]} ${MONTHS[ld.getMonth()]} ${String(ld.getDate()).padStart(2)} ${pad2(ld.getHours())}:${pad2(ld.getMinutes())}:${pad2(ld.getSeconds())} ${ld.getFullYear()}`;
  return (
    'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\n\n' +
    ' * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n\n' +
    ` System information as of ${stamp}\n\n` +
    '  System load:  0.08              Processes:             118\n' +
    '  Usage of /:   31.2% of 24.44GB   Users logged in:       0\n' +
    `  Memory usage: 18%               IPv4 address for ${prof.ifname}: ${prof.ip}\n` +
    '  Swap usage:   0%\n\n' +
    `Last login: ${lastStamp} from ${last.from}\n`
  );
}

function sshEnv(shellVars: Map<string, { value: string; exported: boolean; readonly: boolean; integer: boolean }>, fromIp: string, t: SshTarget, tty: boolean): void {
  const port = 40000 + Math.floor(hashUnit(fromIp + t.label) * 20000);
  shellVars.set('SSH_CLIENT', { value: `${fromIp} ${port} ${t.port}`, exported: true, readonly: false, integer: false });
  shellVars.set('SSH_CONNECTION', { value: `${fromIp} ${port} ${t.ip} ${t.port}`, exported: true, readonly: false, integer: false });
  if (tty) shellVars.set('SSH_TTY', { value: '/dev/pts/1', exported: true, readonly: false, integer: false });
}

async function sshSession(ctx: CommandContext, t: SshTarget, user: string, command: string | null, forceTty: boolean, quiet: boolean): Promise<number> {
  const remote = t.remote;
  const fromIp = t.remote === ctx.system ? '127.0.0.1' : profileOf(ctx.system).ip;
  const { createLoginShell } = await import('../session');
  const conn: Connection = { localIp: fromIp === '127.0.0.1' ? '127.0.0.1' : profileOf(ctx.system).ip, localPort: 40000 + Math.floor(hashUnit(t.label + ctx.proc.pid) * 20000), remoteIp: t.ip, remotePort: t.port, process: 'ssh' };
  const local = connectionsOf(ctx.system);
  const remoteConns = connectionsOf(remote);
  const back: Connection = { localIp: t.ip, localPort: t.port, remoteIp: conn.localIp, remotePort: conn.localPort, process: 'sshd' };
  local.push(conn);
  remoteConns.push(back);
  const cleanup = () => {
    const i = local.indexOf(conn);
    if (i >= 0) local.splice(i, 1);
    const j = remoteConns.indexOf(back);
    if (j >= 0) remoteConns.splice(j, 1);
  };
  try {
    if (command !== null || !ctx.stdin.isTTY || !ctx.tty) {
      if (command === null) {
        if (!quiet) await ctx.err('Pseudo-terminal will not be allocated because stdin is not a terminal.\n');
        command = await ctx.stdin.readAll();
      }
      const shell = createLoginShell(remote, user, { interactive: false });
      sshEnv(shell.state.vars, fromIp, t, forceTty);
      const pty = forceTty && ctx.tty !== null;
      const io = pty
        ? IO.of(ctx.proc.job, ctx.stdin, ctx.stdout, ctx.stderr)
        : IO.of(ctx.proc.job, ctx.stdin.isTTY ? new PipedInput(ctx.stdin) : ctx.stdin, ctx.stdout.isTTY ? new PipedOutput(ctx.stdout) : ctx.stdout, ctx.stderr.isTTY ? new PipedOutput(ctx.stderr) : ctx.stderr);
      const prevTty = remote.tty;
      const prevHooks = remote.hooks;
      if (pty && remote !== ctx.system) {
        remote.tty = ctx.tty;
        remote.hooks = ctx.system.hooks;
      }
      let status: number;
      try {
        status = await shell.runSource(command, io);
      } catch (e) {
        if (e instanceof ExitException) status = e.status;
        else throw e;
      } finally {
        if (pty && remote !== ctx.system) {
          remote.tty = prevTty;
          remote.hooks = prevHooks;
        }
      }
      if (forceTty && !quiet) await ctx.err(`Connection to ${t.label} closed.\n`);
      return status;
    }
    // Interactive login on the same terminal.
    const tty = ctx.tty;
    const { Repl } = await import('../repl');
    const { History } = await import('../history');
    await ctx.out(motd(remote, user, fromIp));
    const shell = createLoginShell(remote, user, { interactive: true });
    shell.state.loginShell = true;
    sshEnv(shell.state.vars, fromIp, t, true);
    const history = new History();
    const home = shell.state.get('HOME') ?? '/';
    try {
      history.load(remote.fs.readFile(`${home}/.bash_history`, { cwd: '/', creds: shell.state.creds }).split('\n').filter(Boolean));
    } catch {
      // no history yet
    }
    const prevTty = remote.tty;
    const prevHooks = remote.hooks;
    remote.tty = tty;
    if (remote !== ctx.system) remote.hooks = ctx.system.hooks;
    const repl = new Repl({ system: remote, tty, shell, history, depth: 1 });
    const prevFg = tty.foreground;
    let status = 0;
    try {
      await repl.source(`${home}/.bashrc`);
      status = await repl.run();
    } finally {
      tty.foreground = prevFg;
      remote.tty = prevTty;
      if (remote !== ctx.system) remote.hooks = prevHooks;
    }
    await ctx.err(`Connection to ${t.label} closed.\n`);
    return status;
  } finally {
    cleanup();
  }
}

const SSH_USAGE =
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n' +
  '           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n' +
  '           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n' +
  '           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n' +
  '           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]\n' +
  '           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n' +
  '           destination [command [argument ...]]\n' +
  '       ssh [-Q query_option]\n';

const SSH_FLAGS = new Set('1246afgknqstvxACGKMNTVXYy'.split(''));
const SSH_ARGS = new Set('bceilmopBDEFIJLOPQRSwW'.split(''));

interface SshArgs {
  dest: string | null;
  command: string[];
  user: string | null;
  port: number;
  opts: Map<string, string>;
  verbose: number;
  quiet: boolean;
  forceTty: boolean;
  noCommand: boolean;
  identity: string | null;
  version: boolean;
}

class SshUsage extends Error {}

function sshParse(args: string[]): SshArgs {
  const r: SshArgs = { dest: null, command: [], user: null, port: 22, opts: new Map(), verbose: 0, quiet: false, forceTty: false, noCommand: false, identity: null, version: false };
  let i = 0;
  const parseOpts = () => {
    while (i < args.length) {
      const a = args[i];
      if (a === '--') {
        i++;
        return true;
      }
      if (!a.startsWith('-') || a === '-') return false;
      i++;
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (SSH_FLAGS.has(c)) {
          if (c === 'v') r.verbose++;
          else if (c === 'q') r.quiet = true;
          else if (c === 't') r.forceTty = true;
          else if (c === 'N') r.noCommand = true;
          else if (c === 'V') r.version = true;
          continue;
        }
        if (SSH_ARGS.has(c)) {
          const v = a.slice(j + 1) || args[i++];
          if (v === undefined) throw new SshUsage(`option requires an argument -- ${c}`);
          if (c === 'l') r.user = v;
          else if (c === 'p') {
            if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new SshUsage(`Bad port '${v}'`);
            r.port = Number(v);
          } else if (c === 'o') {
            const m = /^\s*([A-Za-z]+)\s*[= ]\s*(.*)$/.exec(v);
            if (m) r.opts.set(m[1].toLowerCase(), m[2].trim());
          } else if (c === 'i') r.identity = v;
          break;
        }
        throw new SshUsage(`unknown option -- ${c}`);
      }
    }
    return false;
  };
  let terminated = parseOpts();
  if (i < args.length && r.dest === null) {
    r.dest = args[i++];
    if (!terminated && i < args.length) terminated = parseOpts();
  }
  r.command = args.slice(i);
  return r;
}

const SSH_DEF: CommandDef = {
  name: 'ssh',
  pkg: 'openssh-client',
  size: 846312,
  gnu: false,
  doc: {
    category: 'network',
    summary: 'OpenSSH remote login client',
    synopsis: ['ssh [-p port] [-l login_name] [-o option] destination [command [argument ...]]'],
    description:
      'ssh (Secure SHell) logs you in to another computer over the network and gives you a shell there, as if you were sitting in front of it. Everything you type is encrypted. destination is a host name or address, optionally with a user name in front: ssh learner@webserver. Without a user name, ssh uses your own.\n\n' +
      'The first time you connect to a computer, ssh shows its "fingerprint" and asks whether you trust it. Answer yes and ssh remembers it in ~/.ssh/known_hosts, so it can warn you if the computer ever changes. Then type your password (nothing appears while you type). Type exit, or press Ctrl+D, to log out and come back.\n\n' +
      'If you add a command after the destination, ssh runs just that command on the other computer, prints its output and returns: ssh webserver uptime.\n\n' +
      'In this simulator you can log in to webserver (a separate pretend server; any password works) and to localhost.',
    options: [
      { flags: '-p port', desc: 'Port to connect to on the remote host (default 22).' },
      { flags: '-l login_name', desc: 'The user to log in as on the remote machine.' },
      { flags: '-o option', desc: 'Give a configuration option, e.g. -o StrictHostKeyChecking=accept-new.' },
      { flags: '-i identity_file', desc: 'Selects a file from which the identity (private key) is read.' },
      { flags: '-t', desc: 'Force pseudo-terminal allocation.' },
      { flags: '-q', desc: 'Quiet mode: suppress most warning and diagnostic messages.' },
      { flags: '-v', desc: 'Verbose mode: print debugging messages about its progress.' },
      { flags: '-V', desc: 'Display the version number and exit.' },
    ],
    examples: [
      { cmd: 'ssh webserver', desc: 'Log in to the computer called webserver.' },
      { cmd: 'ssh learner@webserver', desc: 'Log in as a particular user.' },
      { cmd: 'ssh webserver ls /var/www/html', desc: 'Run one command remotely and come back.' },
      { cmd: 'exit', desc: '(On the remote computer) log out again.' },
    ],
    seeAlso: ['scp', 'ping', 'hostname'],
    tip: 'Watch the prompt: after ssh it says learner@webserver, which tells you which computer your commands run on.',
  },
  run: async (ctx) => sshMain(ctx),
};

async function sshMain(ctx: CommandContext): Promise<number> {
  if (ctx.args.includes('--help')) {
    await ctx.out(gnuHelp(SSH_DEF));
    return 0;
  }
  let a: SshArgs;
  try {
    a = sshParse(ctx.args);
  } catch (e) {
    if (e instanceof SshUsage) {
      await ctx.err(`${e.message}\n${SSH_USAGE}`);
      return 255;
    }
    throw e;
  }
  if (a.version) {
    await ctx.err('OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\n');
    return 0;
  }
  if (!a.dest) {
    await ctx.err(SSH_USAGE);
    return 255;
  }
  let dest = a.dest;
  let user = a.user;
  let port = a.port;
  const uri = /^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?\/?$/.exec(dest);
  if (uri) {
    user = user ?? uri[1] ?? null;
    dest = uri[2];
    if (uri[3]) port = Number(uri[3]);
  } else {
    const at = dest.lastIndexOf('@');
    if (at === 0) {
      await ctx.err(SSH_USAGE);
      return 255;
    }
    if (at > 0) {
      user = user ?? dest.slice(0, at);
      dest = dest.slice(at + 1);
    }
  }
  if (a.opts.has('port')) port = Number(a.opts.get('port'));
  if (a.opts.has('user')) user = user ?? a.opts.get('user')!;
  user = user ?? ctx.system.userName(ctx.creds.uid);
  const strict = (a.opts.get('stricthostkeychecking') ?? 'ask').toLowerCase();
  const batch = (a.opts.get('batchmode') ?? 'no').toLowerCase() === 'yes';
  const knownFile = a.opts.get('userknownhostsfile') ?? null;
  const connectTimeout = Number(a.opts.get('connecttimeout') ?? 10) || 10;
  const debug = (s: string) => (a.verbose ? ctx.err(s) : Promise.resolve());
  await debug(`OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\ndebug1: Reading configuration data /etc/ssh/ssh_config\ndebug1: /etc/ssh/ssh_config line 21: Applying options for *\n`);
  if (a.identity && !ctx.fs.tryStat(a.identity)) await ctx.err(`Warning: Identity file ${a.identity} not accessible: No such file or directory.\n`);
  const c = await sshConnect(ctx, dest, port, connectTimeout);
  if (!c.ok) {
    await ctx.err(c.message + '\n');
    return 255;
  }
  const t = c.target;
  await debug(`debug1: Connecting to ${t.label} [${t.ip}] port ${t.port}.\ndebug1: Connection established.\ndebug1: Local version string SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5\ndebug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5\ndebug1: Authenticating to ${t.label}:${t.port} as '${user}'\ndebug1: Server host key: ssh-ed25519 ${t.hostKey.fingerprint}\n`);
  if (!(await sshVerifyHostKey(ctx, t, strict, batch, a.quiet, knownFile))) return 255;
  await debug('debug1: Authentications that can continue: publickey,password\n');
  if (!(await sshAuthenticate(ctx, t, user, batch))) return 255;
  await debug(`debug1: Authentication succeeded (password).\nAuthenticated to ${t.label} ([${t.ip}]:${t.port}) using "password".\n`);
  if (a.noCommand && a.command.length === 0) {
    // -N: keep the connection open until interrupted.
    for (;;) await ctx.sleep(1000);
  }
  return sshSession(ctx, t, user, a.command.length ? a.command.join(' ') : null, a.forceTty, a.quiet);
}

defineCommand(SSH_DEF);

// ===========================================================================
// scp

const SCP_USAGE = 'usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n           [-i identity_file] [-J destination] [-l limit] [-o ssh_option]\n           [-P port] [-S program] [-X sftp_option] source ... target\n';

function scpProgress(name: string, size: number, cols: number): string {
  const fileLen = Math.max(1, cols - 36);
  const shown = name.length > fileLen ? name.slice(0, fileLen) : name.padEnd(fileLen);
  const fmtSize = (b: number) => {
    const units = ' KMGT';
    let i = 0;
    let v = b;
    while (v >= 10000 && i < 4) {
      v = Math.floor((v + 512) / 1024);
      i++;
    }
    return `${String(v).padStart(4)}${units[i]}${i ? 'B' : ' '}`;
  };
  const rate = Math.max(1, size * 7);
  const fmtRate = (b: number) => {
    const units = ' KMGT';
    let v = b * 100;
    let i = 0;
    for (; v >= 100 * 1000 && i < 4; i++) v = Math.floor((v + 512) / 1024);
    if (i === 0) {
      i++;
      v = Math.floor((v + 512) / 1024);
    }
    return `${String(Math.floor((v + 5) / 100)).padStart(3)}.${Math.floor((v + 5) / 10) % 10}${units[i]}B`;
  };
  return `${shown} 100% ${fmtSize(size)} ${fmtRate(rate)}/s   00:00    `;
}

interface ScpSpec {
  remote: boolean;
  user?: string;
  host?: string;
  path: string;
}

function scpSpec(s: string): ScpSpec {
  const m = /^(?:([^@/:]+)@)?([^/:]+):(.*)$/.exec(s);
  if (m && !s.startsWith('/') && !s.startsWith('./')) return { remote: true, user: m[1], host: m[2], path: m[3] };
  return { remote: false, path: s };
}

async function scpMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  let recursive = false;
  let quiet = false;
  let preserve = false;
  let port = 22;
  const opts = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1 && operands.length === 0) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'r') recursive = true;
        else if (c === 'q') quiet = true;
        else if (c === 'p') preserve = true;
        else if ('346ABCORsTv'.includes(c)) continue;
        else if ('cDFiJlPoSX'.includes(c)) {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) {
            await ctx.err(`scp: option requires an argument -- ${c}\n${SCP_USAGE}`);
            return 1;
          }
          if (c === 'P') port = Number(v);
          if (c === 'o') {
            const m = /^\s*([A-Za-z]+)\s*[= ]\s*(.*)$/.exec(v);
            if (m) opts.set(m[1].toLowerCase(), m[2]);
          }
          break;
        } else {
          await ctx.err(`scp: unknown option -- ${c}\n${SCP_USAGE}`);
          return 1;
        }
      }
      continue;
    }
    operands.push(a);
  }
  if (operands.length < 2) {
    await ctx.err(SCP_USAGE);
    return 1;
  }
  const specs = operands.map(scpSpec);
  const dst = specs[specs.length - 1];
  const srcs = specs.slice(0, -1);
  const remoteSpec = dst.remote ? dst : srcs.find((s) => s.remote);
  if (!remoteSpec) {
    // Plain local copy, like cp.
    return ctx.exec(['cp', ...(recursive ? ['-r'] : []), ...(preserve ? ['-p'] : []), ...operands]);
  }
  if (dst.remote && srcs.some((s) => s.remote)) {
    await ctx.err('scp: copying between two remote hosts is not supported here\n');
    return 1;
  }
  const user = remoteSpec.user ?? opts.get('user') ?? ctx.system.userName(ctx.creds.uid);
  const conn = await sshConnect(ctx, remoteSpec.host!, port, 10);
  if (!conn.ok) {
    await ctx.err(conn.message + '\n');
    return 255;
  }
  const t = conn.target;
  const strict = (opts.get('stricthostkeychecking') ?? 'ask').toLowerCase();
  if (!(await sshVerifyHostKey(ctx, t, strict, false, quiet, null))) return 255;
  if (!(await sshAuthenticate(ctx, t, user, false))) return 255;
  const remoteUser = t.remote.userByName(user)!;
  const rctx: OpContext = { cwd: remoteUser.home, creds: t.remote.credsFor(remoteUser), umask: 0o002 };
  const rfs = t.remote.fs;
  const rpath = (p: string) => (p === '' ? remoteUser.home : p.startsWith('/') ? p : p.startsWith('~/') ? `${remoteUser.home}/${p.slice(2)}` : `${remoteUser.home}/${p}`);
  const showProgress = !quiet && ctx.stdout.isTTY;
  const cols = ctx.tty?.cols ?? 80;
  let status = 0;
  // Generic copy between (fsA, ctxA) and (fsB, ctxB).
  const copyTree = async (read: (p: string) => Inode | null, readData: (p: string) => FileData, list: (p: string) => string[], from: string, write: (p: string, d: FileData, mode: number, mtime: number) => void, mkdir: (p: string) => void, isDir: (p: string) => boolean, to: string, label: string): Promise<boolean> => {
    const node = read(from);
    if (!node) {
      await ctx.err(`scp: ${label}: No such file or directory\n`);
      return false;
    }
    if (node.type === 'dir') {
      if (!recursive) {
        await ctx.err(`scp: ${label}: not a regular file\n`);
        return false;
      }
      const target = isDir(to) ? `${to.replace(/\/+$/, '')}/${basename(from)}` : to;
      if (!isDir(target)) mkdir(target);
      let ok = true;
      for (const n of list(from)) {
        if (!(await copyTree(read, readData, list, `${from.replace(/\/+$/, '')}/${n}`, write, mkdir, isDir, target, `${label.replace(/\/+$/, '')}/${n}`))) ok = false;
      }
      return ok;
    }
    if (node.type !== 'file') {
      await ctx.err(`scp: ${label}: not a regular file\n`);
      return false;
    }
    const data = readData(from);
    const target = isDir(to) ? `${to.replace(/\/+$/, '')}/${basename(from)}` : to;
    await ctx.sleep(Math.round(dataSize(data) / (t.host?.bandwidth ?? 1e8) * 1000) + 5);
    write(target, typeof data === 'string' ? data : { ...data }, node.mode & 0o777, node.mtime);
    if (showProgress) await ctx.out(scpProgress(basename(from), dataSize(data), cols) + '\n');
    return true;
  };
  for (const s of srcs) {
    await ctx.checkpoint();
    try {
      if (dst.remote) {
        // upload
        const ok = await copyTree(
          (p) => ctx.fs.tryStat(p),
          (p) => ctx.fs.readData(p),
          (p) => ctx.fs.readdir(p).sort(),
          s.path,
          (p, d, mode, mtime) => {
            rfs.writeFile(p, d, rctx, { mode });
            if (preserve) rfs.setTimes(p, mtime, mtime, rctx);
          },
          (p) => rfs.mkdir(p, rctx),
          (p) => rfs.isDir(p, rctx),
          rpath(dst.path),
          s.path,
        );
        if (!ok) status = 1;
      } else {
        const ok = await copyTree(
          (p) => rfs.tryStat(p, rctx),
          (p) => rfs.readData(p, rctx),
          (p) => rfs.readdir(p, rctx).sort(),
          rpath(s.path),
          (p, d, mode, mtime) => {
            ctx.fs.writeFile(p, d, { mode });
            if (preserve) ctx.fs.setTimes(p, mtime, mtime);
          },
          (p) => ctx.fs.mkdir(p),
          (p) => ctx.fs.isDir(p),
          dst.path,
          rpath(s.path),
        );
        if (!ok) status = 1;
      }
    } catch (e) {
      await ctx.err(`scp: ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

const SCP_DEF: CommandDef = {
  name: 'scp',
  pkg: 'openssh-client',
  size: 134712,
  gnu: false,
  doc: {
    category: 'network',
    summary: 'OpenSSH secure file copy',
    synopsis: ['scp [-r] [-p] [-q] [-P port] source ... target'],
    description:
      'scp copies files between computers over an SSH connection. One side is written host:path (or user@host:path); a path without a leading slash is relative to your home directory on that computer. scp asks for the password the same way ssh does.',
    options: [
      { flags: '-r', desc: 'Recursively copy entire directories.' },
      { flags: '-p', desc: 'Preserves modification times and modes from the original file.' },
      { flags: '-q', desc: 'Quiet mode: disables the progress meter.' },
      { flags: '-P port', desc: 'Specifies the port to connect to on the remote host.' },
    ],
    examples: [
      { cmd: 'scp notes.txt webserver:', desc: 'Copy a file to your home directory on webserver.' },
      { cmd: 'scp webserver:/var/log/nginx/access.log .', desc: 'Copy a file from webserver to here.' },
      { cmd: 'scp -r Documents webserver:backup/', desc: 'Copy a whole directory.' },
    ],
    seeAlso: ['ssh', 'cp'],
    tip: 'Do not forget the colon: "scp notes.txt webserver:" copies to webserver, but "scp notes.txt webserver" just makes a local copy named webserver.',
  },
  run: async (ctx) => {
    if (ctx.args.includes('--help')) {
      await ctx.out(gnuHelp(SCP_DEF));
      return 0;
    }
    return scpMain(ctx);
  },
};

defineCommand(SCP_DEF);

// ===========================================================================
// ip

function lifetime(sys: System): number {
  const left = 86400 - Math.floor(((sys.now() - sys.bootTime) / 1000) % 86400);
  return Math.max(1, left);
}

function ipv6LinkLocal(mac: string): string {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  b[0] ^= 2;
  const h = (x: number, y: number) => ((x << 8) | y).toString(16);
  return `fe80::${h(b[0], b[1])}:${h(b[2], 0xff)}:${h(0xfe, b[3])}:${h(b[4], b[5])}`;
}

interface Iface {
  index: number;
  name: string;
  flags: string;
  mtu: number;
  qdisc: string;
  state: string;
  linkType: string;
  mac: string;
  brd: string;
  addrs: { family: 4 | 6; text: string; brief: string }[];
}

function interfaces(sys: System, family: 0 | 4 | 6): Iface[] {
  const p = profileOf(sys);
  const lft = lifetime(sys);
  const ethDown = p.linkDown.has(p.ifname);
  const loDown = p.linkDown.has('lo');
  const ifs: Iface[] = [
    {
      index: 1,
      name: 'lo',
      flags: loDown ? '<LOOPBACK>' : '<LOOPBACK,UP,LOWER_UP>',
      mtu: 65536,
      qdisc: 'noqueue',
      state: loDown ? 'DOWN' : 'UNKNOWN',
      linkType: 'loopback',
      mac: '00:00:00:00:00:00',
      brd: '00:00:00:00:00:00',
      addrs: [
        { family: 4, text: '    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n', brief: '127.0.0.1/8' },
        { family: 6, text: '    inet6 ::1/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever\n', brief: '::1/128' },
      ],
    },
    {
      index: 2,
      name: p.ifname,
      flags: ethDown ? '<BROADCAST,MULTICAST>' : '<BROADCAST,MULTICAST,UP,LOWER_UP>',
      mtu: 1500,
      qdisc: 'fq_codel',
      state: ethDown ? 'DOWN' : 'UP',
      linkType: 'ether',
      mac: p.mac,
      brd: 'ff:ff:ff:ff:ff:ff',
      addrs: [
        {
          family: 4,
          text: `    inet ${p.ip}/${p.prefix} metric 100 brd ${p.ip.split('.').slice(0, 3).join('.')}.255 scope global dynamic ${p.ifname}\n       valid_lft ${lft}sec preferred_lft ${lft}sec\n`,
          brief: `${p.ip}/${p.prefix}`,
        },
        ...p.extraAddrs.map((a) => ({ family: 4 as const, text: `    inet ${a} scope global ${p.ifname}\n       valid_lft forever preferred_lft forever\n`, brief: a })),
        { family: 6, text: `    inet6 ${ipv6LinkLocal(p.mac)}/64 scope link \n       valid_lft forever preferred_lft forever\n`, brief: `${ipv6LinkLocal(p.mac)}/64` },
      ],
    },
  ];
  for (const i of ifs) i.addrs = i.addrs.filter((a) => family === 0 || a.family === family);
  return ifs;
}

function ipRoutes(sys: System): string[] {
  const p = profileOf(sys);
  const net = p.ip.split('.').slice(0, 3).join('.');
  return [
    `default via ${p.gateway} dev ${p.ifname} proto dhcp src ${p.ip} metric 100 `,
    `${net}.0/${p.prefix} dev ${p.ifname} proto kernel scope link src ${p.ip} metric 100 `,
    `${p.gateway} dev ${p.ifname} proto dhcp scope link src ${p.ip} metric 100 `,
    ...(p.gateway === GATEWAY_IP ? [`10.0.2.3 dev ${p.ifname} proto dhcp scope link src ${p.ip} metric 100 `] : []),
    ...p.extraRoutes,
  ];
}

const IP_USAGE =
  'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\n' +
  '       ip [ -force ] -batch filename\n' +
  'where  OBJECT := { address | addrlabel | amt | fou | help | ila | ioam | l2tp |\n' +
  '                   link | macsec | maddress | monitor | mptcp | mroute | mrule |\n' +
  '                   neighbor | neighbour | netconf | netns | nexthop | ntable |\n' +
  '                   ntbl | route | rule | sr | tap | tcpmetrics |\n' +
  '                   token | tunnel | tuntap | vrf | xfrm }\n' +
  '       OPTIONS := { -V[ersion] | -s[tatistics] | -d[etails] | -r[esolve] |\n' +
  '                    -h[uman-readable] | -iec | -j[son] | -p[retty] |\n' +
  '                    -f[amily] { inet | inet6 | mpls | bridge | link } |\n' +
  '                    -4 | -6 | -M | -B | -0 |\n' +
  '                    -l[oops] { maximum-addr-flush-attempts } | -br[ief] |\n' +
  '                    -o[neline] | -t[imestamp] | -ts[hort] | -b[atch] [filename] |\n' +
  '                    -rc[vbuf] [size] | -n[etns] name | -N[umeric] | -a[ll] |\n' +
  '                    -c[olor]}\n';

const IP_OBJECTS = ['address', 'addrlabel', 'maddress', 'route', 'rule', 'neighbor', 'neighbour', 'ntable', 'ntbl', 'link', 'l2tp', 'fou', 'ila', 'macsec', 'tunnel', 'tuntap', 'tap', 'token', 'tcpmetrics', 'monitor', 'xfrm', 'mroute', 'mrule', 'netns', 'netconf', 'vrf', 'sr', 'nexthop', 'mptcp', 'ioam', 'amt', 'help'];

function linkStats(sys: System, idx: number): string {
  const up = Math.floor((sys.now() - sys.bootTime) / 1000);
  const rxp = idx === 1 ? 1840 + up : 48211 + up * 3;
  const rxb = idx === 1 ? rxp * 96 : rxp * 1012;
  const txp = idx === 1 ? rxp : 21560 + up * 2;
  const txb = idx === 1 ? rxb : txp * 188;
  return `    RX:  bytes packets errors dropped  missed   mcast           \n${String(rxb).padStart(14)} ${String(rxp).padStart(7)}      0       0       0       0 \n    TX:  bytes packets errors dropped carrier collsns           \n${String(txb).padStart(14)} ${String(txp).padStart(7)}      0       0       0       0 \n`;
}

async function ipMain(ctx: CommandContext): Promise<number> {
  const args = [...ctx.args];
  let family: 0 | 4 | 6 = 0;
  let brief = false;
  let stats = false;
  while (args.length && args[0].startsWith('-')) {
    const a = args.shift()!;
    if (a === '-4') family = 4;
    else if (a === '-6') family = 6;
    else if (/^-br(i(e(f)?)?)?$/.test(a)) brief = true;
    else if (/^-s(t(a(t(i(s(t(i(c(s)?)?)?)?)?)?)?)?)?$/.test(a)) stats = true;
    else if (a === '-V' || a === '-Version') {
      await ctx.out('ip utility, iproute2-6.1.0, libbpf 1.3.0\n');
      return 0;
    } else if (/^-c(olor)?(=.*)?$/.test(a) || /^-d(etails)?$/.test(a) || a === '-o' || a === '-oneline' || /^-h(uman)?/.test(a) || a === '-N' || a === '-r') continue;
    else if (a === '-f' || a === '-family') {
      const f = args.shift();
      family = f === 'inet' ? 4 : f === 'inet6' ? 6 : 0;
    } else if (a === '-j' || a === '-json') {
      await ctx.err('Option "-json" is not supported in this simulator.\n');
      return 1;
    } else {
      await ctx.err(`Option "${a}" is unknown, try "ip -help".\n`);
      return 255;
    }
  }
  if (args.length === 0) {
    await ctx.err(IP_USAGE);
    return 255;
  }
  const objArg = args.shift()!;
  const obj = IP_OBJECTS.find((o) => o.startsWith(objArg));
  if (!obj) {
    await ctx.err(`Object "${objArg}" is unknown, try "ip help".\n`);
    return 1;
  }
  if (obj === 'help') {
    await ctx.err(IP_USAGE);
    return 255;
  }
  const p = profileOf(ctx.system);
  const root = ctx.creds.uid === 0;
  const denied = async () => {
    await ctx.err('RTNETLINK answers: Operation not permitted\n');
    return 2;
  };
  const sub = (args.shift() ?? 'show').toLowerCase();
  const matches = (word: string, full: string) => full.startsWith(word);
  if (obj === 'address') {
    if (matches(sub, 'show') || matches(sub, 'list') || sub === 'lst') {
      let dev: string | null = null;
      while (args.length) {
        const w = args.shift()!;
        if (w === 'dev') dev = args.shift() ?? null;
        else if (!['up', 'scope', 'label', 'to', 'primary', 'secondary', 'dynamic', 'permanent'].includes(w)) dev = w;
      }
      let ifs = interfaces(ctx.system, family);
      if (dev !== null) {
        ifs = ifs.filter((i) => i.name === dev);
        if (ifs.length === 0) {
          await ctx.err(`Device "${dev}" does not exist.\n`);
          return 1;
        }
      }
      let out = '';
      for (const i of ifs) {
        if (brief) {
          out += `${i.name.padEnd(16)} ${i.state.padEnd(14)} ${i.addrs.map((a) => a.brief + ' ').join('')}\n`;
          continue;
        }
        if (family !== 0 && i.addrs.length === 0) continue;
        out += `${i.index}: ${i.name}: ${i.flags} mtu ${i.mtu} qdisc ${i.qdisc} state ${i.state} group default qlen 1000\n`;
        if (family === 0) out += `    link/${i.linkType} ${i.mac} brd ${i.brd}\n`;
        for (const a of i.addrs) out += a.text;
        if (stats) out += linkStats(ctx.system, i.index);
      }
      await ctx.out(out);
      return 0;
    }
    if (sub === 'add' || sub === 'del' || sub === 'delete' || sub === 'flush' || sub === 'change' || sub === 'replace') {
      if (!root) return denied();
      const addr = args[0];
      const devAt = args.indexOf('dev');
      const dev = devAt !== -1 ? args[devAt + 1] : null;
      if (sub !== 'flush' && (!addr || dev === null)) {
        await ctx.err('Not enough information: "dev" argument is required.\n');
        return 1;
      }
      if (dev !== null && dev !== p.ifname && dev !== 'lo') {
        await ctx.err(`Cannot find device "${dev}"\n`);
        return 1;
      }
      const withPrefix = addr && addr.includes('/') ? addr : `${addr}/32`;
      if (sub === 'add') {
        if (p.extraAddrs.includes(withPrefix) || withPrefix.split('/')[0] === p.ip) {
          await ctx.err('RTNETLINK answers: File exists\n');
          return 2;
        }
        p.extraAddrs.push(withPrefix);
      } else if (sub === 'del' || sub === 'delete') {
        const i = p.extraAddrs.findIndex((x) => x.split('/')[0] === withPrefix.split('/')[0]);
        if (i === -1) {
          await ctx.err('RTNETLINK answers: Cannot assign requested address\n');
          return 2;
        }
        p.extraAddrs.splice(i, 1);
      } else if (sub === 'flush') p.extraAddrs = [];
      return 0;
    }
    if (sub === 'help') {
      await ctx.err('Usage: ip address {add|change|replace} IFADDR dev IFNAME [ LIFETIME ]\n                                                      [ CONFFLAG-LIST ]\n       ip address del IFADDR dev IFNAME [mngtmpaddr]\n       ip address {save|flush} [ dev IFNAME ] [ scope SCOPE-ID ]\n                            [ to PREFIX ] [ FLAG-LIST ] [ label LABEL ] [up]\n       ip address [ show [ dev IFNAME ] [ scope SCOPE-ID ] [ master DEVICE ]\n                         [ nomaster ]\n                         [ type TYPE ] [ to PREFIX ] [ FLAG-LIST ]\n                         [ label LABEL ] [up] [ vrf NAME ]\n                         [ proto ADDRPROTO ] ]\n');
      return 255;
    }
    await ctx.err(`Command "${sub}" is unknown, try "ip address help".\n`);
    return 255;
  }
  if (obj === 'link') {
    if (matches(sub, 'show') || matches(sub, 'list')) {
      let dev: string | null = null;
      while (args.length) {
        const w = args.shift()!;
        if (w === 'dev') dev = args.shift() ?? null;
        else if (w !== 'up') dev = w;
      }
      let ifs = interfaces(ctx.system, 0);
      if (dev !== null) {
        ifs = ifs.filter((i) => i.name === dev);
        if (ifs.length === 0) {
          await ctx.err(`Device "${dev}" does not exist.\n`);
          return 1;
        }
      }
      let out = '';
      for (const i of ifs) {
        if (brief) {
          out += `${i.name.padEnd(16)} ${i.state.padEnd(14)} ${i.mac} ${i.flags} \n`;
          continue;
        }
        out += `${i.index}: ${i.name}: ${i.flags} mtu ${i.mtu} qdisc ${i.qdisc} state ${i.state} mode DEFAULT group default qlen 1000\n    link/${i.linkType} ${i.mac} brd ${i.brd}\n`;
        if (stats) out += linkStats(ctx.system, i.index);
      }
      await ctx.out(out);
      return 0;
    }
    if (sub === 'set') {
      if (!root) return denied();
      let dev = args[0] === 'dev' ? args[1] : args[0];
      const rest = args[0] === 'dev' ? args.slice(2) : args.slice(1);
      if (!dev || (dev !== 'lo' && dev !== p.ifname)) {
        await ctx.err(`Cannot find device "${dev ?? ''}"\n`);
        return 1;
      }
      dev = dev as string;
      if (rest.includes('down')) p.linkDown.add(dev);
      if (rest.includes('up')) p.linkDown.delete(dev);
      return 0;
    }
    await ctx.err(`Command "${sub}" is unknown, try "ip link help".\n`);
    return 255;
  }
  if (obj === 'route') {
    if (matches(sub, 'show') || matches(sub, 'list')) {
      if (family === 6) {
        await ctx.out(`::1 dev lo proto kernel metric 256 pref medium\nfe80::/64 dev ${p.ifname} proto kernel metric 256 pref medium\n`);
        return 0;
      }
      const filter = args.filter((w) => w !== 'table' && w !== 'main');
      let routes = ipRoutes(ctx.system);
      if (filter[0] === 'default') routes = routes.filter((r) => r.startsWith('default'));
      await ctx.out(routes.map((r) => r + '\n').join(''));
      return 0;
    }
    if (sub === 'get') {
      const dst = args[0];
      if (!dst || !isIPv4(dst)) {
        await ctx.err(`Error: any valid prefix is expected rather than "${dst ?? ''}".\n`);
        return 1;
      }
      const t = targetFor(ctx.system, dst);
      const uid = ctx.creds.uid;
      if (t.kind === 'local') await ctx.out(`local ${dst} dev lo src ${dst.startsWith('127.') ? '127.0.0.1' : p.ip} uid ${uid} \n    cache <local> \n`);
      else if (dst.startsWith(p.ip.split('.').slice(0, 3).join('.') + '.')) await ctx.out(`${dst} dev ${p.ifname} src ${p.ip} uid ${uid} \n    cache \n`);
      else await ctx.out(`${dst} via ${p.gateway} dev ${p.ifname} src ${p.ip} uid ${uid} \n    cache \n`);
      return 0;
    }
    if (sub === 'add' || sub === 'del' || sub === 'delete' || sub === 'replace' || sub === 'change') {
      if (!root) return denied();
      const spec = args.join(' ');
      if (!spec) {
        await ctx.err('Error: either "to" is a duplicate, or "" is a garbage.\n');
        return 1;
      }
      if (sub === 'add' || sub === 'replace') {
        if (p.extraRoutes.some((r) => r.startsWith(args[0] + ' '))) {
          if (sub === 'add') {
            await ctx.err('RTNETLINK answers: File exists\n');
            return 2;
          }
        }
        p.extraRoutes = p.extraRoutes.filter((r) => !r.startsWith(args[0] + ' '));
        p.extraRoutes.push(`${spec} `);
      } else {
        const before = p.extraRoutes.length;
        p.extraRoutes = p.extraRoutes.filter((r) => !r.startsWith(args[0] + ' '));
        if (p.extraRoutes.length === before) {
          await ctx.err('RTNETLINK answers: No such process\n');
          return 2;
        }
      }
      return 0;
    }
    await ctx.err(`Command "${sub}" is unknown, try "ip route help".\n`);
    return 255;
  }
  if (obj === 'neighbor' || obj === 'neighbour') {
    if (matches(sub, 'show') || matches(sub, 'list')) {
      const gw = p.gateway;
      await ctx.out(`${gw} dev ${p.ifname} lladdr 52:54:00:12:35:02 REACHABLE \n${gw === GATEWAY_IP ? `10.0.2.3 dev ${p.ifname} lladdr 52:54:00:12:35:03 STALE \n` : ''}`);
      return 0;
    }
    if (!root) return denied();
    return 0;
  }
  if (obj === 'rule') {
    await ctx.out('0:\tfrom all lookup local\n32766:\tfrom all lookup main\n32767:\tfrom all lookup default\n');
    return 0;
  }
  if (obj === 'maddress') {
    await ctx.out(`1:\tlo\n\tinet  224.0.0.1\n\tinet6 ff02::1\n\tinet6 ff01::1\n2:\t${p.ifname}\n\tlink  01:00:5e:00:00:01\n\tlink  33:33:00:00:00:01\n\tinet  224.0.0.1\n\tinet6 ff02::1\n\tinet6 ff01::1\n`);
    return 0;
  }
  // Other objects exist on a real system but have nothing to show here.
  return 0;
}

const IP_DEF: CommandDef = {
  name: 'ip',
  pkg: 'iproute2',
  size: 760912,
  gnu: false,
  doc: {
    category: 'network',
    section: 8,
    summary: 'show / manipulate routing, network devices, interfaces and tunnels',
    synopsis: ['ip [ OPTIONS ] OBJECT { COMMAND | help }', 'ip a', 'ip route', 'ip link'],
    description:
      'ip shows and changes the network configuration of this computer. The OBJECT says what to look at, and can be shortened: ip address (or ip addr, ip a) lists the network interfaces and their IP addresses, ip link lists the interfaces themselves, ip route shows where packets are sent (the "default via" line names the router), and ip neigh shows the computers recently seen on the local network.\n\n' +
      'Every computer has a loopback interface called lo with the address 127.0.0.1 ("localhost", the computer talking to itself). Here eth0 is the network card, with the address 10.0.2.15. Changing the configuration (add, del, set) needs root, so use sudo.',
    options: [
      { flags: '-4', desc: 'Show only IPv4 addresses.' },
      { flags: '-6', desc: 'Show only IPv6 addresses.' },
      { flags: '-br, -brief', desc: 'Print one short line per interface.' },
      { flags: '-s, -statistics', desc: 'Show packet and byte counters.' },
      { flags: '-V, -Version', desc: 'Print the version and exit.' },
    ],
    examples: [
      { cmd: 'ip a', desc: 'Show every interface and its IP addresses.' },
      { cmd: 'ip -br a', desc: 'The same, one line per interface.' },
      { cmd: 'ip route', desc: 'Show the routing table; "default via" is your router.' },
      { cmd: 'ip link', desc: 'Show interfaces and their hardware (MAC) addresses.' },
    ],
    seeAlso: ['ss', 'ping', 'hostname'],
    tip: 'Looking for "my IP address"? Run ip a and look for the "inet" line under eth0 (or use hostname -I).',
  },
  run: async (ctx) => {
    if (ctx.args.includes('--help')) {
      await ctx.out(gnuHelp(IP_DEF));
      return 0;
    }
    return ipMain(ctx);
  },
};

defineCommand(IP_DEF);

// ===========================================================================
// ss

const SERVICE_NAMES: Record<number, string> = { 22: 'ssh', 53: 'domain', 67: 'bootps', 68: 'bootpc', 80: 'http', 443: 'https', 631: 'ipp' };

interface SockRow {
  netid: 'tcp' | 'udp';
  state: string;
  recvQ: number;
  sendQ: number;
  local: string;
  localPort: number;
  peer: string;
  peerPort: number | '*';
  listening: boolean;
  v6: boolean;
  proc: string;
}

function socketRows(sys: System): SockRow[] {
  const p = profileOf(sys);
  const rows: SockRow[] = [];
  const listen = (netid: 'tcp' | 'udp', local: string, port: number, backlog: number, v6: boolean, proc: string) => {
    rows.push({ netid, state: netid === 'tcp' ? 'LISTEN' : 'UNCONN', recvQ: 0, sendQ: netid === 'tcp' ? backlog : 0, local, localPort: port, peer: v6 ? '[::]' : '0.0.0.0', peerPort: '*', listening: true, v6, proc });
  };
  if (p.services.includes('dns')) {
    listen('udp', '127.0.0.54', 53, 0, false, 'users:(("systemd-resolve",pid=541,fd=16))');
    listen('udp', '127.0.0.53%lo', 53, 0, false, 'users:(("systemd-resolve",pid=541,fd=14))');
  }
  if (p.services.includes('dhcp')) listen('udp', `${p.ip}%${p.ifname}`, 68, 0, false, 'users:(("systemd-network",pid=512,fd=22))');
  if (p.services.includes('dns')) {
    listen('tcp', '127.0.0.53%lo', 53, 4096, false, 'users:(("systemd-resolve",pid=541,fd=15))');
    listen('tcp', '127.0.0.54', 53, 4096, false, 'users:(("systemd-resolve",pid=541,fd=17))');
  }
  if (p.services.includes('http')) listen('tcp', '0.0.0.0', 80, 511, false, 'users:(("nginx",pid=903,fd=5),("nginx",pid=902,fd=5),("nginx",pid=901,fd=5))');
  if (p.services.includes('ssh')) listen('tcp', '0.0.0.0', 22, 4096, false, 'users:(("sshd",pid=812,fd=3),("systemd",pid=1,fd=93))');
  if (p.services.includes('http')) listen('tcp', '[::]', 80, 511, true, 'users:(("nginx",pid=903,fd=6),("nginx",pid=902,fd=6),("nginx",pid=901,fd=6))');
  if (p.services.includes('ssh')) listen('tcp', '[::]', 22, 4096, true, 'users:(("sshd",pid=812,fd=4),("systemd",pid=1,fd=94))');
  for (const c of connectionsOf(sys)) {
    rows.push({ netid: 'tcp', state: 'ESTAB', recvQ: 0, sendQ: c.process === 'sshd' ? 36 : 0, local: c.localIp, localPort: c.localPort, peer: c.remoteIp, peerPort: c.remotePort, listening: false, v6: false, proc: c.process === 'sshd' ? 'users:(("sshd",pid=1187,fd=4),("sshd",pid=1104,fd=4))' : `users:(("ssh",pid=${4100 + (c.localPort % 900)},fd=3))` });
  }
  return rows;
}

async function ssMain(ctx: CommandContext): Promise<number> {
  let tcp = false;
  let udp = false;
  let listening = false;
  let all = false;
  let numeric = false;
  let procs = false;
  let summary = false;
  let only4 = false;
  let only6 = false;
  let noHeader = false;
  let unix = false;
  for (const a of ctx.args) {
    if (a.startsWith('--')) {
      const long: Record<string, string> = { '--tcp': 't', '--udp': 'u', '--listening': 'l', '--all': 'a', '--numeric': 'n', '--processes': 'p', '--summary': 's', '--ipv4': '4', '--ipv6': '6', '--no-header': 'H', '--unix': 'x', '--resolve': 'r', '--extended': 'e', '--info': 'i', '--memory': 'm' };
      const c = long[a];
      if (!c) {
        await ctx.err(`ss: unrecognized option '${a}'\n`);
        await ctx.err('Usage: ss [ OPTIONS ]\n       ss [ OPTIONS ] [ FILTER ]\n');
        return 255;
      }
      if (c === 't') tcp = true;
      else if (c === 'u') udp = true;
      else if (c === 'l') listening = true;
      else if (c === 'a') all = true;
      else if (c === 'n') numeric = true;
      else if (c === 'p') procs = true;
      else if (c === 's') summary = true;
      else if (c === '4') only4 = true;
      else if (c === '6') only6 = true;
      else if (c === 'H') noHeader = true;
      else if (c === 'x') unix = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) {
        if (c === 't') tcp = true;
        else if (c === 'u') udp = true;
        else if (c === 'l') listening = true;
        else if (c === 'a') all = true;
        else if (c === 'n') numeric = true;
        else if (c === 'p') procs = true;
        else if (c === 's') summary = true;
        else if (c === '4') only4 = true;
        else if (c === '6') only6 = true;
        else if (c === 'H') noHeader = true;
        else if (c === 'x') unix = true;
        else if (c === 'V') {
          await ctx.out('ss utility, iproute2-6.1.0\n');
          return 0;
        } else if ('reimoOwZz'.includes(c)) continue;
        else {
          await ctx.err(`ss: invalid option -- '${c}'\nUsage: ss [ OPTIONS ]\n       ss [ OPTIONS ] [ FILTER ]\n`);
          return 255;
        }
      }
    }
  }
  const rows = socketRows(ctx.system);
  if (summary) {
    const t = rows.filter((r) => r.netid === 'tcp');
    const u = rows.filter((r) => r.netid === 'udp');
    const est = t.filter((r) => r.state === 'ESTAB').length;
    const t4 = t.filter((r) => !r.v6).length;
    const u4 = u.filter((r) => !r.v6).length;
    await ctx.out(
      `Total: ${142 + rows.length}\nTCP:   ${t.length} (estab ${est}, closed 0, orphaned 0, timewait 0)\n\n` +
        'Transport Total     IP        IPv6\n' +
        'RAW\t  1         0         1        \n' +
        `UDP\t  ${String(u.length).padEnd(10)}${String(u4).padEnd(10)}${String(u.length - u4).padEnd(9)}\n` +
        `TCP\t  ${String(t.length).padEnd(10)}${String(t4).padEnd(10)}${String(t.length - t4).padEnd(9)}\n` +
        `INET\t  ${String(t.length + u.length + 1).padEnd(10)}${String(t4 + u4).padEnd(10)}${String(t.length - t4 + u.length - u4 + 1).padEnd(9)}\n` +
        'FRAG\t  0         0         0        \n',
    );
    return 0;
  }
  if (!tcp && !udp && !unix) {
    tcp = true;
    udp = true;
  }
  let selected = rows.filter((r) => (r.netid === 'tcp' ? tcp : udp));
  if (only4) selected = selected.filter((r) => !r.v6);
  if (only6) selected = selected.filter((r) => r.v6);
  if (!all) selected = selected.filter((r) => (listening ? r.listening : !r.listening));
  const showNetid = (tcp ? 1 : 0) + (udp ? 1 : 0) + (unix ? 1 : 0) > 1;
  const port = (n: number | '*') => (n === '*' ? '*' : numeric || !SERVICE_NAMES[n] ? String(n) : SERVICE_NAMES[n]);
  const root = ctx.creds.uid === 0;
  type Cols = [string, string, string, string, string, string, string, string, string];
  const head: Cols = ['Netid', 'State', 'Recv-Q', 'Send-Q', 'Local Address:', 'Port', 'Peer Address:', 'Port', 'Process'];
  const data: Cols[] = selected.map((r) => [r.netid, r.state, String(r.recvQ), String(r.sendQ), r.local + ':', port(r.localPort), r.peer + ':', port(r.peerPort), procs && root ? r.proc : '']);
  const enabled = [showNetid, true, true, true, true, true, true, true, true];
  const ldelim = ['', ' ', ' ', ' ', ' ', '', ' ', '', ''];
  const right = [false, false, false, false, true, false, true, false, false];
  const width: number[] = head.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  let first = true;
  for (let i = 0; i < 9; i++) {
    if (!enabled[i]) continue;
    if (!first) width[i] += ldelim[i].length;
    first = false;
  }
  const render = (cols: Cols): string => {
    let line = '';
    let firstCol = true;
    for (let i = 0; i < 9; i++) {
      if (!enabled[i]) continue;
      const delim = firstCol ? '' : ldelim[i];
      firstCol = false;
      const w = width[i] - delim.length;
      line += delim + (right[i] ? cols[i].padStart(w) : cols[i].padEnd(w));
    }
    return line;
  };
  let out = noHeader ? '' : render(head) + '\n';
  for (const d of data) out += render(d) + '\n';
  if (unix && !tcp && !udp) {
    out = (noHeader ? '' : 'Netid State  Recv-Q Send-Q          Local Address:Port   Peer Address:Port Process\n') +
      'u_str ESTAB  0      0      /run/systemd/journal/stdout 18432            * 18431        \n' +
      'u_str ESTAB  0      0                                * 21877            * 21878        \n' +
      'u_str ESTAB  0      0     /run/dbus/system_bus_socket 19803            * 19802        \n';
  }
  await ctx.out(out);
  return 0;
}

const SS_DEF: CommandDef = {
  name: 'ss',
  pkg: 'iproute2',
  size: 136912,
  gnu: false,
  doc: {
    category: 'network',
    section: 8,
    summary: 'another utility to investigate sockets',
    synopsis: ['ss [options] [ FILTER ]'],
    description:
      'ss lists the network connections ("sockets") of this computer. The most useful form is ss -tuln: TCP (-t) and UDP (-u) sockets that are listening (-l), with port numbers instead of service names (-n). Each listening socket is a service waiting for connections; for example port 22 is the SSH server and port 80 a web server. A local address of 0.0.0.0 or [::] means "every network interface", while 127.0.0.1 means only this computer can connect.\n\n' +
      'Without -l, ss shows established connections instead. Add -p to see which program owns each socket (only for your own programs unless you use sudo).',
    options: [
      { flags: '-t, --tcp', desc: 'Display TCP sockets.' },
      { flags: '-u, --udp', desc: 'Display UDP sockets.' },
      { flags: '-l, --listening', desc: 'Display only listening sockets.' },
      { flags: '-a, --all', desc: 'Display both listening and non-listening sockets.' },
      { flags: '-n, --numeric', desc: 'Do not try to resolve service names (show port numbers).' },
      { flags: '-p, --processes', desc: 'Show the process using each socket.' },
      { flags: '-s, --summary', desc: 'Print summary statistics.' },
      { flags: '-4, --ipv4', desc: 'Display only IP version 4 sockets.' },
      { flags: '-6, --ipv6', desc: 'Display only IP version 6 sockets.' },
    ],
    examples: [
      { cmd: 'ss -tuln', desc: 'Which ports are open and listening?' },
      { cmd: 'sudo ss -tulnp', desc: 'The same, with the program behind each port.' },
      { cmd: 'ss -t', desc: 'Current TCP connections (like your SSH session).' },
    ],
    seeAlso: ['ip', 'ping'],
    tip: 'Well-known port numbers: 22 is SSH, 53 is DNS, 80 is HTTP (web pages) and 443 is HTTPS.',
  },
  run: async (ctx) => {
    if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
      await ctx.out(gnuHelp(SS_DEF));
      return 0;
    }
    return ssMain(ctx);
  },
};

defineCommand(SS_DEF);
