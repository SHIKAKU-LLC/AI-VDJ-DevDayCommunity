import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import qr from '../room-web/qr-encoder.mjs';
import upstream from '../qa-tools/node_modules/qrcode-generator/dist/qrcode.mjs';
test('vendored local QR matrix matches pinned upstream for an issued-format invitation',()=>{
 const value='https://ai-vdj.vercel.app/join/11111111-1111-4111-a111-111111111111?code='+ 'a'.repeat(64);
 const matrices=[qr,upstream].map(factory=>{const q=factory(0,'M');q.addData(value,'Byte');q.make();return Array.from({length:q.getModuleCount()},(_,y)=>Array.from({length:q.getModuleCount()},(_,x)=>q.isDark(y,x)));});
 assert.deepEqual(matrices[0],matrices[1]);assert.ok(matrices[0].length>21);
});
test('browser room creation keeps local CSP, tab-scoped ownership and one output player',async()=>{
 const html=await readFile(new URL('../room-web/room-entry.html',import.meta.url),'utf8');
 const host=await readFile(new URL('../room-web/room-host.mjs',import.meta.url),'utf8');
 assert.ok(html.includes("connect-src 'self'"));assert.ok(html.includes('id="create-room"'));assert.ok(!html.includes('id="owner-otp"'));assert.ok(html.includes('src="/room-host.mjs"'));
 assert.ok(!html.includes('id="send-link"')&&!html.includes('type="password"'));
 assert.ok(!html.includes('id="scenario"'));assert.ok(!html.includes('src="room-ui.mjs"'));
 assert.ok(!/<audio|<video/i.test(html));assert.ok(!/new Audio|localStorage|document.cookie/.test(host));
 // The owner room session may survive a reload of the same tab only.
 assert.deepEqual([...host.matchAll(/sessionStorage\.(\w+)/g)].map(m=>m[1]).sort(),['getItem','removeItem','setItem']);
 assert.ok(html.includes("frame-src 'self'")&&!html.includes("frame-src 'none'"));assert.ok(html.includes('id="show-stage"'));
 assert.ok(host.includes("location.origin"));assert.ok(host.includes("'X-Room-Owner':raw.ownerToken"));
 assert.ok(host.includes('clearSession();location.reload()'));assert.ok(!/process\.env|Deno\.env/.test(host));
 assert.ok(!host.includes('mountOwnerLinkLogin')&&!host.includes('getBearer()'));
});
