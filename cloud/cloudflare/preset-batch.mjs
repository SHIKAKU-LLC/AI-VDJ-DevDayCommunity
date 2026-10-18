import { createGenerationClass } from "./generation-runtime.mjs";
import { createGenerationStore } from "./generation-store.mjs";
import { libraryVideos } from "./preset-library.mjs";
export function createPresetBatchClass(Base) {
  return class PresetBatch extends createGenerationClass(Base) {
    store() {
      const base = createGenerationStore({
        db: this.env.DB,
        eventId: this.env.EVENT_ID,
        normalized: true,
      });
      return {
        ...base,
        save: async (job) => {
          const safe = {
            id: job.id,
            state: job.state,
            reason: job.reason,
            assets: job.assets,
            providerReceipts: job.providerReceipts,
            videoSha: job.videoSha,
          };
          await this.env.DB.prepare(
            "insert into vdj_runtime_records values(?,'preset-music',?,0,?) on conflict(room_id,kind,record_id) do update set document=excluded.document,version=version+1",
          )
            .bind(job.roomId, job.id, JSON.stringify(safe))
            .run();
          if (job.state === "READY" && job.assets?.audio) {
            const a = job.assets.audio,
              path = `curated/${this.env.EVENT_ID}/audio/${a.sha256}.media`;
            if (!(await this.env.MEDIA.head(path))) {
              const source = await this.env.MEDIA.get(a.path);
              if (!source?.body) throw Error("MEDIA_RESULT_INVALID");
              await this.env.MEDIA.put(path, source.body, {
                httpMetadata: { contentType: "audio/wav" },
                customMetadata: { sha256: a.sha256 },
              });
            }
            await this.env.DB.prepare(
              "insert or ignore into vdj_curated_audio values(?,?,?,?,12,1,?)",
            )
              .bind(
                this.env.EVENT_ID,
                job.videoSha,
                a.sha256,
                a.byteLength,
                Date.now(),
              )
              .run();
          }
        },
      };
    }
    async startBatch(roomId, batchId) {
      return this.locked(async () => {
        const row = await this.env.DB.prepare(
          "select document from vdj_preset_batches where event_id=? and batch_id=? and room_id=? and enabled=1",
        )
          .bind(this.env.EVENT_ID, batchId, roomId)
          .first();
        if (!row) throw Error("ACTOR_DENIED");
        await this.store().active(roomId);
        const config = JSON.parse(row.document);
        if (
          !Array.isArray(config.items) ||
          config.items.length !== 38 ||
          config.items.some(
            (i) =>
              !(
                /^[a-f0-9-]{36}$/.test(i.id) &&
                /^[a-f0-9]{64}$/.test(i.videoSha) &&
                typeof i.prompt === "string" &&
                i.prompt.length <= 2000
              ),
          )
        )
          throw Error("INPUT_INVALID");
        const videos = await libraryVideos(this.env);
        if (
          config.items.some((i) => !videos.some((v) => v.sha256 === i.videoSha))
        )
          throw Error("INPUT_INVALID");
        await this.env.DB.prepare(
          `insert into vdj_budget_reservations select e.id,?,?,400,? from vdj_events e where e.id=? and e.enabled=1 and e.expires_at_ms>? and coalesce((select sum(cents) from vdj_budget_reservations where event_id=e.id),0)+400<=e.maximum_cents on conflict(event_id,plan_id) do nothing`,
        )
          .bind(
            roomId,
            "preset-music:" + batchId,
            Date.now(),
            this.env.EVENT_ID,
            Date.now(),
          )
          .run();
        if (
          !(await this.env.DB.prepare(
            "select plan_id from vdj_budget_reservations where event_id=? and plan_id=?",
          )
            .bind(this.env.EVENT_ID, "preset-music:" + batchId)
            .first())
        )
          throw Error("JUDGE_BUDGET");
        const existing = await this.ctx.storage.get("jobs");
        if (!existing) {
          await this.ctx.storage.put("room", roomId);
          await this.ctx.storage.put(
            "jobs",
            config.items.map((i) => ({
              id: i.id,
              roomId,
              prompt: i.prompt,
              videoSha: i.videoSha,
              audioOnly: true,
              duration: 12,
              videoDuration: 12,
              sceneCount: 0,
              mediaProfile: "club-flow-v1",
              state: "QUEUED",
              parts: { audio: { state: "QUEUED" } },
              createdAtMs: Date.now(),
              maximumCents: 10,
            })),
          );
        }
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return { accepted: 38 };
      });
    }
  };
}
