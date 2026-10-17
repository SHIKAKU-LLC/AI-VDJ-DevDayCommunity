import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(a, b);

// Memory-only pairing and session credentials. This is not a persistent account.
export function createSessionGate({origins, now = Date.now, lifetimeMs = 30 * 60_000,
  pairingLifetimeMs = 120_000, onExpire = () => {}}) {
  if (!Array.isArray(origins) || !origins.length || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 60 * 60_000 ||
      !Number.isSafeInteger(pairingLifetimeMs) || pairingLifetimeMs < 1000 || pairingLifetimeMs > 120_000)
    throw Error('SESSION_CONFIGURATION_REQUIRED');
  const allowed = new Set(origins), expiresAt = now() + lifetimeMs;
  let ended = false, failures = 0; const pairs = new Map(), credentials = [];
  const active = () => {
    if (!ended && now() >= expiresAt) { ended = true; pairs.clear(); credentials.length = 0; onExpire(); }
    return !ended;
  };
  return {
    issue(origin) {
      if (!active() || !allowed.has(origin)) throw Error('PAIRING_ORIGIN_REFUSED');
      const code = randomBytes(24).toString('base64url');
      pairs.set(digest(code).toString('hex'), {origin, until: Math.min(expiresAt, now() + pairingLifetimeMs)});
      return {code, expiresAt: Math.min(expiresAt, now() + pairingLifetimeMs)};
    },
    exchange(origin, code) {
      if (!active()) throw Error('PAIRING_SESSION_ENDED');
      if (!allowed.has(origin)) throw Error('PAIRING_ORIGIN_REFUSED');
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code.trim())) throw Error('PAIRING_INPUT_INVALID');
      if (failures >= 8) throw Error('PAIRING_LIMIT');
      code=code.trim();
      const key = digest(code).toString('hex'), entry = pairs.get(key);
      if (!entry) { failures++; throw Error('PAIRING_UNKNOWN'); }
      if (entry.origin !== origin) { failures++; throw Error('PAIRING_ORIGIN_MISMATCH'); }
      if (entry.used) { failures++; throw Error('PAIRING_USED'); }
      if (now() >= entry.until) { failures++; throw Error('PAIRING_EXPIRED'); }
      entry.used=true;
      const value = randomBytes(32).toString('base64url'); credentials.push({origin, hash: digest(value)});
      return {session: value, expiresAt};
    },
    verify(origin, value) {
      if (!active() || !allowed.has(origin) || typeof value !== 'string' || value.length > 100) return false;
      const hash = digest(value);
      return credentials.some(entry => entry.origin === origin && equal(entry.hash, hash));
    },
    read: () => ({active: active(), expiresAt,pairedOrigins:credentials.map(c=>c.origin)}),
    close() { ended = true; pairs.clear(); credentials.length = 0; },
  };
}
