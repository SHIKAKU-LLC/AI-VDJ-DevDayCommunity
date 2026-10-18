const LEVEL=.65;

// Measure only the amplitude envelope, not user content. Exclude generated
// intro/outro fades before mixing; do not attempt to restore silence by gain.
export function musicWindow(buffer) {
  const duration=buffer.duration;
  if (!buffer.getChannelData) return {offset:0,end:duration,duration};
  const samples=buffer.getChannelData(0), rate=buffer.sampleRate, hop=Math.max(1,Math.round(rate*.1));
  const energy=[];
  for(let at=0;at<samples.length;at+=hop){
    let sum=0,n=0;
    for(let i=at;i<Math.min(samples.length,at+hop);i+=4){sum+=samples[i]*samples[i];n++;}
    energy.push(Math.sqrt(sum/Math.max(1,n)));
  }
  const sorted=[...energy].sort((a,b)=>a-b), reference=sorted[Math.floor(sorted.length*.7)] ?? 0;
  if(reference<.0001)return {offset:0,end:duration,duration};
  const threshold=reference*.55, edge=Math.min(80,Math.floor(energy.length/4));
  let first=0,last=energy.length-1;
  while(first<edge && energy[first]<threshold)first++;
  while(last>energy.length-1-edge && energy[last]<threshold)last--;
  // Keep one block beyond the threshold to avoid cutting into a kick transient.
  const offset=Math.max(0,(first-1)*.1),end=Math.min(duration,(last+1)*.1);
  return end-offset>=4 ? {offset,end,duration:end-offset} : {offset:0,end:duration,duration};
}

// Independent music transport. Visual changes never call this scheduler.
// Audio-clock overlap plus a bass hand-off avoids an end-to-end silence and
// reduces doubled low-end. A decoded track always remains as a fallback.
export function createSoundtrackPlayer({context,destination=context.destination,onTrack=()=>{},setTimer=setInterval,clearTimer=clearInterval}) {
  const queue=[],seen=new Set(),sources=new Set(),history=[];
  let fallback,current,nextAt=0,running=false,timer,revision=0;
  function add(track) {
    if(!track?.buffer || track.buffer.duration<4 || seen.has(track.id))return;
    seen.add(track.id);queue.push(track);
  }
  function schedule(track,at,first=false) {
    const window=musicWindow(track.buffer),overlap=Math.min(3.428571,window.duration/3),end=at+window.duration;
    const source=context.createBufferSource(),gain=context.createGain(),bass=context.createBiquadFilter();
    source.buffer=track.buffer; bass.type='lowshelf';bass.frequency.value=120;
    source.connect(bass);bass.connect(gain);gain.connect(destination);
    const curve=fadeIn=>Float32Array.from({length:64},(_,i)=>LEVEL*(fadeIn?Math.sin(i/63*Math.PI/2):Math.cos(i/63*Math.PI/2)));
    gain.gain.setValueAtTime(first?LEVEL:0,at);
    if(first){gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(LEVEL,at+.01);}
    if(!first)gain.gain.setValueCurveAtTime(curve(true),at,overlap);
    gain.gain.setValueAtTime(LEVEL,end-overlap);
    gain.gain.setValueCurveAtTime(curve(false),end-overlap,overlap);
    bass.gain.setValueAtTime(first?0:-18,at);
    if(!first){bass.gain.setValueAtTime(-18,at+overlap/2-.025);bass.gain.linearRampToValueAtTime(0,at+overlap/2+.025);}
    bass.gain.setValueAtTime(0,end-overlap);
    bass.gain.setValueAtTime(0,end-overlap/2-.025);
    bass.gain.linearRampToValueAtTime(-18,end-overlap/2+.025);
    source.start(at,window.offset,window.duration);source.stop(end);
    const item={id:track.id,start:at,end,track};sources.add(source);
    source.onended=()=>{sources.delete(source);source.disconnect();gain.disconnect();bass.disconnect();};
    history.push(item);if(history.length>4)history.shift();
    nextAt=end-overlap;current=track;
  }
  function tick() {
    if(!running)return;
    const now=context.currentTime,active=history.findLast(t=>t.start<=now && t.end>now);
    if(active && !active.reported){active.reported=true;onTrack(active.track);}
    if(nextAt-now<4){
      const next=queue.shift()??current??fallback;
      if(next)schedule(next,Math.max(nextAt,now+.02));
    }
  }
  return {
    add,
    setFallback(track){if(track?.buffer && !fallback)fallback=track;},
    start(){
      if(running)return;
      const track=queue.shift()??current??fallback;
      if(!track)throw Error('PLAYBACK_NOT_READY');
      running=true;revision++;schedule(track,context.currentTime+.1,true);timer=setTimer(tick,100);
    },
    stop(){running=false;revision++;clearTimer(timer);for(const s of sources){try{s.stop();}catch{}}sources.clear();history.length=0;nextAt=0;},
    read(){return {running,revision,ready:!!(queue.length||current||fallback),queued:queue.length,
      currentId:history.findLast(t=>t.start<=context.currentTime && t.end>context.currentTime)?.id,
      scheduled:history.map(({id,start,end})=>({id,start,end})),sourceCount:sources.size};},
    tick,
  };
}
