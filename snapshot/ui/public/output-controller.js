(function(){
  'use strict';
  const byId=id=>document.getElementById(id),main=document.querySelector('main'),surface=byId('immersive-stage'),canvas=byId('immersive-canvas');
  const renderer=VDJOutputRenderer.createRenderer(canvas);
  let output=null,local=false,localRaf=null,hadFullscreen=false,returnFocus=null;
  function report(message,state='idle'){if(state==='closed'){const r=window.VDJLive?.read();const playing=r?.active&&r.contextState==='running'&&r.telemetry?.consumedFrames>0&&!r.telemetry?.stopped;message=playing?'映像出力を閉じました。音楽はconsoleで再生中です。':'映像出力を閉じました。'+(r?.stopped?'演奏は停止しています。':'演奏は未開始です。');}byId('projection-status').textContent=message;byId('projection-status').dataset.state=state;byId('projection-focus').disabled=state==='closed'||!output||output.closed;byId('projection-fullscreen').disabled=state==='closed'||!output||output.closed;}
  function getFit(){return byId('projection-fit').value;}
  function openOutput(){
    if(output&&!output.closed){output.focus();report('出力ウィンドウを表示。音声はconsoleの1系統のみ。','windowed');return;}
    output=window.open('output.html','AI_VDJ_Projection','popup=yes,width=1280,height=720');
    if(!output||output.closed){output=null;report('別ウィンドウがブロックされました。このサイトのポップアップを許可するか「この画面で没入」を使ってください。','blocked');return;}
    report('映像専用出力を開いています。出力画面をダブルクリックで全画面。','opening');
  }
  function focusOutput(){if(!output||output.closed){openOutput();return;}try{output.focus();}catch{} }
  async function requestOutputFullscreen(){if(!output||output.closed)return;try{await output.VDJOutputPage?.enterFullscreen();}catch{report('全画面要求を利用できません。出力画面をダブルクリックしてください。','windowed');}focusOutput();}
  function localFrame(){if(!local)return;const profile=window.VDJDisplayConfig,dpr=Math.min(2,devicePixelRatio||1),width=profile?.width||Math.max(1,Math.round(innerWidth*dpr)),height=profile?.height||Math.max(1,Math.round(innerHeight*dpr));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}if(profile){const scale=Math.min(innerWidth/width,innerHeight/height);Object.assign(canvas.style,{position:"absolute",width:width*scale+"px",height:height*scale+"px",left:(innerWidth-width*scale)/2+"px",top:(innerHeight-height*scale)/2+"px"});}renderer.paint(window.VDJFrameSource?.read(),{fit:getFit()});localRaf=requestAnimationFrame(localFrame);}
  async function leaveLocal(){if(!local)return;local=false;if(localRaf!==null)cancelAnimationFrame(localRaf);localRaf=null;surface.hidden=true;main.inert=false;document.body.classList.remove('immersive');try{if(document.fullscreenElement)await document.exitFullscreen();}catch{}returnFocus?.focus();const r=window.VDJLive?.read();const playing=r?.active&&r.contextState==='running'&&r.telemetry?.consumedFrames>0&&!r.telemetry?.stopped;report('consoleへ戻りました。'+(playing?'音楽は再生中です。':r?.stopped?'演奏は停止しています。':'演奏は未開始です。'),'console');}
  async function enterLocal(){returnFocus=document.activeElement;local=true;hadFullscreen=false;surface.hidden=false;main.inert=true;document.body.classList.add('immersive');canvas.focus();localFrame();try{if(canvas.requestFullscreen){await canvas.requestFullscreen();hadFullscreen=true;}else throw new Error('unsupported');}catch{report('ブラウザ全画面は利用できません。画面内の没入表示で継続。Escまたはタップでconsoleへ戻れます。','immersive-windowed');}}
  byId('projection-open').addEventListener('click',openOutput);byId('projection-focus').addEventListener('click',focusOutput);byId('projection-fullscreen').addEventListener('click',requestOutputFullscreen);byId('projection-local').addEventListener('click',enterLocal);
  canvas.addEventListener('click',leaveLocal);canvas.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();leaveLocal();}if(event.key==='Tab')event.preventDefault();});
  document.addEventListener('fullscreenchange',()=>{if(local&&hadFullscreen&&!document.fullscreenElement)leaveLocal();});
  const poll=setInterval(()=>{if(output&&output.closed){output=null;report('出力ウィンドウを閉じました。再生は継続。「別ウィンドウへ出力」で再表示できます。','closed');}},500);
  window.VDJProjectionController={report,getFit,getState:()=>({open:!!output&&!output.closed,local,fit:getFit(),localFullscreen:document.fullscreenElement===canvas,localMetrics:renderer.getMetrics()})};
  window.addEventListener('pagehide',()=>{clearInterval(poll);local=false;if(localRaf!==null)cancelAnimationFrame(localRaf);try{output?.close();}catch{}},{once:true});
  report('音声はconsoleのみ。別画面は映像専用。出力のダブルクリックで全画面、Escで解除、Cでconsoleへ。');
})();
