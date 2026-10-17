import {participantInput,LIMITS,completeSet,composerAvailability} from './room-ui-model.mjs';
export function mountRoomComponents({root=document,model,role='participant',designOnly=false,ownerSubmit=null,getDisplayedRequestId=()=>null}={}){
const $=id=>root.querySelector('#'+id),stages={PENDING:'受付済み · 順番待ち',GENERATING:'音楽＋映像を準備中',PARTIAL_READY:'片側完了 · セット準備中',WAIT_REVIEW:'映像確認待ち · 候補にはまだ追加しません',READY:'セット完成 · AI DJ の採用待ち',RESERVED:'接続予約 · まだ再生されていません',PLAYING:'あなたのセットを再生中',PLAYED:'再生を終えました',CLARIFY:'演出の方向確認待ち',UNKNOWN:'結果不明 · 再送せず確認',FAILED:'生成失敗 · 候補には追加されません',CANCELLED:'受付を終了しました',REJECTED:'送信を受け付けられませんでした'};
function view(name){for(const v of ['owner','join','participant','output'])$(`${v}-view`).hidden=v!==name;for(const b of root.querySelectorAll('nav button')){if(b.dataset.view===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}}
for(const b of root.querySelectorAll('[data-view],[data-open]'))b.onclick=()=>view(b.dataset.view??b.dataset.open);
function render(r){
 const sample=r.connected&&!!r.room,collect=(r.room??r.joinInfo)?.mode==='collect',design=designOnly?'設計例 / ':r.room?.mode==='fixture'?'OFFLINE / ':collect?'受付専用 / ':'',displayedRequestId=getDisplayedRequestId(),accepting=r.room?.accepting===true&&r.room.status==='OPEN';
 $('room-state').textContent=sample?`${design}${accepting?'参加者受付中':'参加者受付OFF'}`:r.connected?'接続確認中':'未接続';$('acceptance-label').textContent=sample?(accepting?r.room?.generationPaused?`受付中 / 生成は停止中${designOnly?'（設計例）':''}`:`新しいアイデアを受付中${designOnly?'（設計例）':''}`:`参加者の新しい送信は受付終了${designOnly?'（設計例）':''}`):'受付状態は未接続';
 $('participant-acceptance').textContent=sample?(accepting?'アイデアを送れます。':'このルームは新しいアイデアの受付を終えました。'):r.joinInfo?.accepting?'名前と意図を入力すると、このルームへ参加して受付します。':'このルームはまだ接続されていません。';
 const busy=['SENDING','UNKNOWN','PENDING'].includes(r.operation?.state);
 for(const id of ['accept-on','accept-off','pause-generation','resume-generation'])$(id).disabled=role!=='owner'&&role!=='design'||!sample||!!r.operation?.action&&busy;
 $('accept-on').disabled||=accepting;$('accept-off').disabled||=!accepting;$('pause-generation').disabled||=r.room?.generationPaused===true;$('resume-generation').disabled||=r.room?.generationPaused!==true||collect;for(const id of ['accept-on','accept-off','pause-generation','resume-generation'])$(id).disabled||=!Number.isSafeInteger(r.room?.controlRevision);$('owner-refresh').disabled=!sample;
 const ownerState=composerAvailability(r,{actor:'owner',submitAvailable:!!ownerSubmit&&r.actor==='owner'}),participantState=composerAvailability(r);
 $('owner-generate').disabled=ownerState.disabled;$('owner-generate').textContent=ownerState.label;$('participant-submit').disabled=participantState.disabled;
 $('owner-status').textContent=!ownerSubmit?'実生成の room API は未接続です。入力欄は DJ 画面に残ります。':ownerState.disabled?ownerState.reason:collect?'受付専用です。意図は保存しますが、音楽・映像の生成やDJ再生は未接続です。':ownerState.hold?'生成は停止中です。ownerの入力は受付後、生成再開まで保留します。':!accepting?'参加者受付はOFFです。ownerはセットを送信できます。':'ownerの音楽と16:9映像を一つのセットで受付します。';
 $('participant-submit').textContent=r.operation?.state==='SENDING'?(r.operation.stage==='JOINING'?'参加を確認中・生成未送信':'受付を確認中'):r.operation?.state==='UNKNOWN'?'送信結果不明 · 再送せず確認':r.operation?.state==='PENDING'?(collect?'受付済み · 生成未接続':'受付済み · セット準備待ち'):(collect?'アイデアを受付へ送る（生成未接続）':'音楽＋映像のアイデアを送る');$('status-refresh').disabled=!sample;
 $('request-list').replaceChildren();$('ready-list').replaceChildren();let hasReady=false;
 for(const req of r.requests){
  const row=document.createElement('div');row.className='request-row';const name=document.createElement('strong'),stage=document.createElement('span'),parts=document.createElement('div');name.textContent=req.nickname;stage.className='stage';stage.textContent=collect&&req.state==='PENDING'?'受付済み · 生成未接続':(req.selectionState==='RESERVED'&&req.state==='READY'?stages.RESERVED:stages[req.state])??'状態を確認中';parts.className='parts';parts.textContent=collect?'音楽 未生成 / 映像 未生成':`音楽 ${req.music?.status??'未送信'} / 映像 ${req.video?.status??'未送信'}`;row.append(name,stage,parts);if(req.prompt){const detail=document.createElement('details'),title=document.createElement('summary'),intent=document.createElement('p');title.textContent='演出意図を見る';intent.textContent=req.prompt;detail.append(title,intent);row.append(detail);}if(req.reason){const reason=document.createElement('p');reason.className='muted';reason.textContent=req.reason;row.append(reason);}$('request-list').append(row);
  if(completeSet(req,{allowDesign:designOnly})){hasReady=true;const candidate=document.createElement('div');candidate.className='request-row';candidate.textContent=`${req.nickname} / 音楽＋16:9映像 / AI DJ 待ち`;$('ready-list').append(candidate);}
 }
 if(!r.requests.length)$('request-list').textContent='まだ参加者の送信はありません。';if(!hasReady)$('ready-list').textContent='完成したセットはまだありません。';
 const own=r.requests.find(q=>q.requestId===(r.operation?.requestId??displayedRequestId))??(sample?r.requests[0]:null);
 $('participant-result').textContent=r.operation?.state==='UNKNOWN'?'送信結果が不明です。再送せず「状態を再確認」してください。':own?`${own.nickname} / ${collect&&own.state==='PENDING'?'受付済み · 生成未接続':(own.selectionState==='RESERVED'&&own.state==='READY'?stages.RESERVED:stages[own.state])??'状態確認中'}`:'送信後、あなたのセットの状態がここに表示されます。';
 $('now-title').textContent=own?.state==='PLAYING'? `${own.nickname} のセット${designOnly?'（設計例）':''}`:'演奏状態は未接続';$('now-detail').textContent=own?.state==='PLAYING'?'音楽採用と映像提示の一致を確認しました。':'実再生ackが来るまで、生成状態で NOW を上書きしません。';
 $('next-state').textContent=r.requests.some(q=>q.selectionState==='RESERVED')?`次のセットの接続予約${designOnly?'（表示例）':''}`:hasReady?'完成セットから AI DJ が選びます':'両素材の完成を待っています';
 $('autodj-heading').textContent=collect?'自動DJは未接続':'次のセットは AI DJ が選びます';$('autodj-note').textContent=collect?'受付専用です。音楽・映像の生成、選曲、再生は開始しません。':'両素材の完成後も、実採用までは現在の演奏を継続します。';$('participant-mode-note').textContent=collect?'現在はアイデアの受付だけです。音楽・映像の生成とDJ再生は未接続です。':'完成すると AI DJ の候補になります。再生順や採用は AI DJ が決めます。';
 $('transport-state').textContent='実transport未接続';$('credit-state').textContent='生成枠・24秒セット在庫・費用: room / credit契約の接続待ち';
 $('join-acceptance').textContent=sample?(accepting?'受付中 / 実参加URL・QRの接続を確認してください。':'受付終了 / 新規参加は停止します。'):'room API の接続後に、実際の URL と QR を表示します。';
 const credit=r.overlay;$('nickname-overlay').hidden=!credit;$('overlay-name').textContent=credit?.nickname??'';
 if(r.operation?.action&&r.operation.state==='UNKNOWN')$('acceptance-label').textContent='操作結果不明・GETで状態を確認してください。';if(r.error)$('input-error').textContent=r.error;
}
$('participant-prompt').oninput=()=>{$('prompt-count').textContent=`${Array.from($('participant-prompt').value).length} / ${LIMITS.prompt}文字`;};
$('participant-form').onsubmit=async e=>{e.preventDefault();$('input-error').textContent='';try{participantInput($('nickname').value,$('participant-prompt').value);await model.submit($('nickname').value,$('participant-prompt').value);}catch(e){$('input-error').textContent=({NICKNAME_INVALID:'名前は1〜40文字で入力してください。',PROMPT_INVALID:'演出意図は1〜2000文字で入力してください。',ROOM_NOT_ACCEPTING:'現在は送信を受け付けていません。'})[e.message]??'受付結果を確認してください。';}};
$('status-refresh').onclick=()=>void model.reconcile();$('owner-refresh').onclick=()=>void model.reconcile();for(const[id,action]of [['accept-on','ACCEPT_ON'],['accept-off','ACCEPT_OFF'],['pause-generation','GENERATION_STOP'],['resume-generation','GENERATION_RESUME']])$(id).onclick=()=>void model.ownerControl(action).catch(()=>{});

$('owner-generate').onclick=ownerSubmit?async()=>{try{const available=composerAvailability(model.read(),{actor:'owner',submitAvailable:model.read().actor==='owner'});if(available.disabled)return;const input=participantInput('オーナー',$('owner-prompt').value);await ownerSubmit(input.prompt);}catch(e){$('owner-status').textContent=e.code??e.message;}}:null;
if(role==='participant'){for(const b of root.querySelectorAll('nav button'))b.hidden=b.dataset.view!=='participant';view('participant');}else if(role==='owner')view('owner');
const unsubscribe=model.subscribe(render);return {render,view,dispose:unsubscribe};
}
