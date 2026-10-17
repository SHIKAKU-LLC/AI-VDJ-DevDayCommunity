// Web Locks arbitrate owner/output windows on one origin. No credentials or storage.
export function createAudioOutputLease({locks = globalThis.navigator?.locks, name = 'ai-vdj-audio-output'} = {}) {
  let current = null, claiming = false;
  return {
    async acquire() {
      if (current?.active) return current;
      if (claiming || !locks?.request) throw Error('EXCLUSIVE_AUDIO_LOCK_UNAVAILABLE');
      claiming = true;
      return new Promise((resolve, reject) => {
        const fail = error => { claiming = false; reject(error); };
        Promise.resolve().then(() => locks.request(name, {mode: 'exclusive', ifAvailable: true}, lock => {
          if (!lock) { fail(Error('OTHER_AUDIO_OUTPUT_ACTIVE')); return; }
          let release;
          const held = new Promise(r => { release = r; });
          const token = {active: true, release() {
            if (!token.active) return;
            token.active = false;
            if (current === token) current = null;
            release();
          }};
          current = token; claiming = false; resolve(token);
          return held;
        })).catch(fail);
      });
    },
    isOwner(token) { return current === token && token?.active === true; },
  };
}
