import {spawn} from 'node:child_process';

// One explicitly started process, in its own OS session. No service registration,
// login item, restart policy, shell or inherited terminal/stdio handles.
export function startIndependentProcess({entry, args = [], env = process.env, timeoutMs = 15000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
    });
    let settled = false;
    const finish = (error, ready) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.removeListener('message', message); child.removeListener('error', failed); child.removeListener('exit', exited);
      if (child.connected) child.disconnect();
      if (error) { child.kill('SIGTERM'); reject(Error(error)); }
      else { child.unref(); resolve(ready); }
    };
    const message = data => {
      if (data?.type === 'ready' && Number.isSafeInteger(data.pid) && data.pid === child.pid &&
          typeof data.origin === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(data.origin))
        finish(null, {pid: data.pid, origin: data.origin});
      else if (data?.type === 'failed') finish('MAC_HOST_START_FAILED');
    };
    const failed = () => finish('MAC_HOST_START_FAILED');
    const exited = () => finish('MAC_HOST_EXITED_BEFORE_READY');
    const timer = setTimeout(() => finish('MAC_HOST_START_TIMEOUT'), timeoutMs);
    child.on('message', message); child.once('error', failed); child.once('exit', exited);
  });
}
