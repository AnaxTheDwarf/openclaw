// Pruning keeps durable ingress retention bounded without loading retained rows.
import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createTestIngressQueue,
  seedPendingBacklog,
  withTempState,
} from "./ingress-drain.test-helpers.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

describe("channel ingress pruning", () => {
  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

      await queue.enqueue("0002", { text: "second" });
      await queue.enqueue("0001", { text: "first" });
      await queue.enqueue("0003", { text: "third" });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it.each([
    { ids: ["z", "a"], max: 1, protected: ["a"], retained: ["a", "z"] },
    {
      ids: ["a", "z", "\ufffd", "keep\u0000key", "keep\\u0000key"],
      max: 0,
      protected: [" a ", "\ud800", "keep\u0000key"],
      retained: ["a", "keep\u0000key"],
    },
  ])("preserves protected IDs and their retention slots: $max", async (fixture) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      for (const id of fixture.ids) {
        await queue.enqueue(id, { text: id });
      }

      expect(
        await queue.prune({ pendingMaxEntries: fixture.max, protectIds: fixture.protected }),
      ).toBe(fixture.ids.length - fixture.retained.length);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(fixture.retained);
    });
  });

  it.each(["pending", "completed", "failed"] as const)(
    "prunes %s overflow through the worker and preserves the retained prefix",
    async (status) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        seedPendingBacklog(stateDir, 520);
        const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
        const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(db);
        executeSqliteQuerySync(db, kysely.updateTable("channel_ingress_events").set({ status }));
        const host = observeHostDataSql({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
        try {
          const pruneOptions = { [`${status}MaxEntries`]: 2 };
          expect(await queue.prune(pruneOptions)).toBe(518);
          expect(await queue.prune(pruneOptions)).toBe(0);
          expect(host.queries).toEqual([]);
        } finally {
          host.restore();
        }
        expect(
          executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("channel_ingress_events")
              .select("event_id")
              .orderBy("event_id", "asc"),
          ).rows.map((row) => row.event_id),
        ).toEqual(["evt-518", "evt-519"]);
      });
    },
  );
});
