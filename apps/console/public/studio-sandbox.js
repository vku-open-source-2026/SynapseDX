// SPDX-License-Identifier: Apache-2.0
// Only this trusted bootstrap has DOM access. Authored JS runs in a worker.
(() => {
  'use strict';
  let channel, worker, lastBeat = Date.now(), started = false, logs = 0;
  const pending = new Set();
  const send = (type, payload = {}) => parent.postMessage({ channel, type, ...payload }, '*');
  const root = document.getElementById('root');
  const tags = new Set('DIV SPAN P H1 H2 H3 H4 H5 H6 BUTTON UL OL LI TABLE THEAD TBODY TFOOT TR TH TD INPUT SELECT OPTION LABEL TEXTAREA STRONG EM SMALL SECTION ARTICLE HEADER FOOTER NAV MAIN BR HR PRE CODE PROGRESS METER DETAILS SUMMARY'.split(' '));
  const attrs = new Set('id class title type value name placeholder disabled checked selected min max step rows cols role tabindex aria-label aria-live data-event'.split(' '));
  function render(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html).slice(0, 65536);
    let nodes = 0;
    function copy(node, depth = 0) {
      if (++nodes > 2000 || depth > 40) return document.createTextNode('');
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE || !tags.has(node.tagName)) return document.createTextNode('');
      const out = document.createElement(node.tagName.toLowerCase());
      for (const attr of node.attributes) if (attrs.has(attr.name) && attr.value.length <= 2000) out.setAttribute(attr.name, attr.value);
      for (const child of node.childNodes) out.appendChild(copy(child, depth + 1));
      return out;
    }
    root.replaceChildren(...Array.from(template.content.childNodes).map(node => copy(node)));
  }
  function stop(message) {
    worker?.terminate(); worker = null;
    for (const id of pending) send('cancel', { id });
    pending.clear();
    if (message) send('log', { level: 'error', message });
  }
  // Serialized into a blob worker. It never has access to window, DOM,
  // cookies, storage or the parent session. Network is denied by response CSP.
  function isolatedWorker() {
    let seq = 0;
    const calls = new Map(), handlers = new Map();
    const emit = self.postMessage.bind(self);
    function log(level, args) {
      let message;
      try { message = args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); } catch { message = '[unserializable value]'; }
      emit({ type: 'log', level, message: message.slice(0, 4000) });
    }
    const console = Object.fromEntries(['log','info','warn','error'].map(level => [level, (...args) => log(level, args)]));
    const rpc = (kind, widgetId, values) => new Promise((resolve, reject) => {
      if (calls.size >= 10) return reject(new Error('Too many pending calls'));
      const id = String(++seq);
      const timer = setTimeout(() => { calls.delete(id); reject(new Error('Studio call timed out')); }, 60000);
      calls.set(id, { resolve, reject, timer }); emit({ type: 'request', id, kind, widgetId, values });
    });
    const studio = Object.freeze({
      result: value => {
        const json = JSON.stringify(value);
        if (json === undefined || json.length > 20000) throw new Error('Action result must be JSON within 20000 characters');
        emit({ type: 'result', value: JSON.parse(json) });
      },
      query: (id, query = {}) => rpc('query', id, query),
      action: (id, values = {}) => rpc('action', id, values),
      render: html => emit({ type: 'render', html: String(html).slice(0, 65536) }),
      on: (name, fn) => { if (typeof name !== 'string' || typeof fn !== 'function') throw new Error('Use studio.on(eventName, callback)'); handlers.set(name, fn); },
    });
    setInterval(() => emit({ type: 'heartbeat' }), 500);
    self.onmessage = async ({ data }) => {
      try {
        if (data.type === 'run') {
          const run = new Function('studio', 'console', '"use strict"; return (async () => {\n' + data.source + '\n})();');
          await run(studio, console); emit({ type: 'ready' });
        } else if (data.type === 'event') {
          const handler = handlers.get(data.name);
          if (handler) await handler(Object.freeze(data.event));
        } else if (data.type === 'response') {
          const call = calls.get(data.id); if (!call) return;
          clearTimeout(call.timer); calls.delete(data.id);
          if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
        }
      } catch (error) { console.error(error?.stack || String(error)); }
    };
  }
  window.addEventListener('message', ({ source, data }) => {
    if (source !== parent || !data || typeof data !== 'object') return;
    if (data.type === 'init' && !started) {
      started = true; channel = data.channel;
      const style = document.createElement('style');
      style.textContent = 'body{margin:0;padding:16px;font:14px system-ui;color:#182637;background:#fff}button,input,select,textarea{font:inherit}button{cursor:pointer}' + String(data.code.css).slice(0,32768);
      document.head.appendChild(style); render(data.code.html);
      const url = URL.createObjectURL(new Blob(['(' + isolatedWorker.toString() + ')()'], { type: 'text/javascript' }));
      worker = new Worker(url); URL.revokeObjectURL(url);
      let count = 0, windowStart = Date.now();
      worker.onmessage = ({ data: m }) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'heartbeat') { lastBeat = Date.now(); return; }
        if (Date.now() - windowStart > 60000) { count = 0; windowStart = Date.now(); }
        if (++count > 500) { stop('Component message limit exceeded'); return; }
        if (m.type === 'render') render(m.html);
        if (m.type === 'log' && logs++ < 100) send('log', { level: ['log','info','warn','error'].includes(m.level) ? m.level : 'log', message: String(m.message).slice(0,4000) });
        if (m.type === 'ready') send('ready');
        if (m.type === 'result') {
          // The size cap stays: oversized or unserializable results are
          // dropped, but the Studio log must say so instead of silence (#89).
          try {
            if (JSON.stringify(m.value).length <= 20000) send('result', { value: m.value });
            else send('log', { level: 'warn', message: 'result dropped: exceeds 20000 chars or not serializable' });
          } catch {
            send('log', { level: 'warn', message: 'result dropped: exceeds 20000 chars or not serializable' });
          }
        }
        if (m.type === 'request') {
          if (pending.size >= 10 || typeof m.id !== 'string' || m.id.length > 20) return;
          let size; try { size = JSON.stringify(m.values || {}).length; } catch { return; }
          if (!['query','action'].includes(m.kind) || typeof m.widgetId !== 'string' || size > 20000) return;
          pending.add(m.id); send('request', { id: m.id, kind: m.kind, widgetId: m.widgetId, values: m.values });
        }
      };
      worker.onerror = e => { send('log', { level: 'error', message: e.message || 'Worker failed' }); stop(); };
      worker.postMessage({ type: 'run', source: String(data.code.javascript).slice(0,32768) });
    } else if (data.channel === channel && data.type === 'response' && pending.has(data.id)) {
      pending.delete(data.id); worker?.postMessage({ type: 'response', id: data.id, result: data.result, error: data.error });
    } else if (data.channel === channel && data.type === 'stop') stop();
  });
  for (const type of ['click','change','input','submit']) root.addEventListener(type, event => {
    if (type === 'submit') event.preventDefault();
    const target = event.target.closest('[data-event]');
    if (!target || (type === 'click' && !['BUTTON','SUMMARY'].includes(target.tagName))) return;
    worker?.postMessage({ type: 'event', name: target.dataset.event, event: { type, value: String(target.value || '').slice(0,10000), checked: !!target.checked, id: target.id } });
  });
  setInterval(() => { if (worker && Date.now() - lastBeat > 5000) stop('JavaScript exceeded the 5-second execution limit. Fix the loop and run again.'); }, 1000);
})();
