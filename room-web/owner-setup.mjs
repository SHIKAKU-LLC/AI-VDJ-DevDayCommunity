import {createOwnerSetupModel} from './owner-setup-model.mjs';
const labels={seed:'24秒の初期音声',reference:'参照画像','saved-video':'本人が選んで提供する保存映像（同じ参照画像に対応・19秒以上）'};
const errorCopy={OPERATOR_OUTPUT_REQUIRED:'生成の前に出力で音声を有効にしてください。',OPERATOR_EXISTING_TRIAL:'開始済みの生成があります。その状態を確認してください。',OPERATOR_PRICE_BALANCE_REQUIRED:'直前の価格・残高・自動top-up設定を確認できませんでした。',OPERATOR_BALANCE_REQUIRED:'生成全体の予算に足りる残高を確認できませんでした。',OPERATOR_CONNECTION_NOT_CONFIGURED:'接続先の設定が必要です。',OPERATOR_MEDIA_NOT_CONFIGURED:'private 素材送信先の設定が必要です。',OPERATOR_TRIAL_NOT_CONFIGURED:'生成予算の設定が必要です。',OPERATOR_REFERENCE_FIRST:'先に参照画像を選んでください。',OPERATOR_TWO_PERSON_FIRST:'先に2人の採用結果を確認してください。',OPERATOR_START_UNKNOWN:'開始結果が不明です。同じ生成の状態を確認してください。',OPERATOR_INFRASTRUCTURE_REQUIRED:'worker の配備先と費用上限の確認が必要です。',OPERATOR_SUBMISSIONS_REQUIRED:'選んだ人数分の参加と投稿を待ってから、予算を確認してください。'};
Object.assign(errorCopy,{OPERATOR_BILLING_PERMISSION_REQUIRED:'残高の読取権限を確認できません。管理者に既存認証の確認を依頼してください。',OPERATOR_OPERATIONAL_APPROVAL_REQUIRED:'直前の残高・Auto top-up設定と費用確認の証跡が必要です。',OPERATOR_PRICE_APPROVAL_REQUIRED:'モデル・長さ・解像度に合う価格上限を確認できません。',OPERATOR_SOURCE_ORIGIN_REQUIRED:'初期音声の出自が現在の生成契約に合致しません。管理者に確認してください。',OPERATOR_SOURCE_FIXED:'このセッションの初期音声・参照画像は固定されています。確認済みの素材を保持しました。対応する保存映像を選んでください。'});
export function mountOwnerSetup({container,request,roomId,onState=()=>{}}={}){
 if(!container)throw Error('OPERATOR_VIEW_REQUIRED');
 // Static markup shares the existing panel/button/input styles. No console or
 // deck redesign; anonymous hashes/sizes use textContent only.
 container.innerHTML=`<summary>素材・生成予算</summary><p data-setup-mode class="muted"></p><p data-setup-status role="status" aria-live="polite">準備状態を確認します。</p><button data-reload type="button">準備状態を再確認する</button>
 <p data-connection-state class="muted">未接続</p>
 <div data-media hidden><p>送信先：既存 private bucket <strong>ai-vdj-private</strong>。音声16秒の context と参照画像は生成時に fal へ送信します。提供する保存映像は今回の新規生成とは区別し、サーバーで全体のデコードと技術的なQCを確認します。参照画像との内容の対応は本人が確認してください。</p>
 ${Object.entries(labels).map(([r,l])=>`<label>${l}<input data-file="${r}" type="file" accept="${r==='seed'?'.wav':r==='reference'?'.png,.jpg,.jpeg':'.mp4'}"></label>`).join('')}
 <div data-selections class="muted"></div><label><input data-media-consent type="checkbox">表示した素材と送信先を確認しました（保存映像が表示した参照画像に対応することも確認しました）</label><button data-upload type="button" disabled>選んだ素材を送信する</button><p data-assets class="muted">素材は未送信です。</p></div>
 <div data-trial><label>参加人数<select data-participants><option value="2">まず2人（各1セット）</option><option value="3" disabled>2人の成功後に3人目を追加</option><option value="5" disabled>5人分をまとめて生成（各1セット）</option></select></label><p data-cost-limits></p>
 <button data-review type="button" disabled>生成の予算を確認する</button><p data-budget class="muted">worker の配備先・費用上限と provider の価格確認が未完なら開始できません。</p>
 <label><input data-trial-consent type="checkbox">表示したモデル・本数・予算で開始する</label><div class="button-row"><button data-start type="button" disabled>確認した予算で生成を開始する</button><button data-refresh type="button" disabled>生成状態を確認する</button></div><p data-trial-state role="status">生成は未開始です。</p></div><p data-next class="muted"></p>`;
 const $=selector=>container.querySelector(selector),model=createOwnerSetupModel({request,roomId});let closed=false;
 const draw=s=>{if(closed)return;
 $('[data-setup-mode]').textContent=s.mode==='fixture'?'合成データの確認です。実API・課金・実credential保存は行いません。':'本番設定と本人承認が揃うまで、未接続の操作は開始できません。';
 $('[data-setup-status]').textContent=s.error?(errorCopy[s.error]??'確認できませんでした。入力と設定状態を確認してください。'):s.busy?'確認中です。':s.blockers?.length?'必要な設定が未完です。':'接続・素材・予算を順に確認してください。';
 $('[data-reload]').disabled=s.busy;
 $('[data-media]').hidden=s.serverManaged!==false;
 $('[data-connection-state]').textContent=s.connection?'サーバーの生成準備を確認しました。':'サーバーの生成準備を確認しています。';
 $('[data-selections]').textContent=s.selections.map(x=>`${labels[x.role]} / ${x.byteLength} bytes / SHA-256 ${x.sha256}`).join('\n');
 for(const role of Object.keys(labels))$(`[data-file="${role}"]`).disabled=s.busy||
  role!=='saved-video'&&s.assets.some(a=>a.role===role);
 $('[data-upload]').disabled=s.busy||!s.available.media||!s.selectionComplete||!s.selections.length||!$('[data-media-consent]').checked;
 $('[data-assets]').textContent=s.assets.length?`${s.mode==='fixture'?'合成 ':''}private 保存・hash・QC確認済み：${s.assets.map(a=>labels[a.role]).join('、')}`:'素材は未送信です。';
 const third=$('[data-participants]').querySelector('option[value="3"]');third.disabled=s.trial?.canAddThird!==true;
 const five=$('[data-participants]').querySelector('option[value="5"]');five.disabled=!s.participants?.includes(5);
 if(s.serverManaged&&!$('[data-participants]').querySelector('option[value="1"]')){
  const one=document.createElement('option');one.value='1';one.textContent='1人で試す（1セット）';
  $('[data-participants]').prepend(one);$('[data-participants]').value='1';
 }
 if(s.serverManaged)$('[data-setup-mode]').textContent='素材の準備と生成はサービス側で行います。';
 $('[data-cost-limits]').textContent=s.participants?.includes(5)?'生成費用の上限は1人 $0.50、5人で合計 $2.50です。直前の価格と残高を確認します。':'生成費用の上限は1人 $0.50、2人で $1.00、3人まで合計 $1.50です。直前の価格と残高を確認します。';
 $('[data-participants]').disabled=s.busy;
 if(s.plan?.phase==='REVIEW')$('[data-participants]').value=String(s.plan.participants);
 $('[data-review]').disabled=s.busy||!s.available.trial||!s.connection||!s.assetsComplete||!!s.selections.length;
 $('[data-budget]').textContent=s.plan?`${s.plan.resume?'既存予算内の未完処理を再開。完了/UNKNOWNのPOSTは再送しません。 ':''}${s.plan.participants}人まで / 今回の追加${s.plan.newParticipants}人 / provider計最大 $${(s.plan.maximumCents/100).toFixed(2)} / infrastructure最大 $${s.plan.infrastructureMaximumUsd}。モデル：Gemini 2.5 Flash Lite / Stable Audio 3 Medium / H3 Max。今回の本数：intent ${s.plan.counts.intent}、音声24秒 ${s.plan.counts.music}、映像5秒/480P ${s.plan.counts.video}。`:'worker の配備先・費用上限と provider の価格確認が未完なら開始できません。';
 $('[data-start]').textContent=s.plan?.resume?'確認済み予算の処理を再開':'確認した予算で生成を開始する';
 $('[data-start]').disabled=s.busy||s.plan?.phase!=='REVIEW'||!$('[data-trial-consent]').checked;
 $('[data-refresh]').disabled=s.busy||!s.trial?.planId;
 $('[data-trial-state]').textContent=s.trial?`${s.mode==='fixture'?'合成 ':''}${s.trial.phase==='STARTED'?'開始要求を受付済み':s.trial.phase==='UNKNOWN'?'開始結果は不明':'状態確認済み'}。採用確認 ${s.trial.completedParticipants??0}人。`:'生成は未開始です。';
 $('[data-next]').textContent='次の1操作：'+(s.error?.endsWith('_NOT_CONFIGURED')?'管理者に未完の接続・送信・生成設定を依頼してください。':s.nextAction?.label??'準備状態を確認してください。');onState(s);};
 const unsubscribe=model.subscribe(draw),quiet=promise=>{void promise.catch(()=>{});};
 for(const role of Object.keys(labels))$(`[data-file="${role}"]`).onchange=e=>{const file=e.target.files?.[0];$('[data-media-consent]').checked=false;$('[data-trial-consent]').checked=false;if(file)quiet(model.select({role,file}));};
 $('[data-media-consent]').onchange=()=>draw(model.snapshot());$('[data-trial-consent]').onchange=()=>draw(model.snapshot());
 $('[data-participants]').onchange=()=>{$('[data-trial-consent]').checked=false;model.changeParticipants();};
 $('[data-upload]').onclick=()=>{if(!$('[data-upload]').disabled)quiet(model.upload($('[data-media-consent]').checked));};
 $('[data-review]').onclick=()=>{if(!$('[data-review]').disabled){$('[data-trial-consent]').checked=false;quiet(model.prepare(Number($('[data-participants]').value)));}};
 $('[data-start]').onclick=()=>{if(!$('[data-start]').disabled){const consent=$('[data-trial-consent]').checked;$('[data-trial-consent]').checked=false;quiet(model.start(consent));}};
 $('[data-refresh]').onclick=()=>quiet(model.refresh());$('[data-reload]').onclick=()=>quiet(model.load());quiet(model.load());
 return Object.freeze({model,dispose(){closed=true;unsubscribe();model.dispose();for(const role of Object.keys(labels))$(`[data-file="${role}"]`).value='';container.replaceChildren();}});
}
