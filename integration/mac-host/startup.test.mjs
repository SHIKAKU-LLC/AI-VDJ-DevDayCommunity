import test from 'node:test';
import assert from 'node:assert/strict';
import {mountStartup} from './startup.mjs';

function fixture({pairError, ownerError = false} = {}) {
  const fields = new Map(), calls = [], timers = [], events = new Map();
  let healthState, transport;
  const field = id => {
    if (!fields.has(id)) fields.set(id, {disabled: false, hidden: false, textContent: '', value: '', files: [], attrs: {},
      setAttribute(k,v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }});
    return fields.get(id);
  };
  const ui = mountStartup({document: {getElementById: field}, origin: 'http://127.0.0.1:4567',
    lifecycle: {addEventListener: (k,v) => events.set(k,v), removeEventListener: k => events.delete(k)},
    schedule: cb => timers.push(cb),
    healthFactory: options => { healthState = options.onState; return {refresh() {}, dispose() {}}; },
    fetchImpl: async (url,options) => {
      calls.push({url,options});
      if (url === '/api/pair') return new Response(JSON.stringify(pairError ? {code: pairError} : {session: 's'.repeat(43), expiresAt: Date.now()+10000}), {status: pairError ? 403 : 200});
      return new Response('{}', {status: 202});
    },
    connect: ({onEnd}) => (transport = {state: async () => ({phase:'BOOTSTRAP_READY'}),
      pairCloud: async () => calls.push({url:'/api/pair-cloud'}),
      ownerState: async () => { if(ownerError) throw Error(); return {submissions:2}; },
      stop: async () => onEnd(), forget: () => onEnd()})});
  return {field, calls, timers, events, ui,
    state: status => healthState({online:true,status,dropConnection:!status.sessionActive}),
    offline: dropConnection => healthState({online:false,dropConnection}),
    async pair() { this.state({sessionActive:true,bootstrapReady:true}); field('pairing').value = 'synthetic-local-code'; await field('connect').onclick(); }};
}

test('guide has no automatic session or pairing; pending start and unavailable host block actions', async () => {
  const f = fixture(); assert.equal(f.calls.length,0); assert.equal(f.field('connect').disabled,true);
  f.state({sessionActive:false}); assert.equal(f.field('step-1').attrs['aria-current'],'step');
  const pending = f.field('start-session').onclick(); await f.field('start-session').onclick(); await pending;
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].url,'/api/start-session');
  assert.equal(f.field('step-2').attrs['aria-current'],'step'); assert.equal(f.field('connect').disabled,true);
  f.state({sessionActive:true}); assert.equal(f.field('connect').disabled,false);
  f.offline(false); assert.equal(f.field('connect').disabled,true); assert.equal(f.field('start-session').disabled,true);
  assert.equal(f.calls.length,1); f.ui.dispose();
});

test('local and public codes use separate explicit steps; only owner state success marks connection complete', async () => {
  const f = fixture(); await f.pair();
  assert.equal(f.field('pairing').value,''); assert.equal(f.field('step-3').attrs['aria-current'],'step');
  assert.equal(f.field('start-session').hidden,true); assert.equal(f.field('bootstrap').disabled,true);
  assert.equal(f.field('step-1').hidden,true); assert.equal(f.field('step-2').hidden,true);
  await f.field('pair-cloud').onclick(); assert.equal(f.calls.at(-1).url,'/api/pair-cloud');
  assert.match(f.field('status').textContent,/公開画面用コード/); assert.equal(f.field('step-3').attrs['aria-current'],'step');
  assert(!f.field('status').textContent.includes('synthetic-local-code')); assert(!f.field('status').textContent.includes('s'.repeat(43)));
  await f.field('cloud-status').onclick(); assert.match(f.field('next-action').textContent,/接続を確認しました/);
  assert.match(f.field('status').textContent,/生成・自動DJ・再生は未実行/);
  f.timers[0](); assert.equal(f.field('pair-cloud').disabled,true); assert.equal(f.field('session-controls').hidden,true);
  f.state({sessionActive:false,bootstrapReady:false}); assert.equal(f.field('step-1').attrs['aria-current'],'step');
  assert(!f.field('media-status').textContent.includes('完了しています')); f.ui.dispose();
});

test('wrong-origin code explains the destination without displaying secrets or requesting a new session', async () => {
  const f = fixture({pairError:'PAIRING_ORIGIN_MISMATCH'}); await f.pair();
  assert.match(f.field('status').textContent,/公開画面用コードが入力されています/);
  assert.equal(f.field('pair-cloud').disabled,true); assert.equal(f.field('pairing').value,'');
  assert.deepEqual(f.calls.map(c=>c.url),['/api/pair']); f.ui.dispose();
});

test('owner read failure retains local connection and directs public-code-only retry', async () => {
  const f = fixture({ownerError:true}); await f.pair(); await f.field('cloud-status').onclick();
  assert.equal(f.field('step-3').attrs['aria-current'],'step'); assert.equal(f.field('pair-cloud').disabled,false);
  assert.match(f.field('status').textContent,/公開コードだけを再発行/);
  f.offline(true); assert.equal(f.field('pair-cloud').disabled,true);
  assert(!f.field('next-action').textContent.includes('接続を確認しました')); f.ui.dispose();
});

test('cancelling a replacement confirmation preserves existing local connection', async () => {
  const f=fixture();await f.pair();
  await f.field('restart-session').onclick();
  f.state({sessionActive:true,localPaired:true,bootstrapReady:true,confirmationPending:true});
  assert.equal(f.field('restart-session').disabled,true);
  const starts=f.calls.filter(c=>c.url==='/api/start-session').length;
  await f.field('restart-session').onclick();assert.equal(f.calls.filter(c=>c.url==='/api/start-session').length,starts);
  f.state({sessionActive:true,localPaired:true,bootstrapReady:true,confirmationPending:false});
  assert.equal(f.field('pair-cloud').disabled,false);assert.match(f.field('status').textContent,/現在の接続を維持/);
  f.ui.dispose();
});

test('back-forward cache returns to disconnected guide and never restores a credential', async () => {
  const f=fixture();await f.pair();f.events.get('pagehide')();
  assert.equal(f.field('pair-cloud').disabled,true);
  f.events.get('pageshow')({persisted:true});f.state({sessionActive:false,confirmationPending:false});
  assert.equal(f.field('step-1').hidden,false);assert.equal(f.field('step-1').attrs['aria-current'],'step');
  assert.equal(f.calls.filter(c=>c.url==='/api/pair').length,1);f.ui.dispose();
});
