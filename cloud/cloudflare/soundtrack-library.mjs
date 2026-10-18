export async function curatedSoundtracks(env) {
  const rows=await env.DB.prepare("select g.document from vdj_runtime_records g join vdj_rooms r on r.id=g.room_id where r.event_id=? and g.kind='curated-soundtrack' order by json_extract(g.document,'$.sequence'),g.record_id").bind(env.EVENT_ID).all();
  return rows.results.map(r=>JSON.parse(r.document)).filter(j=>j.state==='READY' && j.assets?.audio?.duration===60);
}
