(function(){
  'use strict';
  const canvas=document.getElementById('projection'),renderer=VDJOutputRenderer.createRenderer(canvas);
  let owner=null,raf=null,stopped=false,fullscreenRejected=false;
  try{if(window.opener&&!window.opener.closed&&window.opener.location.origin===location.origin)owner=window.opener;}catch{}
  function resize(){const profile=owner?.VDJDisplayConfig,ratio=Math.min(2,devicePixelRatio||1),width=profile?.width||Math.max(1,Math.round(innerWidth*ratio)),height=profile?.height||Math.max(1,Math.round(innerHeight*ratio));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}if(profile){const scale=Math.min(innerWidth/width,innerHeight/height);Object.assign(canvas.style,{position:"absolute",width:width*scale+"px",height:height*scale+"px",left:(innerWidth-width*scale)/2+"px",top:(innerHeight-height*scale)/2+"px"});}}
  function report(message,state){try{owner?.VDJProjectionController?.report(message,state);}catch{}}
  function paint(){if(stopped)return;resize();try{if(!owner||owner.closed){renderer.clear();}else{owner.VDJFrameSource?.tickHidden();renderer.paint(owner.VDJFrameSource?.read(),{fit:owner.VDJProjectionController?.getFit()||'cover'});}}catch{renderer.clear();report('出力の接続を確認してください。consoleから開き直せます。','error');}raf=requestAnimationFrame(paint);}
  async function enterFullscreen(){try{if(!document.fullscreenElement){if(!canvas.requestFullscreen)throw new Error('unsupported');await canvas.requestFullscreen();}fullscreenRejected=false;report('映像専用出力 / 全画面。Escで解除、Cでconsoleへ。','fullscreen');return true;}catch{fullscreenRejected=true;report('全画面を利用できません。出力画面をダブルクリック、または通常ウィンドウを最大化してください。映像は継続します。','windowed');return false;}}
  async function toConsole(){try{if(document.fullscreenElement)await document.exitFullscreen();}catch{}try{owner?.focus();}catch{}}
  canvas.addEventListener('dblclick',enterFullscreen);
  document.addEventListener('keydown',event=>{if(event.key.toLowerCase()==='f'){event.preventDefault();enterFullscreen();}if(event.key.toLowerCase()==='c'){event.preventDefault();toConsole();}});
  document.addEventListener('fullscreenchange',()=>report(document.fullscreenElement?'映像専用出力 / 全画面。Escで解除、Cでconsoleへ。':'映像専用出力 / ウィンドウ。ダブルクリックで全画面、Cでconsoleへ。',document.fullscreenElement?'fullscreen':'windowed'));
  window.addEventListener('resize',resize);window.addEventListener('pagehide',()=>{stopped=true;if(raf!==null)cancelAnimationFrame(raf);report('出力ウィンドウを閉じました。音楽とconsole再生は継続。','closed');});
  window.VDJOutputPage={enterFullscreen,toConsole,getState:()=>({width:canvas.width,height:canvas.height,fullscreen:!!document.fullscreenElement,fullscreenRejected,hasOwner:!!owner,audioElements:document.querySelectorAll('audio,video').length,...renderer.getMetrics()})};
  report('映像専用出力 / ウィンドウ。ダブルクリックで全画面、Cでconsoleへ。','windowed');paint();canvas.focus();
})();
