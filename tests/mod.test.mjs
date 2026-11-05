import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { DEFAULT_TEMPLATE, reviewMessage, templateError, location, checkSummary, prStatus, reviewStatus } from '../mods/pr-review-assist/model.js';

// Execute the actual mod with host boundaries mocked. Never launch or message real agents.
async function harness() {
  const state = { space: 's1', cwd: '/repo', calls: [], values: {}, agents: [], exec: async (cmd) => cmd === 'git' ? { code: 0, stdout: '/repo\n' } : { code: 0, stdout: '[]' } };
  const context = vm.createContext({ console });
  const tree = () => new Proxy({ elements: [], events: {}, elementId: null }, {
    get(o, key) {
      if (key === 'id') return id => { o.elementId = id; return proxy(o); };
      if (key === 'child') return e => { o.elements.push(e); return proxy(o); };
      if (key === 'children') return es => { o.elements.push(...es); return proxy(o); };
      if (key === 'when') return (cond, cb) => { if (cond) cb(proxy(o)); return proxy(o); };
      if (key === 'on_click') return cb => { o.events.click = cb; return proxy(o); };
      if (key in o) return o[key];
      return () => proxy(o);
    }
  });
  function proxy(o) { return new Proxy(o, { get: (_o, key) => key in o ? o[key] : (...args) => {
    if (key === 'child') o.elements.push(args[0]);
    if (key === 'children') o.elements.push(...args[0]);
    if (key === 'when' && args[0]) args[1](proxy(o));
    if (key === 'on_click') o.events.click = args[0];
    if (key === 'id') o.elementId = args[0];
    return proxy(o);
  } }); }
  const textarea = () => ({ text: '', handlers: {}, set_auto_grow() {}, on(event, fn) { this.handlers[event] = fn; }, value() { return this.text; }, set_value(v) { this.text = v; } });
  const modules = new Map();
  function host(name, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [k,v] of Object.entries(exports)) this.setExport(k,v); }, { context });
    modules.set(name, module);
  }
  host('gpui-kit', { View: class {}, div: tree, svg: tree });
  host('gpui-base', { v_flex: tree, h_flex: tree, TextareaState: { new: textarea }, Textarea: { new: tree } });
  host('herdr', {
    agents: () => state.agents, spaces: () => [{ id: state.space, active: true, folder: state.cwd, machine: null }], panes: () => [],
    focused: () => ({ space: state.space, cwd: state.cwd }),
    layout: () => ({ id: 'panel', hidden: false, children: [{ id: 'panel-body', active: 'pr-review-assist' }] }),
    theme: () => ({}), exec: (...args) => state.exec(...args), hc: async args => { state.calls.push(['hc', args]); return state.sendResult ?? { code: 0 }; },
    run: (...args) => state.calls.push(args), shared: key => state.values[key], setShared: (key, value) => state.values[key] = value,
    knownAgents: async () => [{ key: 'codex', name: 'Codex', installed: true, run: ['codex'] }], nextCommand: () => new Promise(() => {}), notify: (...args) => state.calls.push(['notify', ...args])
  });
  const model = new vm.SourceTextModule(await readFile(new URL('../mods/pr-review-assist/model.js', import.meta.url), 'utf8'), { context });
  modules.set('./model.js', model);
  const main = new vm.SourceTextModule(await readFile(new URL('../mods/pr-review-assist/main.js', import.meta.url), 'utf8'), { context });
  await main.link(spec => modules.get(spec)); await main.evaluate();
  const pending = [];
  const cx = { notify() { if (state.rendering) throw new Error("notify during render"); }, stop_propagation() { state.stopped = true; }, open_url(url) { state.url = url; }, focus_handle: () => ({ focus() {} }), timer: { every() {} }, spawn(fn) { const p = fn(cx); pending.push(p); } };
  const mod = new main.namespace.default(); mod.init({}, cx);
  async function flush() { await Promise.all(pending.slice(1)); }
  return { mod, state, cx, flush };
}
const pr = { number: 25, title: 'Fix login', url: 'https://github.com/example/repo/pull/25', author: { login: 'dev' }, headRefName: 'fix', baseRefName: 'main' };
const idle = { address: 't1', space: 's1', status: 'idle', program: { name: 'Codex' }, tab_name: 'Fix login' };
function type(h, value) { h.mod.message.set_value(value); h.mod.message.handlers.change({}, h.cx); }
async function loaded() { const h = await harness(); h.mod.render(h.cx); await h.flush(); h.mod.prs = [pr]; return h; }

