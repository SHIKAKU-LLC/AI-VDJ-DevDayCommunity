// Real QR rendering is injected; never send a room link to an external QR service.
export function createJoinProjection({slot,urlLabel,status,allowedOrigin,encodeQr}={}){
 let epoch=0;
 return {async render({joinUrl,accepting,connected}={}){
  const token=++epoch;slot.replaceChildren();urlLabel.textContent='参加URLは未発行です';
  if(!connected||!joinUrl){status.textContent='room API の接続後に実際の URL / QR を表示します。';return false;}
  let url;try{url=new URL(joinUrl);if(url.protocol!=='https:'||url.origin!==allowedOrigin||url.username||url.password||/[?&](?:ownerToken|participantToken|apiKey|key)=/i.test(url.search))throw Error();}catch{status.textContent='参加URLを検証できません。';return false;}
  urlLabel.textContent=url.href;status.textContent=accepting?'スマホで読み取って参加できます。':'受付終了 / 新しい送信は受け付けません。';
  if(typeof encodeQr!=='function'){status.textContent+=' QR renderer は未接続です。URLから参加してください。';return false;}
  const canvas=document.createElement('canvas');canvas.width=canvas.height=280;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','スマートフォン参加用QR');
  try{await encodeQr(canvas,url.href,{margin:4,errorCorrectionLevel:'M'});if(token!==epoch)return false;slot.append(canvas);return true;}catch{if(token===epoch)status.textContent='QRを作成できません。表示したURLから参加してください。';return false;}
 },dispose(){epoch++;slot.replaceChildren();}};
}
