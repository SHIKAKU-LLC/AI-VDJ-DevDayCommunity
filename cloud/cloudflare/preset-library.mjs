import { sceneKeys } from "./generation-parts.mjs";
export async function libraryVideos(env) {
  const records = await env.DB.prepare(
    `select g.document from vdj_runtime_records g join vdj_stock_sources s on s.room_id=g.room_id
    join vdj_rooms r on r.id=s.room_id where s.event_id=? and g.kind='cloud-generation'
    and coalesce(json_extract(r.document,'$.purged'),0)=0`,
  )
    .bind(env.EVENT_ID)
    .all();
  const stock = records.results.flatMap((row) => {
    const j = JSON.parse(row.document);
    return j.reference || j.direction
      ? []
      : sceneKeys(j)
          .filter((k) => j.assets?.[k])
          .map((k) => j.assets[k]);
  });
  const curated = await env.DB.prepare(
    "select sha256,byte_length,duration,width,height from vdj_curated_scenes where event_id=? and enabled=1 order by created_at_ms,sha256 limit 50",
  )
    .bind(env.EVENT_ID)
    .all();
  const files = [
    ...curated.results.map((r) => ({
      sha256: r.sha256,
      byteLength: r.byte_length,
      duration: r.duration,
      width: r.width,
      height: r.height,
      contentType: "video/mp4",
      curated: true,
      path: `curated/${env.EVENT_ID}/${r.sha256}.media`,
    })),
    ...stock,
  ];
  return [...new Map(files.map((f) => [f.sha256, f])).values()].slice(0, 50);
}
export async function presetManifest(env) {
  const videos = await libraryVideos(env);
  const rows = await env.DB.prepare(
    "select video_sha256,sha256,byte_length,duration from vdj_curated_audio where event_id=? and enabled=1 order by created_at_ms,video_sha256",
  )
    .bind(env.EVENT_ID)
    .all();
  return rows.results.flatMap((r) => {
    const video = videos.find((v) => v.sha256 === r.video_sha256);
    if (!video) return [];
    return [
      {
        id: "preset:" + r.video_sha256,
        kind: "preset",
        audio: {
          sha256: r.sha256,
          byteLength: r.byte_length,
          duration: r.duration,
          contentType: "audio/wav",
          path: `curated/${env.EVENT_ID}/audio/${r.sha256}.media`,
        },
        video,
      },
    ];
  });
}