test('message substitutes every PR placeholder, preserving literal command characters', () => {
  assert.equal(reviewMessage(DEFAULT_TEMPLATE, 25), 'Review PR 25');
  assert.equal(reviewMessage('Review #{pr_number}\nAgain {pr_number}: `code` $HOME', 7), 'Review #7\nAgain 7: `code` $HOME');
  assert.ok(templateError('Review something')); assert.ok(templateError(' '));
  assert.throws(() => reviewMessage(DEFAULT_TEMPLATE, -1));
});
test('mod panes keep repository context only within their space', () => {
  const last = { space: 's1', cwd: '/old', on: null };
  const p = [{ pane: 'm', terminal: null }];
  assert.equal(location([{ id:'s1', active:true }], p, { pane:'m' }, last), last);
  assert.equal(location([{ id:'s2', active:true, folder:'/new' }], p, { pane:'m' }, last).cwd, '/new');
});
test('repository changes reject a stale PR response', async () => {
  const h = await harness(); let resolve;
  h.state.exec = async cmd => cmd === 'git' ? { code:0, stdout:'/repo' } : new Promise(r => resolve = r);
  h.mod.render(h.cx); await new Promise(r => setImmediate(r));
  h.state.cwd = '/other';
  resolve({ code:0, stdout: JSON.stringify([pr]) }); await h.flush();
  assert.equal(h.mod.prs.length, 0);
});
test('Review stops row propagation and expands the destination chooser', async () => {
  const h = await loaded(); const row = h.mod.row(pr, {});
  const walk = node => node?.elementId === 'review-25' ? node : node?.elements?.map(walk).find(Boolean);
  const button = walk(row); assert.ok(button);
  button.events.click({}, h.cx); await h.flush();
  assert.equal(h.state.stopped, true); assert.equal(h.state.url, undefined);
  assert.equal(h.mod.selected.number, 25); assert.equal(h.mod.choices[0].key, 'codex');
  h.mod.render(h.cx); // Exercise deferred expanded render, beyond herdr-app check.
});
test('row opens the exact GitHub PR URL', async () => {
  const h = await loaded(); const row = h.mod.row(pr, {});
  row.elements[0].events.click({}, h.cx); assert.equal(h.state.url, pr.url);
});
test('existing review uses configured text, exact address, and atomic idle guard', async () => {
  const h = await loaded(); h.state.agents = [idle];
  h.state.values['pr-review-assist.settings'] = { template:'Please review #{pr_number}' };
  h.mod.selected = pr; h.mod.destination = { kind:'existing', address:'t1' };
  h.mod.send(h.cx); h.mod.send(h.cx); await h.flush();
  const sent = h.state.calls.filter(c => c[0] === 'hc');
  assert.equal(sent.length, 1); assert.deepEqual(Array.from(sent[0][1]), ['send','t1','Please review #25','--if','idle','--json']);
});
test('working, blocked, exited, and other-space agents receive no input', async () => {
  for (const a of [{...idle,status:'working'}, {...idle,status:'blocked'}, {...idle,space:'s2'}, null]) {
    const h = await loaded(); h.state.agents = a ? [a] : [];
    h.mod.selected = pr; h.mod.destination = { kind:'existing', address:'t1' }; h.mod.send(h.cx); await h.flush();
    assert.equal(h.state.calls.length, 0); assert.match(h.mod.sendError, /no longer ready/);
  }
});
test('new review targets captured space, repo, chosen program and first task', async () => {
  const h = await loaded(); h.mod.choose(pr, h.cx); await h.flush();
  h.mod.destination = { kind:'new', key:'codex' }; h.mod.send(h.cx);
  const [command,args] = h.state.calls[0]; assert.equal(command, 'tab.new');
  assert.equal(args.space,'s1'); assert.equal(args.folder,'/repo'); assert.equal(args.task,'Review PR 25'); assert.equal(args.argv[0],'codex');
});
test('failed sends retain chooser and surface the error', async () => {
  const h = await loaded(); h.state.agents = [idle]; h.state.sendResult = { code:1, stderr:'Agent became busy' };
  h.mod.selected = pr; h.mod.destination = { kind:'existing', address:'t1' }; h.mod.send(h.cx); await h.flush();
  assert.equal(h.mod.selected.number,25); assert.equal(h.mod.sendError,'Agent became busy'); assert.equal(h.mod.sending,false);
});
test('settings persist valid multiline templates and reject blank/missing placeholders', async () => {
  const h = await loaded(); h.mod.draft = 'Custom {pr_number}\nReport findings'; h.mod.saveSettings(h.cx);
  assert.equal(h.state.values['pr-review-assist.settings'].template, h.mod.draft);
  h.mod.draft = ' '; h.mod.saveSettings(h.cx);
  assert.equal(h.state.values['pr-review-assist.settings'].template, 'Custom {pr_number}\nReport findings');
  h.mod.settingsOpen = true; h.mod.render(h.cx);
});

