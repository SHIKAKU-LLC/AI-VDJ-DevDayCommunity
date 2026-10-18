import test from 'node:test';
import assert from 'node:assert/strict';
import {readDisplayRoute, videoDescriptor, currentDisplaySet, createDisplayHost, displaySchedule} from '../room-web/judge-display.mjs';

test('display routing persists only a display nonce and survives reload', () => {
  const values = new Map(), paths = [];
  const storage = {getItem: key => values.get(key), setItem: (key,value) => values.set(key,value)};
  const history = {replaceState: (_, __, path) => paths.push(path)};
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(readDisplayRoute({pathname:'/room',hash:'#display='+id}, storage, history), {id});
  assert.deepEqual(readDisplayRoute({pathname:'/room',hash:'#display'}, storage, history), {id});
  assert.equal(values.size,1);
  assert.deepEqual(paths, ['/room#display','/room#display']);
  assert.equal(readDisplayRoute({hash:''},storage,history),null);
  assert.deepEqual(readDisplayRoute({pathname:'/room',hash:'#display=invalid'},storage,history),{id:''});
});

test('descriptor allowlist omits credentials and only accepts same-origin blobs', () => {
  const set={id:'set-1',nickname:'投稿者',kind:'generated',capability:'synthetic-never-forward',assets:{audio:'private'}};
  assert.deepEqual(videoDescriptor(set,'blob:https://example.test/123','https://example.test'),
    {id:'set-1',credit:'投稿者',src:'blob:https://example.test/123'});
  // Construct the rejected scheme without embedding a media payload in source.
  const dataUrl = ['data', 'video/mp4,fixture'].join(':');
  for(const src of ['https://example.test/media','blob:https://other.test/123',dataUrl])
    assert.equal(videoDescriptor(set,src,'https://example.test'),null);
});

test('display switches only on the shared audio boundary and stops extrapolating stale frames', () => {
  const frame={running:true,sentAt:1000,audioTime:11.9,scheduled:[
    {id:'a',start:0,end:12},{id:'b',start:12,end:24},
  ]};
  assert.equal(currentDisplaySet(frame,1050).id,'a');
  assert.equal(currentDisplaySet(frame,1101).id,'b');
  assert.equal(currentDisplaySet({...frame,running:false},1000),null);
  assert.equal(currentDisplaySet(frame,3600),null);
});

test('expired playback history never displaces current and upcoming display media', () => {
  const scheduled = Array.from({length:100},(_,i)=>({id:String(i),start:i*12,end:(i+1)*12}));
  assert.deepEqual(displaySchedule({audioTime:1180,scheduled},id=>({id})).map(s=>s.id),['98','99']);
  assert.deepEqual(displaySchedule(undefined,()=>null),[]);
});

test('opening a display never clones owner storage and ignores inbound control messages', () => {
  const originalLocation=globalThis.location, OriginalChannel=globalThis.BroadcastChannel;
  let instance, closed=false; const sent=[], opened=[];
  globalThis.location={origin:'https://example.test'};
  globalThis.BroadcastChannel=class {constructor(){instance=this;} postMessage(data){sent.push(data);} close(){closed=true;}};
  try {
    const host=createDisplayHost({open:(...args)=>opened.push(args),snapshot:()=>({running:false,audioTime:0,scheduled:[]})});
    host.open();
    assert.equal(opened[0][1],'_blank');
    assert.equal(opened[0][2],'noopener,noreferrer');
    assert.match(opened[0][0],/^https:\/\/example.test\/room#display=[a-f0-9-]{36}$/);
    instance.onmessage({data:{type:'play'}}); assert.equal(sent.length,0);
    instance.onmessage({data:{type:'frame-request'}}); assert.equal(sent.length,1);
    assert.equal(sent[0].type,'frame');
    host.close();assert.equal(closed,true);
  } finally {globalThis.location=originalLocation;globalThis.BroadcastChannel=OriginalChannel;}
});
