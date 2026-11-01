// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The villain's control panel for the live demo (APP.md §8a): a tiny HTTP
// server on localhost with a one-page HTML front end.
//
//   GET  /                 the page (buttons for every rule and action)
//   GET  /rules            JSON: armed rules, held envelopes, members, actions
//   POST /rules/<name>     arm a rule; parameters in the query or a JSON body:
//                            dropGroupMsg?from=alice&to=carol
//                            blackhole?to=carol
//                            hold?to=carol
//                            release?to=carol   (not a rule: delivers what
//                                                hold(carol) kept)
//   POST /clear            remove every rule and deliver everything held
//   GET  /log[?n=200]      the villain's decisions, one per line
//                          (?format=json for JSON)
//   POST /actions/<name>   a harness action (e.g. link-dave), parameters as
//                          for rules
//
// Example: `curl -X POST 'localhost:7357/rules/dropGroupMsg?from=alice&to=carol'`.
//
// The panel listens on 127.0.0.1 only. It has no authentication: it is a
// demo tool on one machine.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { blackhole, dropGroupMsg, hold } from './rules.ts';
import type { Name, Rule } from './rules.ts';
import type { EvilLogEntry } from './evil.ts';
import { formatEntry } from './evil.ts';

/** The part of EvilServer the panel drives (a fake in the tests). */
export type Villain = {
  readonly rules: ReadonlyArray<Rule>;
  readonly log: ReadonlyArray<EvilLogEntry>;
  readonly members: ReadonlyArray<Name>;
  arm(rule: Rule): void;
  clear(): Promise<number>;
  release(to: Name): Promise<number>;
  heldCounts(): Record<Name, number>;
};

/**
 * Something the harness can do on request, e.g. link Dave's desktop.
 * `fields` names the parameters the page asks for (text inputs).
 */
export type PanelAction = Readonly<{
  label: string;
  fields?: ReadonlyArray<string>;
  run: (params: Readonly<Record<string, string>>) => Promise<string>;
}>;

export type Panel = Readonly<{
  url: string;
  port: number;
  close: () => Promise<void>;
}>;

export type PanelOptions = Readonly<{
  villain: Villain;
  actions?: Readonly<Record<string, PanelAction>>;
  // 0 picks a free port.
  port?: number;
  // Called after every change, with a one-line description.
  onChange?: (what: string) => void;
}>;

class HttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One rule as the panel shows it. */
export type RuleView = Readonly<{
  id: string;
  verdict: string;
  once: boolean;
  // A `once` rule that has fired only affects the send it is bound to.
  fired: boolean;
}>;

export function viewRule(rule: Rule): RuleView {
  return {
    id: rule.id,
    verdict: rule.verdict,
    once: rule.once,
    fired: rule.boundTo !== undefined,
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Array<Buffer<ArrayBuffer>> = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer<ArrayBuffer>);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readParams(
  req: http.IncomingMessage,
  url: URL
): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    params[k] = v;
  }
  const body = (await readBody(req)).trim();
  if (body === '') {
    return params;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A form post: a=b&c=d
    for (const [k, v] of new URLSearchParams(body)) {
      params[k] = v;
    }
    return params;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'the body must be a JSON object');
  }
  for (const [k, v] of Object.entries(parsed)) {
    params[k] = String(v);
  }
  return params;
}

function member(
  villain: Villain,
  params: Readonly<Record<string, string>>,
  key: string
): Name {
  const value = params[key]?.trim().toLowerCase();
  if (!value) {
    throw new HttpError(400, `missing parameter "${key}"`);
  }
  if (!villain.members.includes(value)) {
    throw new HttpError(
      400,
      `"${value}" is not a member (${villain.members.join(', ')})`
    );
  }
  return value;
}

