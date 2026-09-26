import { mergeProcessEnv } from "../../infra/process-env.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import type { pruneChannelIngressInDatabase } from "./ingress-queue.kernel.js";

export function resolveChannelIngressStateEnv(stateDir?: string): NodeJS.ProcessEnv {
  return stateDir ? mergeProcessEnv([process.env, { OPENCLAW_STATE_DIR: stateDir }]) : process.env;
}

export function pruneChannelIngressThroughWorker(
  input: Parameters<typeof pruneChannelIngressInDatabase>[1],
  stateDir?: string,
): Promise<number> {
  const context = captureOpenClawStateWorkerContext({
    env: resolveChannelIngressStateEnv(stateDir),
  });
  return executeOpenClawStateWorker(context, {
    type: "channelIngress.prune",
    input: {
      queueName: input.queueName,
      now: input.now,
      options: {
        pendingTtlMs: input.options.pendingTtlMs,
        completedTtlMs: input.options.completedTtlMs,
        failedTtlMs: input.options.failedTtlMs,
        pendingMaxEntries: input.options.pendingMaxEntries,
        completedMaxEntries: input.options.completedMaxEntries,
        failedMaxEntries: input.options.failedMaxEntries,
        protectIds: input.options.protectIds,
      },
    },
  });
}
