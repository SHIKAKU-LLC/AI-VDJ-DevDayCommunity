// Test-only event-loop scheduler. Its diagnostic deadline is not a playback
// deadline; actual playback guards and ACK timers remain owned by production.
export async function waitForFixtureProgress({ready, terminal = () => null, describe = () => ({}),
  timeoutMs = 5000, now = () => performance.now(),
  yieldTurn = () => new Promise(resolve => setTimeout(resolve, 1)), label = 'fixture progress'} = {}) {
  const deadline = now() + timeoutMs;
  const failure = (code, terminalCode = null) => Object.assign(new Error(
    `${label} ${terminalCode ? `terminated (${terminalCode})` : 'missed diagnostic deadline'}: ${JSON.stringify(describe())}`),
    {code, terminalCode});
  while (true) {
    // A rejected operation cannot become ready. Do not wait until the deadline
    // just because its UI still shows the previously acknowledged PLAYING cue.
    const ended = terminal();
    if (ended) throw failure('FIXTURE_PROGRESS_TERMINAL', ended.code);
    // A command can arrive before this continuation is descheduled. Observe its
    // actual state before testing the diagnostic clock on the next event turn.
    if (ready()) return;
    if (now() >= deadline) throw failure('FIXTURE_PROGRESS_DEADLINE');
    await yieldTurn();
  }
}