/** Arms rule `name`, or releases; returns what happened. */
export async function applyRule(
  villain: Villain,
  name: string,
  params: Readonly<Record<string, string>>
): Promise<string> {
  switch (name) {
    case 'dropGroupMsg': {
      const rule = dropGroupMsg(
        member(villain, params, 'from'),
        member(villain, params, 'to')
      );
      villain.arm(rule);
      return `armed ${rule.id}`;
    }
    case 'blackhole': {
      const rule = blackhole(member(villain, params, 'to'));
      villain.arm(rule);
      return `armed ${rule.id}`;
    }
    case 'hold': {
      const rule = hold(member(villain, params, 'to'));
      villain.arm(rule);
      return `armed ${rule.id}`;
    }
    case 'release': {
      const to = member(villain, params, 'to');
      const n = await villain.release(to);
      return `release(${to}): delivered ${n} held envelope(s)`;
    }
    default:
      throw new HttpError(404, `no rule "${name}"`);
  }
}

function send(
  res: http.ServerResponse,
  status: number,
  type: string,
  body: string
): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json', `${JSON.stringify(value, null, 2)}\n`);
}

/** Starts the panel; resolves once it listens. */
export async function startPanel({
  villain,
  actions = {},
  port = 0,
  onChange,
}: PanelOptions): Promise<Panel> {
  const changed = (what: string) => {
    onChange?.(what);
    return what;
  };

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && parts.length === 0) {
      send(res, 200, 'text/html', PAGE);
      return;
    }
    if (method === 'GET' && url.pathname === '/rules') {
      json(res, 200, {
        rules: villain.rules.map(viewRule),
        held: villain.heldCounts(),
        members: villain.members,
        actions: Object.fromEntries(
          Object.entries(actions).map(([k, a]) => [
            k,
            { label: a.label, fields: a.fields ?? [] },
          ])
        ),
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/log') {
      const n = Number(url.searchParams.get('n') ?? '200');
      const entries = villain.log.slice(-Math.max(1, n));
      if (url.searchParams.get('format') === 'json') {
        json(
          res,
          200,
          entries.map(e => ({
            ...e,
            seen: {
              ...e.seen,
              ts: String(e.seen.ts),
              recipients: [...e.seen.recipients].sort(),
            },
          }))
        );
      } else {
        send(
          res,
          200,
          'text/plain',
          `${entries.map(formatEntry).join('\n')}\n`
        );
      }
      return;
    }
    if (method === 'POST' && parts[0] === 'rules' && parts.length === 2) {
      const params = await readParams(req, url);
      const what = await applyRule(villain, parts[1] ?? '', params);
      json(res, 200, { ok: true, result: changed(what) });
      return;
    }
    if (method === 'POST' && url.pathname === '/clear') {
      await readBody(req);
      const n = await villain.clear();
      json(res, 200, {
        ok: true,
        result: changed(`clear: no rules; delivered ${n} held envelope(s)`),
      });
      return;
    }
    if (method === 'POST' && parts[0] === 'actions' && parts.length === 2) {
      const action = actions[parts[1] ?? ''];
      if (!action) {
        throw new HttpError(404, `no action "${parts[1]}"`);
      }
      const params = await readParams(req, url);
      const result = await action.run(params);
      json(res, 200, { ok: true, result: changed(`${parts[1]}: ${result}`) });
      return;
    }
    throw new HttpError(404, `no route ${method} ${url.pathname}`);
  };

  const respond = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    try {
      await handle(req, res);
    } catch (error: unknown) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      json(res, status, { ok: false, error: message });
    }
  };
  const server = http.createServer((req, res) => {
    void respond(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    port: actual,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// The page: plain HTML and a little script. It polls /rules and /log.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>zrdt villain</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; margin: 16px;
         background: #1b1b1f; color: #eee; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  h2 { font-size: 14px; margin: 16px 0 6px; color: #aaa; }
  button { font: inherit; margin: 2px 4px 2px 0; padding: 6px 10px;
           border-radius: 6px; border: 1px solid #555; background: #2d2d33;
           color: #eee; cursor: pointer; }
  button.bad { background: #6b1f1f; border-color: #a33; }
  button:hover { filter: brightness(1.2); }
  select, input { font: inherit; background: #2d2d33; color: #eee;
                  border: 1px solid #555; border-radius: 4px; padding: 4px; }
  input { width: 360px; }
  #rules li.fired { color: #888; text-decoration: line-through; }
  #status { color: #8c8; min-height: 1.2em; }
  #status.err { color: #e88; }
  pre { background: #111; padding: 8px; height: 320px; overflow: auto;
        font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>zrdt villain</h1>
<div id="status"></div>

<h2>Rules (first match wins)</h2>
<div>
  <button class="bad" data-rule="dropGroupMsg" data-from="alice" data-to="carol">
    dropGroupMsg(alice, carol)</button>
  <button class="bad" data-rule="blackhole" data-to="carol">blackhole(carol)</button>
  <button class="bad" data-rule="hold" data-to="carol">hold(carol)</button>
  <button data-rule="release" data-to="carol">release(carol)</button>
  <button id="clear">clear (villain off)</button>
</div>
<div style="margin-top:6px">
  from <select id="from"></select> to <select id="to"></select>
  <button class="bad" data-rule="dropGroupMsg" data-pick="1">dropGroupMsg</button>
  <button class="bad" data-rule="blackhole" data-pick="1">blackhole</button>
  <button class="bad" data-rule="hold" data-pick="1">hold</button>
  <button data-rule="release" data-pick="1">release</button>
</div>
<ul id="rules"></ul>
<div id="held"></div>

<h2>Harness</h2>
<div id="actions"></div>

<h2>Log (deliveries to linked desktops)</h2>
<pre id="log"></pre>

<script>
const $ = s => document.querySelector(s);
function show(text, err) {
  const el = $('#status');
  el.textContent = text;
  el.className = err ? 'err' : '';
}
async function post(path, params) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const body = await res.json();
  show(body.ok ? body.result : 'error: ' + body.error, !body.ok);
  refresh();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'clear') return post('/clear');
  if (b.dataset.rule) {
    const params = b.dataset.pick
      ? { from: $('#from').value, to: $('#to').value }
      : { from: b.dataset.from, to: b.dataset.to };
    return post('/rules/' + b.dataset.rule, params);
  }
  if (b.dataset.action) {
    const params = {};
    for (const input of b.parentElement.querySelectorAll('input')) {
      params[input.name] = input.value;
    }
    show(b.dataset.action + ': running...');
    return post('/actions/' + b.dataset.action, params);
  }
});
let built = false;
async function refresh() {
  const state = await (await fetch('/rules')).json();
  if (!built) {
    built = true;
    for (const sel of ['#from', '#to']) {
      for (const m of state.members) {
        const o = document.createElement('option');
        o.textContent = m;
        $(sel).appendChild(o);
      }
    }
    $('#from').value = state.members.includes('alice') ? 'alice' : state.members[0];
    $('#to').value = state.members.includes('carol') ? 'carol' : state.members[0];
    for (const [name, a] of Object.entries(state.actions)) {
      const div = document.createElement('div');
      for (const f of a.fields) {
        const input = document.createElement('input');
        input.name = f;
        input.placeholder = f;
        div.appendChild(input);
      }
      const b = document.createElement('button');
      b.dataset.action = name;
      b.textContent = a.label;
      div.appendChild(b);
      $('#actions').appendChild(div);
    }
  }
  $('#rules').innerHTML = '';
  for (const r of state.rules) {
    const li = document.createElement('li');
    li.textContent = r.id + (r.fired ? ' (fired)' : '');
    if (r.fired) li.className = 'fired';
    $('#rules').appendChild(li);
  }
  if (state.rules.length === 0) $('#rules').innerHTML = '<li>none: everything passes</li>';
  const held = Object.entries(state.held).map(([k, n]) => k + ': ' + n);
  $('#held').textContent = held.length ? 'held: ' + held.join(', ') : '';
  const log = await (await fetch('/log?n=200')).text();
  const pre = $('#log');
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = log;
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>
`;
