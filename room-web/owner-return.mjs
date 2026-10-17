import {readOwnerReturn} from './owner-link.mjs';
let message=readOwnerReturn(location.href,location.origin);
// Remove one-time codes/errors/fragments before any asynchronous work or DOM copy.
history.replaceState(null,'','/room/auth-return');
const status=document.getElementById('return-status');let bus=null,timer=null,closed=false;
function done(text){if(closed)return;closed=true;clearTimeout(timer);message=null;bus?.close();bus=null;status.textContent=text;}
if(!message||typeof BroadcastChannel!=='function')done('このリンクは利用できません。元の owner タブからログインを開始してください。');
else{
 bus=new BroadcastChannel('ai-vdj-owner-'+message.state);
 bus.onmessage=event=>{const data=event.data;if(data?.type==='owner-link-result'&&data.state===message?.state&&typeof data.ok==='boolean')done(data.ok?'ログインを確認しました。元の owner タブへ戻ってルームを作成してください。':'ログインを確認できませんでした。元の owner タブからやり直してください。');};
 bus.postMessage(message);timer=setTimeout(()=>done('元のタブで状態を確認してください。タブを閉じた・別ブラウザで開いた・期限切れの場合は、もう一度ログインを開始してください。'),15000);
}
window.addEventListener('pagehide',()=>done('このログイン確認は終了しました。'),{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted)status.textContent='このログイン確認は終了しました。元の owner タブで状態を確認してください。';});