test('initial render starts refresh without issuing a redraw during render', async () => {
  const h = await harness(); h.state.rendering = true;
  assert.doesNotThrow(() => h.mod.render(h.cx));
  h.state.rendering = false; await h.flush();
  assert.equal(h.mod.loading, false); assert.equal(h.mod.root, '/repo');
});

test('CI counts combine check runs and legacy statuses, prioritizing failures over pending', () => {
  const checks = checkSummary([
    {status:'COMPLETED',conclusion:'SUCCESS'}, {state:'SUCCESS'},
    {status:'COMPLETED',conclusion:'FAILURE'}, {state:'ERROR'},
    {status:'IN_PROGRESS',conclusion:''}, {state:'PENDING'},
    {status:'COMPLETED',conclusion:'SKIPPED'}, {status:'COMPLETED',conclusion:'NEUTRAL'},
  ]);
  assert.deepEqual(checks, { passing:2, failing:2, pending:2, skipped:2, unknown:0, kind:'fail', label:'2 failing · 2 passing · 2 pending · 2 skipped' });
});
test('CI success, pending and empty states get distinct icons without false success', () => {
  assert.equal(checkSummary([{state:'SUCCESS'}]).kind, 'pass');
  assert.equal(checkSummary([{status:'QUEUED'}]).kind, 'pending');
  assert.equal(checkSummary([{state:'EXPECTED'}]).kind, 'pending');
  assert.equal(checkSummary([{conclusion:'SKIPPED',status:'COMPLETED'}]).kind, 'skipped');
  assert.equal(checkSummary([{conclusion:'FUTURE_RESULT',status:'COMPLETED'}]).kind, 'unknown');
  assert.equal(checkSummary([{status:'COMPLETED'}]).kind, 'unknown');
  assert.equal(checkSummary(null).label, 'No CI checks');
  assert.equal(checkSummary([]).kind, 'none');
});
test('cancelled, timed out, stale and action-required checks count as failures', () => {
  for (const conclusion of ['CANCELLED','TIMED_OUT','STALE','ACTION_REQUIRED','STARTUP_FAILURE']) {
    assert.equal(checkSummary([{status:'COMPLETED',conclusion}]).failing,1);
  }
});
test('PR lifecycle and review status are independent', () => {
  assert.equal(prStatus({state:'OPEN'}).label, 'Open');
  assert.equal(prStatus({state:'OPEN',isDraft:true}).label, 'Draft');
  assert.equal(prStatus({state:'MERGED',isDraft:true}).label, 'Merged');
  assert.equal(prStatus({state:'CLOSED'}).label, 'Closed');
  assert.equal(reviewStatus({reviewDecision:'APPROVED'}), 'Approved');
  assert.equal(reviewStatus({reviewDecision:'CHANGES_REQUESTED'}), 'Changes requested');
  assert.equal(reviewStatus({reviewDecision:'REVIEW_REQUIRED'}), 'Review required');
  assert.equal(reviewStatus({reviewDecision:''}), null);
});
test('PR rows render status and CI counts for mixed results', async () => {
  const h = await loaded();
  const row = h.mod.row({...pr,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',statusCheckRollup:[{state:'SUCCESS'},{state:'FAILURE'},{state:'PENDING'}]},{});
  const strings = node => typeof node === 'string' ? [node] : (node?.elements ?? []).flatMap(strings);
  const text = strings(row).join(' ');
  assert.match(text, /Open/); assert.match(text, /Changes requested/);
  assert.match(text, /1 failing · 1 passing · 1 pending/);
});

test('review message can be edited for one PR without changing the template or other PRs', async () => {
  const h = await loaded(); h.state.agents = [idle];
  h.state.values['pr-review-assist.settings'] = { template:'Please review #{pr_number}' };
  const other = { ...pr, number: 26 };
  h.mod.choose(pr, h.cx); await h.flush();
  assert.equal(h.mod.message.value(), 'Please review #25');
  type(h, 'Please review #25, skip the generated files');
  h.mod.choose(other, h.cx); await h.flush();
  assert.equal(h.mod.message.value(), 'Please review #26');
  h.mod.choose(pr, h.cx); await h.flush();
  assert.equal(h.mod.message.value(), 'Please review #25, skip the generated files');
  h.mod.render(h.cx);
  h.mod.destination = { kind:'existing', address:'t1' }; h.mod.send(h.cx); await h.flush();
  const sent = h.state.calls.find(c => c[0] === 'hc');
  assert.equal(sent[1][2], 'Please review #25, skip the generated files');
  assert.equal(h.state.values['pr-review-assist.settings'].template, 'Please review #{pr_number}');
  h.mod.choose(pr, h.cx); await h.flush();
  assert.equal(h.mod.message.value(), 'Please review #25');
});
test('edited message starts a new agent and blank messages are rejected', async () => {
  const h = await loaded(); h.mod.choose(pr, h.cx); await h.flush();
  type(h, '  '); h.mod.destination = { kind:'new', key:'codex' }; h.mod.send(h.cx);
  assert.equal(h.state.calls.length, 0); assert.equal(h.mod.sendError, 'Enter a review message.');
  type(h, 'Only check the migration in PR 25'); h.mod.send(h.cx);
  assert.equal(h.state.calls[0][1].task, 'Only check the migration in PR 25');
});
test('Use template discards the edit, and saving settings updates unedited previews', async () => {
  const h = await loaded(); h.mod.choose(pr, h.cx); await h.flush();
  type(h, 'Custom'); h.mod.resetMessage(h.cx);
  assert.equal(h.mod.message.value(), 'Review PR 25'); assert.equal(h.mod.edits.size, 0);
  h.mod.draft = 'Look at {pr_number}'; h.mod.saveSettings(h.cx);
  assert.equal(h.mod.message.value(), 'Look at 25');
  type(h, 'Custom'); h.mod.draft = 'Again {pr_number}'; h.mod.saveSettings(h.cx);
  assert.equal(h.mod.message.value(), 'Custom');
});
