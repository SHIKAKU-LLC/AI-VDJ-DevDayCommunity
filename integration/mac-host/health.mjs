export function createHostHealth({check, onState, schedule = setTimeout, cancel = clearTimeout, intervalMs = 5000}) {
  let ended = false, timer, failures = 0, busy = false;
  async function refresh() {
    if(ended || busy)return;
    busy=true;
    try {
      const status=await check();if(ended)return;
      if(status?.listening!==true || typeof status.sessionActive!=='boolean')throw Error('HOST_STATE_INVALID');
      failures=0;onState({online:true,status,dropConnection:!status.sessionActive});
    } catch {
      if(ended)return;
      failures++;onState({online:false,dropConnection:failures>=2});
    } finally {busy=false;if(!ended)timer=schedule(refresh,intervalMs);}
  }
  void refresh();
  return {refresh,dispose(){ended=true;cancel(timer);}};
}
