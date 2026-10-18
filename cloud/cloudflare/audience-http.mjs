import { createGenerationStore } from "./generation-store.mjs";
import { presetManifest } from "./preset-library.mjs";
import { boundedBytes } from "./fal-provider.mjs";
const answer = (v, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });
const descriptor = ({ path, curated, ...file }) => file;
export async function audienceHttp(request, env) {
  const url = new URL(request.url),
    match =
      /^\/api\/rooms\/([a-f0-9-]{36})\/(playback|preset-library|preset-media)(?:\/([a-f0-9]{64})\/(audio|video))?$/.exec(
        url.pathname,
      );
  if (!match) return null;
  if (env.AUDIENCE_MODE !== "true") return answer({ error: "NOT_FOUND" }, 404);
  if (
    url.origin !== env.PUBLIC_ORIGIN ||
    url.search ||
    (request.headers.has("origin") &&
      request.headers.get("origin") !== env.PUBLIC_ORIGIN)
  )
    return answer({ error: "DENIED" }, 403);
  try {
    const [, roomId, route, sha, kind] = match;
    const owner = request.headers.get("x-room-owner");
    if (request.headers.has("authorization")) throw Error("ACTOR_DENIED");
    await createGenerationStore({
      db: env.DB,
      eventId: env.EVENT_ID,
    }).authorize(roomId, owner, true);
    if (route === "playback" && !sha) {
      if (request.method === "GET")
        return answer(
          await env.AUDIENCE_ROOMS.getByName(roomId).playback(roomId, {
            action: "view",
          }),
        );
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== env.PUBLIC_ORIGIN ||
        request.headers.get("content-type") !== "application/json"
      )
        return answer({ error: "DENIED" }, 403);
      const input = JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(new Response(request.body), 4096),
        ),
      );
      const allowed = {
        claim: ["action", "clientId", "nonce", "readyIds"],
        started: ["action", "clientId", "nonce", "id"],
        heartbeat: ["action", "clientId"],
        release: ["action", "clientId"],
        abandon: ["action", "clientId"],
      };
      if (
        !allowed[input.action] ||
        Object.keys(input).some((k) => !allowed[input.action].includes(k)) ||
        typeof input.clientId !== "string"
      )
        throw Error("PLAYBACK_INPUT_INVALID");
      return answer(
        await env.AUDIENCE_ROOMS.getByName(roomId).playback(roomId, input),
      );
    }
    const presets = await presetManifest(env);
    if (route === "preset-library" && !sha && request.method === "GET")
      return answer({
        presets: presets.map((p) => ({
          id: p.id,
          audio: descriptor(p.audio),
          video: descriptor(p.video),
        })),
      });
    if (route === "preset-media" && sha && kind && request.method === "GET") {
      const preset = presets.find((p) => p.id === "preset:" + sha),
        file = preset?.[kind];
      if (!file) return answer({ error: "NOT_FOUND" }, 404);
      const object = await env.MEDIA.get(file.path);
      if (
        !object?.body ||
        object.size !== file.byteLength ||
        (object.customMetadata?.sha256 !== file.sha256 &&
          (!file.curated || object.customMetadata?.sha256 !== undefined))
      )
        return answer({ error: "MEDIA_UNAVAILABLE" }, 503);
      return new Response(object.body, {
        headers: {
          "content-type": file.contentType,
          "content-length": String(file.byteLength),
          "cache-control": "private, no-store",
          "x-content-sha256": file.sha256,
        },
      });
    }
    return answer({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = [
      "ACTOR_DENIED",
      "ROOM_NOT_FOUND",
      "PLAYBACK_IN_USE",
      "PLAYBACK_INPUT_INVALID",
      "PLAYBACK_CLIENT_INVALID",
      "PLAYBACK_CLAIM_INVALID",
      "PLAYBACK_CLAIM_PENDING",
    ].includes(error.message)
      ? error.message
      : "PLAYBACK_UNAVAILABLE";
    return answer(
      { error: code },
      code === "ACTOR_DENIED" ? 403 : code === "ROOM_NOT_FOUND" ? 404 : 409,
    );
  }
}
