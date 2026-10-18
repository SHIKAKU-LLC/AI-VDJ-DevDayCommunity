import { createFalProvider } from "./fal-provider.mjs";
import { createD1RoomRpc } from "./room-api.mjs";
import { createGenerationStore } from "./generation-store.mjs";
import {
  playbackState,
  eligibleSets,
  assertLease,
  claimNext,
  acknowledgeStart,
} from "./playback-queue.mjs";
import { presetManifest } from "./preset-library.mjs";
import { readSubmissionRecords } from "./submission-records.mjs";
import { preparePlaybackDecision, requestPlaybackDecision } from "./playback-decisions.mjs";

export function createAudienceRoomClass(Base) {
  return class AudienceRoom extends Base {
    constructor(ctx, env) {
      super(ctx, env);
      this.ctx = ctx;
      this.env = env;
      this.serial = Promise.resolve();
      this.prices = new Map();
    }
    locked(fn) {
      const task = this.serial.then(fn);
      this.serial = task.catch(() => {});
      return task;
    }
    async checkPrice(options) {
      const key = JSON.stringify([
        options.duration,
        !!options.reference,
        !!options.audioOnly,
      ]);
      const cached = this.prices.get(key);
      if (cached && cached.until > Date.now()) return cached.promise;
      const promise = createFalProvider({
        key: this.env.FAL_KEY,
        fetchImpl: this.env.testFetch ?? fetch,
      }).preflight(options);
      this.prices.set(key, { until: Date.now() + 30000, promise });
      try {
        return await promise;
      } catch (error) {
        this.prices.delete(key);
        throw error;
      }
    }
    async roomOperation(input) {
      return this.locked(async () => {
        const rpc = createD1RoomRpc({
          db: this.env.DB,
          eventId: this.env.EVENT_ID,
          normalized: true,
        });
        const receipt = await rpc(input);
        if (input.op === "submit" && this.env.GENERATION_ENABLED === "true") {
          await this.ctx.storage.put("room", input.room_id);
          const pending = (await this.ctx.storage.get("dispatch")) ?? [];
          if (!pending.includes(receipt.submissionId))
            pending.push(receipt.submissionId);
          await this.ctx.storage.put("dispatch", pending);
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        return receipt;
      });
    }
    async wake(roomId) {
      const pending = await this.ctx.storage.get("dispatch");
      if (pending?.length) await this.ctx.storage.setAlarm(Date.now() + 100);
    }
    async alarm() {
      const { roomId, pending } = await this.locked(async () => ({
        roomId: await this.ctx.storage.get("room"),
        pending: (await this.ctx.storage.get("dispatch")) ?? [],
      }));
      if (!roomId || !pending.length) return;
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const store = createGenerationStore({
        db: this.env.DB,
        eventId: this.env.EVENT_ID,
        normalized: true,
      });
      try {
        await store.active(roomId);
      } catch (error) {
        if (error.message !== "ROOM_NOT_FOUND") throw error;
        await this.ctx.storage.delete("dispatch");
        return;
      }
      const records = await store.records(roomId);
      const active = records.filter(
        (j) =>
          j.profile === "audience-12-v1" &&
          !["READY", "FAILED", "NEEDS_REVIEW"].includes(j.state),
      ).length;
      const selected = pending.slice(0, Math.max(0, 30 - active));
      const finished = [];
      await Promise.all(
        selected.map(async (id) => {
          try {
            // Legacy jobs keep their private provider handles in GenerationRoom.
            // Retrying an old receipt must never redispatch its paid requests.
            const prior = records.find((job) => job.id === id);
            if (prior && prior.profile !== "audience-12-v1") {
              finished.push(id);
              return;
            }
            await this.env.GENERATION_JOBS.getByName(roomId + ":" + id).enqueue(
              roomId,
              [id],
            );
            finished.push(id);
          } catch (error) {
            if (
              [
                "JUDGE_BUDGET",
                "SUBMISSION_NOT_FOUND",
                "IMAGE_DIRECTION_DISABLED",
                "IMAGE_REFERENCE_INVALID",
              ].includes(error.message)
            ) {
              const job = {
                id,
                roomId,
                profile: "audience-12-v1",
                state: "FAILED",
                reason: error.message,
                createdAtMs: Date.now(),
              };
              await this.env.DB.prepare(
                "insert or ignore into vdj_runtime_records values(?,'cloud-generation',?,0,?)",
              )
                .bind(roomId, id, JSON.stringify(job))
                .run();
              finished.push(id);
            }
          }
        }),
      );
      await this.locked(async () => {
        const remaining = (
          (await this.ctx.storage.get("dispatch")) ?? []
        ).filter((id) => !finished.includes(id));
        await this.ctx.storage.put("dispatch", remaining);
        if (remaining.length)
          await this.ctx.storage.setAlarm(Date.now() + 2000);
      });
    }
    async playback(roomId, input) {
      let decision;
      const result = await this.locked(async () => {
        const store = createGenerationStore({
          db: this.env.DB,
          eventId: this.env.EVENT_ID,
          normalized: true,
        });
        const room = await store.active(roomId);
        const state =
          (await this.ctx.storage.get("playback")) ?? playbackState();
        let jobs = await store.records(roomId);
        // Older jobs have generation timestamps only. Recover receipt order
        // without rewriting those jobs or redispatching their paid generation.
        if (jobs.some((j) => j.submittedAtMs === undefined)) {
          const submissions = new Map((await readSubmissionRecords(
            this.env.DB, roomId, JSON.parse(room.document),
          )).map((s) => [s.submissionId, s]));
          jobs = jobs.map((j) => {
            const receipt = submissions.get(j.id);
            return receipt ? { ...j, submittedAtMs: receipt.createdAtMs,
              submissionOrder: receipt.submissionOrder } : j;
          });
        }
        const presets = await presetManifest(this.env);
        let result;
        if (input.action === "release") {
          if (state.lease?.clientId === input.clientId) {
            state.lease = null;
            state.pending = null;
          }
          result = { released: true };
        } else if (input.action === "abandon") {
          if (state.pending?.clientId === input.clientId) state.pending = null;
          result = { abandoned: true };
        } else if (input.action === "heartbeat") {
          assertLease(state, input.clientId, Date.now());
          result = { until: state.lease.until };
        } else if (input.action === "claim")
          result = { claim: claimNext(state, jobs, presets, {
            ...input,
            decision: this.env.DECISIONS_ENABLED === "true" && this.env.OPENAI_API_KEY
              ? state.decisions?.latest : undefined,
          }) };
        else if (input.action === "started")
          result = acknowledgeStart(state, input);
        else if (input.action === "view")
          result = {
            revision: state.revision,
            counts: state.counts,
            played: state.played,
            queue: eligibleSets(jobs, state).map((j) => ({
              id: j.id,
              participantId: j.participantId,
              adopted: state.counts[j.participantId] ?? 0,
            })),
            presetsPlayed: state.presetsPlayed,
            lastPreset: state.lastPreset,
            selection: state.lastSelection ?? null,
            decisions: {
              enabled: this.env.DECISIONS_ENABLED === "true" && !!this.env.OPENAI_API_KEY,
              calls: state.decisions?.calls ?? 0,
              status: state.decisions?.latest?.status ?? "idle",
            },
          };
        else throw Error("PLAYBACK_INPUT_INVALID");
        decision = preparePlaybackDecision(state, jobs, this.env);
        await this.ctx.storage.put("playback", state);
        return result;
      });
      // No network wait inside the room lock or playback response. Preparation
      // normally starts at the previous set's acknowledgement, 12s in advance.
      if (decision) this.ctx.waitUntil(this.finishPlaybackDecision(decision));
      return result;
    }
    async finishPlaybackDecision(plan) {
      const answer = await requestPlaybackDecision(plan, {
        key: this.env.OPENAI_API_KEY,
        fetchImpl: this.env.testDecisionFetch ?? fetch,
      });
      await this.locked(async () => {
        const state = await this.ctx.storage.get("playback");
        if (state?.decisions?.latest?.key !== plan.key) return;
        // Merge only the advice into fresh state; never resurrect a consumed
        // claim, rewind counts, or replace a newer plan with an old response.
        state.decisions.latest = { key: plan.key, ...answer };
        await this.ctx.storage.put("playback", state);
      });
    }
  };
}
