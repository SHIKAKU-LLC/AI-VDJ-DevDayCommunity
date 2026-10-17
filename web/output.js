const button=document.querySelector('button');
document.addEventListener('fullscreenchange',()=>{button.textContent=document.fullscreenElement?'全画面を終了':'全画面';});
button.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.body.requestFullscreen();}catch{button.textContent='全画面を開始できません / 再試行';}};
