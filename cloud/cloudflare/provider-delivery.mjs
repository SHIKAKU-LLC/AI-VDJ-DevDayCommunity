const clock = "cast(unixepoch('subsec')*1000 as integer)";
const encoder = new TextEncoder();
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const denied = () => new Response(null, {status: 404, headers: {'cache-control': 'no-store'}});
const allowedTypes = ['audio/wav', 'image/png', 'image/jpeg', 'video/mp4'];

// Only trusted generation code may call issue(). The download route can read
// one immutable object for a bounded time and never lists or writes the bucket.
export function createProviderDelivery({db, bucket, eventId, origin} = {}) {
  if (!db?.prepare || !bucket?.head || !bucket?.get || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin ||
      !/^judge-[a-z0-9-]{1,60}$/.test(eventId ?? '')) throw Error('PROVIDER_DELIVERY_CONFIGURATION_REQUIRED');
  const query = (sql, ...values) => db.prepare(sql).bind(...values);
  return {
    async issue({roomId, path, expiresIn, signal}) {
      if (signal?.aborted || !/^[a-f0-9-]{36}$/.test(roomId ?? '') || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) throw Error('PROVIDER_DELIVERY_SCOPE_REQUIRED');
      const prefix = 'rooms/' + await digest(JSON.stringify(roomId)) + '/assets/';
      if (typeof path !== 'string' || !path.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,100}\.media$/.test(path.slice(prefix.length))) throw Error('PROVIDER_DELIVERY_SCOPE_REQUIRED');
      const room = await query(`select min(r.expires_at_ms,e.expires_at_ms) as deadline,${clock} as clock_ms
        from vdj_rooms r join vdj_events e on e.id=r.event_id where r.id=? and e.id=? and e.enabled=1
        and r.expires_at_ms>${clock} and e.expires_at_ms>${clock}`, roomId, eventId).first();
      if (!room) throw Error('PROVIDER_DELIVERY_SCOPE_REQUIRED');
      const object = await bucket.head(path);
      if (signal?.aborted || !object || !object.etag || !allowedTypes.includes(object.httpMetadata?.contentType) || object.size < 1 || object.size > 32 * 1024 * 1024) throw Error('PROVIDER_DELIVERY_OBJECT_REQUIRED');
      const grant = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const recordId = await digest(grant), expiresAtMs = Math.min(room.deadline, room.clock_ms + expiresIn * 1000);
      const document = JSON.stringify({path, etag: object.etag, size: object.size, contentType: object.httpMetadata.contentType, expiresAtMs, uses: 0});
      const inserted = await query(`insert into vdj_runtime_records(room_id,kind,record_id,version,document)
        select r.id,'provider-delivery',?,0,? from vdj_rooms r join vdj_events e on e.id=r.event_id
        where r.id=? and e.id=? and e.enabled=1 and r.expires_at_ms>${clock} and e.expires_at_ms>${clock}
        and (select count(*) from vdj_runtime_records g where g.room_id=r.id and g.kind='provider-delivery')<50`,
      recordId, document, roomId, eventId).run();
      if (inserted.meta.changes !== 1) throw Error('PROVIDER_DELIVERY_LIMIT');
      // The URL stays in the server's transient request, never in a stored record.
      return {url: origin + '/provider-media/' + grant, expiresAtMs};
    },
    async handle(request) {
      const url = new URL(request.url), match = /^\/provider-media\/([a-f0-9]{64})$/.exec(url.pathname);
      if (url.origin !== origin || url.search || !match || !['GET', 'HEAD'].includes(request.method) || request.headers.has('range')) return denied();
      try {
        const recordId = await digest(match[1]);
        const record = await query(`update vdj_runtime_records set version=version+1,
          document=json_set(document,'$.uses',json_extract(document,'$.uses')+1)
          where kind='provider-delivery' and record_id=? and json_extract(document,'$.expiresAtMs')>${clock}
          and json_extract(document,'$.uses')<8 and exists(select 1 from vdj_rooms r join vdj_events e on e.id=r.event_id
            where r.id=vdj_runtime_records.room_id and e.id=? and e.enabled=1 and r.expires_at_ms>${clock} and e.expires_at_ms>${clock})
          returning document`, recordId, eventId).first();
        if (!record) return denied();
        const grant = JSON.parse(record.document), object = await bucket.get(grant.path, {onlyIf: {etagMatches: grant.etag}});
        if (!object?.body || request.signal.aborted || object.etag !== grant.etag || object.size !== grant.size || object.httpMetadata?.contentType !== grant.contentType) {
          await object?.body?.cancel(); return denied();
        }
        const headers = {'content-type': grant.contentType, 'content-length': String(grant.size),
          'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'};
        if (request.method === 'HEAD') { await object.body.cancel(); return new Response(null, {headers}); }
        return new Response(object.body, {headers});
      } catch { return denied(); }
    },
  };
}
