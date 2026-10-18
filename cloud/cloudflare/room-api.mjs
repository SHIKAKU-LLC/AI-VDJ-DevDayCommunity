import {hydrateJournal} from './submission-records.mjs';
const clock = "cast(unixepoch('subsec')*1000 as integer)";
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const token = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const fail = code => { throw Error(code); };
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

// D1 owns the journal. A version-checked write includes its receipt so a lost
// response can be recovered without repeating a submission or a control action.
export function createD1RoomRpc({db, eventId, maximumParticipants = 64, maximumSubmissions = 100, normalized = false} = {}) {
  if (!db?.prepare || !/^judge-[a-z0-9-]{1,60}$/.test(eventId ?? '')) fail('ROOM_BACKEND_UNAVAILABLE');
  const journalKeys = new WeakMap();
  const connection = db.withSession ? db.withSession('first-primary') : db;
  const query = (sql, ...values) => connection.prepare(sql).bind(...values);
  async function load(roomId) {
    if (!uuid(roomId)) fail('ROOM_NOT_FOUND');
    const row = await query(`select r.*,${clock} as clock_ms from vdj_rooms r join vdj_events e on e.id=r.event_id
      where r.id=? and r.event_id=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}`, roomId, eventId).first();
    if (!row) fail('ROOM_NOT_FOUND');
    const document = JSON.parse(row.document);
    if (normalized) { await hydrateJournal(connection, roomId, document); journalKeys.set(document,{submissions:new Set(document.submissions.map(s=>s.submissionId)),operations:new Set(Object.keys(document.operations))}); }
    document.members ??= [];
    document.operations ??= {};
    return {row, document};
  }
  function actor(row, document, proof) {
    if (row.owner_proof === proof) return {owner: true, id: 'owner', proof};
    const member = document.members.find(value => value.proof === proof);
    if (!member) fail('ACTOR_DENIED');
    return {owner: false, id: member.id, nickname: member.nickname, proof};
  }
  function snapshot(row, document, who) {
    const {epoch: sessionId} = row;
    return {roomId: row.id, sessionId, expiresAtMs: row.expires_at_ms,
      mode: 'collect', eventSeq: document.eventSeq, controlRevision: document.controlRevision,
      closed: document.closed, accepting: document.accepting, generationPaused: true, autoDJ: false,
      playbackAdapterAvailable: false, currentCredit: null, cues: [],
      participants: document.members.filter(value => who.owner || value.id === who.id)
        .map(({id: participantId, nickname}) => ({participantId, nickname})),
      submissions: document.submissions.filter(value => who.owner || value.participantId === who.id)
        .map(value => ({...value}))};
  }
  async function write(row, document) {
    const serialized = JSON.stringify(normalized ? {...document, submissions: [], operations: {}} : document);
    if (normalized) {
      const known=journalKeys.get(document);
      const condition = 'exists(select 1 from vdj_rooms where id=? and version=?)';
      const records = [
        ...document.submissions.filter(s=>!known.submissions.has(s.submissionId)).map(s => query(`insert or ignore into vdj_submissions select ?,?,?,?,? where ${condition}`, row.id,s.submissionId,s.participantId,s.createdAtMs ?? 0,JSON.stringify(s),row.id,row.version)),
        ...Object.entries(document.operations).filter(([key])=>!known.operations.has(key)).map(([key,op]) => query(`insert or ignore into vdj_operations select ?,?,?,?,? where ${condition}`,row.id,key,op.actor,op.atMs,JSON.stringify(op),row.id,row.version)),
        query(`update vdj_rooms set document=?,version=version+1 where id=? and event_id=? and version=? and expires_at_ms>${clock} and exists(select 1 from vdj_events where id=? and enabled=1 and expires_at_ms>${clock})`,serialized,row.id,eventId,row.version,eventId),
      ];
      const result = await connection.batch(records);
      return result.at(-1).meta.changes === 1;
    }
    if (new TextEncoder().encode(serialized).length > 65536) fail('ROOM_OPERATION_CAP');
    const result = await query(`update vdj_rooms set document=?,version=version+1
      where id=? and event_id=? and version=? and expires_at_ms>${clock}
      and exists(select 1 from vdj_events e where e.id=? and e.enabled=1 and e.expires_at_ms>${clock})`,
    serialized, row.id, eventId, row.version, eventId).run();
    return result.meta.changes === 1;
  }
  return async function rpc({op, room_id: roomId, capability, payload = {}}) {
    if (!token(capability)) fail('ACTOR_DENIED');
    const proof = await digest(capability);
    const operationDigest = await digest(JSON.stringify({op, payload}));
    for (let attempt = 0; attempt < 4; attempt++) {
      const {row, document} = await load(roomId);
      const {epoch: sessionId} = row;
      if (op === 'joinInfo' || op === 'join') {
        if (proof !== row.join_proof) fail('INVITE_DENIED');
        if (op === 'joinInfo') return {roomId, sessionId, accepting: document.accepting, expiresAtMs: row.expires_at_ms};
        if (!document.accepting || document.closed) fail('ACCEPTANCE_OFF');
        if (!token(payload.participantCapability)) fail('CAPABILITY_INVALID');
        if (document.members.length >= maximumParticipants) fail('PARTICIPANT_CAP');
        const member = {id: crypto.randomUUID(), nickname: payload.nickname, proof: await digest(payload.participantCapability)};
        document.members.push(member);
        document.eventSeq++;
        if (await write(row, document)) return {roomId, sessionId, participantId: member.id, participantToken: payload.participantCapability};
        continue;
      }
      const who = actor(row, document, proof);
      const operationKey = who.id + ':' + payload.nonce;
      if (op === 'read') return snapshot(row, document, who);
      if (op === 'submission') {
        const value = document.submissions.find(value => value.submissionId === payload.submissionId && (who.owner || value.participantId === who.id));
        if (!value) fail('OPERATION_NOT_FOUND');
        return {...value};
      }
      if (op === 'events') return {roomId, sessionId, eventSeq: document.eventSeq, events: [], snapshot: snapshot(row, document, who)};
      if (op === 'operation') {
        if (!nonce(payload.nonce)) fail('NONCE_INVALID');
        const saved = document.operations[operationKey];
        if (!saved || saved.actor !== proof) fail('OPERATION_NOT_FOUND');
        return structuredClone(saved.envelope);
      }
      if (!['submit', 'control'].includes(op)) fail('ROUTE_NOT_FOUND');
      if (!nonce(payload.nonce)) fail('NONCE_INVALID');
      const saved = document.operations[operationKey];
      if (saved) {
        if (saved.actor !== proof || saved.digest !== operationDigest) fail('NONCE_CONFLICT');
        return structuredClone(saved.envelope.receipt);
      }
      if (!normalized && Object.keys(document.operations).length >= 120) fail('ROOM_OPERATION_CAP');
      if (Object.values(document.operations).filter(value => value.actor === proof && value.atMs > row.clock_ms - 60000).length >= 6) fail('RATE_LIMITED');
      let receipt, kind;
      if (op === 'submit') {
        if ((!document.accepting && !who.owner) || document.closed) fail('ACCEPTANCE_OFF');
        if (document.submissions.length >= maximumSubmissions) fail('SUBMISSION_CAP');
        receipt = {roomId, sessionId, nonce: payload.nonce, submissionId: crypto.randomUUID(), participantId: who.id,
          nickname: who.owner ? payload.nickname : who.nickname, prompt: payload.prompt, createdAtMs: row.clock_ms,
          state: 'QUEUED', generationId: null, controlVersion: document.controlRevision,
          reason: 'PROVIDER_NOT_CONNECTED', mode: 'collect', jobs: [], kind: 'submission'};
        document.submissions.push(receipt);
        kind = 'submission';
      } else {
        if (!who.owner) fail('OWNER_DENIED');
        if (payload.expectedRevision !== document.controlRevision) fail('REVISION_CONFLICT');
        if (payload.generationPaused === false || payload.autoDJ === true) fail('PROVIDER_NOT_CONNECTED');
        for (const key of ['accepting', 'generationPaused', 'autoDJ']) if (key in payload) document[key] = payload[key];
        document.controlRevision++;
        receipt = {kind: 'owner-control', roomId, sessionId, nonce: payload.nonce, controlRevision: document.controlRevision,
          accepting: document.accepting, generationPaused: true, autoDJ: false};
        kind = 'owner-control';
      }
      document.eventSeq++;
      document.operations[operationKey] = {actor: proof, atMs: row.clock_ms, digest: operationDigest,
        envelope: {kind, nonce: payload.nonce, receipt}};
      if (await write(row, document)) return structuredClone(receipt);
    }
    fail('REVISION_CONFLICT');
  };
}
