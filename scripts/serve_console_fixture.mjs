import {playbackState,eligibleSets,claimNext,acknowledgeStart,assertLease} from "../cloud/cloudflare/playback-queue.mjs";
// Offline browser fixture. Never imports Cloudflare, fal, or production credentials.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
const root = resolve("room-web/console/dist"),
  media = process.env.VDJ_FIXTURE_MEDIA;
if (!media) throw Error("VDJ_FIXTURE_MEDIA must point to synthetic media.");
const audio = await readFile(resolve(media, "tone.wav")),
  video = await readFile(resolve(media, "scene.mp4"));
const descriptor = (bytes, extra) => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.length,
  ...extra,
});
const audioAsset = descriptor(audio, { duration: 12 }),
  videoAsset = descriptor(video, { duration: 12, width: 854, height: 480 });
const roomId = "11111111-1111-4111-8111-111111111111";
let playback=playbackState();
const presets=Array.from({length:38},(_,i)=>({id:"preset:"+createHash("sha256").update(String(i)).digest("hex"),audio:audioAsset,video:videoAsset}));
let submissions = [],
  jobs = [],
  accepting = true,
  mode = "ready";
const json = (res, data, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4176"),
    path = url.pathname;
  const body = async () => {
    let data = "";
    for await (const chunk of req) data += chunk;
    return JSON.parse(data || "{}");
  };
  if (path === "/__fixture/mode") {
    mode = url.searchParams.get("name") || "ready";
    if (mode === "reset") {
      playback=playbackState();
      submissions = [];
      jobs = [];
      accepting = true;
      mode = "ready";
    }
    return json(res, { mode });
  }
  if (path === "/api/room-capabilities")
    return json(res, { generation: true, cloud: { imageDirection: true } });
  if (path === "/api/judge/rooms") {
    await body();
    return json(res, {
      roomId,
      ownerToken: "synthetic-owner",
      joinUrl: `http://127.0.0.1:4176/join/${roomId}?code=synthetic`,
    });
  }
  if (path.endsWith("/participants")) {
    await body();
    return json(res, { roomId, participantToken: "synthetic-participant" });
  }
  if (path.endsWith("/control")) {
    accepting = (await body()).accepting;
    return json(res, {});
  }
  if (path.includes("/reference-image/")) {
    for await (const _ of req) {
    }
    return json(res, {});
  }
  if (path.endsWith("/submissions")) {
    if (mode === "error") return json(res, { error: "RATE_LIMITED" }, 429);
    if (!accepting) return json(res, { error: "ACCEPTANCE_OFF" }, 409);
    const data = await body(),
      id = data.nonce;
    if (!submissions.some((s) => s.submissionId === id))
      submissions.push({
        submissionId: id,
        nickname: data.nickname ?? "テスト参加者",
        prompt: data.prompt,
        participantId:data.nickname?"owner":"participant",
      });
    if(!jobs.some(j=>j.id===id)){const sub=submissions.find(s=>s.submissionId===id);jobs.push({...sub,id,profile:"audience-12-v1",state:mode==="waiting"?"GENERATING":"READY",sceneCount:1,readyAtMs:Date.now(),progress:{audio:"READY",video:"READY"},...(mode==="waiting"?{}:{assets:{audio:audioAsset,video:videoAsset}})});}
    await new Promise((r) => setTimeout(r, 350));
    return json(res, { submissionId: id });
  }
  if(path.endsWith("/generation"))return json(res,{jobs,remainingSets:100-jobs.length,playback:{...playback,queue:eligibleSets(jobs,playback).map(j=>({id:j.id}))}});
  if(path.endsWith("/preset-library"))return json(res,{presets});
  if(path.endsWith("/playback")){
    const input=await body();let result={};
    try{
      if(input.action==="claim")result={claim:claimNext(playback,jobs,presets,input)};
      if(input.action==="started")result=acknowledgeStart(playback,input);
      if(input.action==="heartbeat")assertLease(playback,input.clientId,Date.now());
      if(input.action==="release"){playback.lease=null;playback.pending=null;}
      if(input.action==="abandon")playback.pending=null;
      return json(res,result);
    }catch(e){return json(res,{error:e.message},409);}
  }
  if (path.endsWith("/scene-library")) return json(res, { scenes: [] });
  if (path.includes("/generated-media/")||path.includes("/preset-media/")) {
    const bytes = path.endsWith("/audio") ? audio : video;
    res.writeHead(200, {
      "content-type": path.endsWith("/audio") ? "audio/wav" : "video/mp4",
    });
    return res.end(bytes);
  }
  if (path.startsWith("/api/rooms/"))
    return json(res, { accepting, controlRevision: 1, submissions });
  let file =
    ["/", "/room"].includes(path) || path.startsWith("/join/")
      ? resolve(root, "index.html")
      : path === "/judge-meter.mjs"
        ? resolve("room-web/judge-meter.mjs")
        : resolve(root, "." + path);
  if (!file.startsWith(root) && file !== resolve("room-web/judge-meter.mjs"))
    return json(res, {}, 404);
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      "content-type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".woff": "font/woff",
        }[extname(file)] ?? "application/octet-stream",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(bytes);
  } catch {
    json(res, {}, 404);
  }
});
server.listen(4176, "127.0.0.1", () =>
  console.log("合成データ専用の画面確認: http://127.0.0.1:4176/room"),
);
