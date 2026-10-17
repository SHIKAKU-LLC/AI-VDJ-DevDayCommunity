(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.VDJOutputRenderer=api;
})(globalThis,function(){
  'use strict';
  function fitRect(sw,sh,tw,th,fit='cover'){
    if([sw,sh,tw,th].some(n=>!Number.isFinite(n)||n<=0))return null;
    const scale=(fit==='contain'?Math.min:Math.max)(tw/sw,th/sh),w=sw*scale,h=sh*scale;
    return {x:(tw-w)/2,y:(th-h)/2,width:w,height:h};
  }
  function dimensions(source){return [source?.videoWidth||source?.naturalWidth||source?.width||0,source?.videoHeight||source?.naturalHeight||source?.height||0];}
  function createRenderer(canvas,{createCanvas=()=>document.createElement('canvas')}={}){
    const ctx=canvas.getContext('2d',{alpha:false});let mask=null,overlay=null;
    const metrics={frames:0,clears:0,lastMode:null,lastVersion:null,lastAudioTime:null,lastError:null};
    function clear(){ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);metrics.clears++;}
    function drawFit(context,source,rect,fit="cover"){const [sw,sh]=dimensions(source),r=fitRect(sw,sh,rect.width,rect.height,fit);if(!r)return false;context.drawImage(source,rect.x+r.x,rect.y+r.y,r.width,r.height);return true;}
    function drawOverlay(frame,rect){
      const o=frame.overlay;if(!o?.source||o.opacity<=0)return;
      if(!overlay){overlay=createCanvas();mask=createCanvas();}
      const w=Math.ceil(rect.width),h=Math.ceil(rect.height);if(overlay.width!==w||overlay.height!==h){
        overlay.width=mask.width=w;overlay.height=mask.height=h;
        const m=mask.getContext('2d');m.clearRect(0,0,w,h);
        const horizontal=m.createLinearGradient(0,0,w,0),vertical=m.createLinearGradient(0,0,0,h);
        for(const g of [horizontal,vertical]){g.addColorStop(0,'rgba(0,0,0,1)');g.addColorStop(.14,'rgba(0,0,0,0)');g.addColorStop(.86,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(0,0,0,1)');}
        m.fillStyle=horizontal;m.fillRect(0,0,w,h);m.fillStyle=vertical;m.fillRect(0,0,w,h);
      }
      const layer=overlay.getContext('2d');layer.globalCompositeOperation='source-over';layer.clearRect(0,0,w,h);drawFit(layer,o.source,{x:0,y:0,width:w,height:h});layer.globalCompositeOperation='destination-in';layer.drawImage(mask,0,0);layer.globalCompositeOperation='source-over';
      ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.width,rect.height);ctx.clip();ctx.globalAlpha=Math.min(1,o.opacity);const m=o.transform||[1,0,0,1,0,0];ctx.translate(rect.x+rect.width/2,rect.y+rect.height/2);ctx.transform(m[0],m[1],m[2],m[3],0,0);ctx.drawImage(overlay,-rect.width/2,-rect.height/2,rect.width,rect.height);ctx.restore();
    }
    function paint(frame,{fit='cover'}={}){
      if(!frame||frame.clear){clear();metrics.lastMode=frame?.mode??null;metrics.lastVersion=null;return false;}
      const layers=(frame.layers||[]).filter(l=>l.source&&l.opacity>0&&dimensions(l.source).every(n=>n>0));
      if(!layers.length)return false; // Keep the previous decoded frame while seek/READY is pending.
      const rect=fitRect(frame.width,frame.height,canvas.width,canvas.height,fit);if(!rect)return false;
      clear();let drew=false;
      for(const l of layers){ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.width,rect.height);ctx.clip();ctx.globalAlpha=Math.max(0,Math.min(1,l.opacity));
        const m=l.transform||[1,0,0,1,0,0];ctx.translate(rect.x+rect.width/2,rect.y+rect.height/2);ctx.transform(m[0],m[1],m[2],m[3],m[4]*rect.width/(frame.viewportWidth||frame.width),m[5]*rect.height/(frame.viewportHeight||frame.height));ctx.translate(-rect.width/2,-rect.height/2);
        try{drew=drawFit(ctx,l.source,{x:0,y:0,width:rect.width,height:rect.height},frame.mediaFit||"cover")||drew;}catch{metrics.lastError='source-not-decoded';}ctx.restore();
      }
      try{drawOverlay(frame,rect);}catch{metrics.lastError='overlay-not-decoded';}
      if(drew){metrics.frames++;metrics.lastMode=frame.mode;metrics.lastVersion=frame.version??null;metrics.lastAudioTime=frame.audioTime??null;metrics.lastError=null;}return drew;
    }
    return {paint,clear,getMetrics:()=>({...metrics})};
  }
  return {fitRect,createRenderer};
});
