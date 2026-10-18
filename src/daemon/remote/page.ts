import { monoFont, sansFont, tokenColors, type Colors } from '../../shared/theme-tokens.js';

// v1.0.8 /remote: the phone page, self-contained. One static HTML file, its stylesheet and its script, served by the
// daemon itself: no third-party asset, no inline script or style (the CSP allows only 'self'). Nothing in the HTML is
// dynamic; the script builds every node with textContent, so an agent's screen, title or error can only ever be text.
// Never keys, env, logins or settings: the API doesn't have them. Every start is Ask; there is no Don't ask to choose.
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>AI Term</title><link rel="stylesheet" href="/app.css"></head>
<body><header><h1>AI Term</h1><span id="who"></span></header><main id="main"><p class="note">Loading…</p></main><script src="/app.js"></script></body></html>
`;
const vars = (c: Colors) => `--bg:${c.bg};--surface:${c.surface};--surface-2:${c['surface-2']};--line:${c.line};--ink:${c.ink};--ink-2:${c['ink-2']};--accent:${c.accent};--on-accent:${c['on-accent']};--waiting:${c['status-waiting']};--error:${c['status-error']}`;
export const PAGE_CSS = `:root{${vars(tokenColors('light'))}}
@media (prefers-color-scheme:dark){:root{${vars(tokenColors('dark'))}}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 ${sansFont}}
header{display:flex;justify-content:space-between;align-items:baseline;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}h2{font-size:17px;margin:8px 0}#who{color:var(--ink-2);font-size:14px}main{padding:12px 16px;max-width:720px;margin:0 auto}
.note{color:var(--ink-2)}.error{color:var(--error)}.row{display:block;width:100%;text-align:left;margin:0 0 8px;padding:12px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:8px;font:inherit}
.meta{display:block;color:var(--ink-2);font-size:14px}.waiting{color:var(--waiting)}pre{white-space:pre-wrap;word-break:break-word;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;font:13px/1.35 ${monoFont};max-height:60vh;overflow:auto}
button{font:inherit;padding:10px 14px;margin:4px 8px 4px 0;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
textarea,input,select{width:100%;font:inherit;padding:10px;margin:4px 0 8px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink)}label{display:block;color:var(--ink-2);font-size:14px}
`;
export const PAGE_JS = `'use strict';
(function () {
  var main = document.getElementById('main'), who = document.getElementById('who'), csrf = '', timer = 0;
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function clear() { clearTimeout(timer); while (main.firstChild) main.removeChild(main.firstChild); }
  function note(text, cls) { clear(); main.appendChild(el('p', text, cls || 'note')); }
  function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers = { 'content-type': 'application/json', 'x-ai-term-csrf': csrf }; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) { if (!r.ok) throw new Error(data && data.error ? data.error : 'Request failed (' + r.status + ')'); return data; });
    });
  }
  var WORDS = { starting: '◌ starting', running: '◐ running', waiting: '● waiting', done: '✓ done', exited: '■ exited', error: '✗ error' };
  function usage(a) { return (a.ctx === null ? '' : 'ctx ' + a.ctx + '% · ') + (a.tokens === null ? 'no usage yet' : a.tokens + ' tokens') + (a.costUsd === null ? '' : ' · $' + a.costUsd.toFixed(2)); }
  function pair() {
    var code = location.hash.slice(1); history.replaceState(null, '', '/pair');
    if (!code) { note('No pairing code here. On your Mac, run /remote on and scan the new code.'); return; }
    clear(); main.appendChild(el('p', 'Pair this phone with AI Term on your Mac. The code works once, for two minutes.', 'note'));
    var label = el('label', 'Name this phone'), input = el('input'), button = el('button', 'Pair', 'primary');
    input.maxLength = 40; input.value = 'phone'; label.appendChild(input);
    button.onclick = function () { csrf = 'pair'; button.disabled = true; api('POST', '/api/pair', { code: code, name: input.value.trim() || 'phone' }).then(function () { location.replace('/'); }, function (e) { note(e.message, 'error'); }); };
    main.appendChild(label); main.appendChild(button);
  }
  function list() {
    api('GET', '/api/agents').then(function (data) {
      clear(); main.appendChild(el('h2', 'Agents'));
      if (!data.agents.length) main.appendChild(el('p', 'No agents yet.', 'note'));
      data.agents.forEach(function (a) {
        var row = el('button', undefined, 'row'); row.appendChild(el('strong', a.title));
        row.appendChild(el('span', (WORDS[a.status] || a.status) + (a.waiting ? ' for ' + a.waiting : '') + ' · ' + usage(a), a.waiting ? 'meta waiting' : 'meta'));
        row.onclick = function () { agent(a); }; main.appendChild(row);
      });
      var add = el('button', 'New agent (Ask mode)', 'primary'); add.onclick = function () { form(data.folders); }; main.appendChild(add);
      timer = setTimeout(list, 5000);
    }, function (e) { note(e.message, 'error'); });
  }
  function agent(a) {
    api('GET', '/api/agents/' + a.id + '/screen').then(function (s) {
      clear(); main.appendChild(el('h2', a.title)); main.appendChild(el('pre', s.lines.join('\\n')));
      var back = el('button', 'Back'); back.onclick = list;
      var refresh = el('button', 'Refresh'); refresh.onclick = function () { agent(a); };
      if (s.waiting === 'permission') {
        main.appendChild(el('p', 'The agent is asking for permission. The screen above is exactly what it shows; your answer counts only if it is still the same.', 'note waiting'));
        ['yes', 'no'].forEach(function (answer) {
          var b = el('button', answer === 'yes' ? 'Approve' : 'Deny', answer === 'yes' ? 'primary' : '');
          b.onclick = function () { b.disabled = true; api('POST', '/api/agents/' + a.id + '/approve', { answer: answer, fingerprint: s.fingerprint }).then(function () { agent(a); }, function (e) { note(e.message, 'error'); }); };
          main.appendChild(b);
        });
      }
      var label = el('label', 'Send a message (the same rules as /send)'), text = el('textarea'); text.rows = 3; text.maxLength = 8000; label.appendChild(text);
      var send = el('button', 'Send', 'primary');
      send.onclick = function () { if (!text.value.trim()) return; send.disabled = true; api('POST', '/api/agents/' + a.id + '/send', { text: text.value }).then(function () { agent(a); }, function (e) { note(e.message, 'error'); }); };
      var stop = el('button', 'Stop agent'); stop.onclick = function () { if (confirm('Stop ' + a.title + '?')) api('POST', '/api/agents/' + a.id + '/stop', {}).then(list, function (e) { note(e.message, 'error'); }); };
      [label, send, stop, refresh, back].forEach(function (n) { main.appendChild(n); });
    }, function (e) { note(e.message, 'error'); });
  }
  function form(folders) {
    clear(); main.appendChild(el('h2', 'New agent'));
    if (!folders.length) { main.appendChild(el('p', 'No folder to start in yet: start one agent on your Mac first.', 'note')); }
    var engine = el('select'); [['claude-code', 'Claude Code'], ['codex', 'Codex']].forEach(function (o) { var opt = el('option', o[1]); opt.value = o[0]; engine.appendChild(opt); });
    var folder = el('select'); folders.forEach(function (f) { var opt = el('option', f); opt.value = f; folder.appendChild(opt); });
    var message = el('textarea'); message.rows = 4; message.maxLength = 8000;
    [['Engine (your subscription login)', engine], ['Folder', folder], ['What should it do?', message]].forEach(function (p) { var l = el('label', p[0]); l.appendChild(p[1]); main.appendChild(l); });
    main.appendChild(el('p', 'Ask mode: the agent asks before every change or command.', 'note'));
    var start = el('button', 'Start', 'primary'), back = el('button', 'Back'); back.onclick = list;
    start.onclick = function () { if (!message.value.trim() || !folder.value) return; start.disabled = true; api('POST', '/api/agents', { engine: engine.value, folder: folder.value, message: message.value }).then(list, function (e) { note(e.message, 'error'); }); };
    main.appendChild(start); main.appendChild(back);
  }
  if (location.pathname === '/pair') { pair(); return; }
  api('GET', '/api/me').then(function (me) { csrf = me.csrf; who.textContent = me.name; list(); }, function () { note("This phone isn't paired. On your Mac, run /remote on and scan the code."); });
})();
`;
