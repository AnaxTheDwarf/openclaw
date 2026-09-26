import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLlmCompleteError } from "./runtime/runtime-llm-error.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

type OpenClawPluginToolLlm = NonNullable<OpenClawPluginToolContext["llm"]>;

type ToolInvocationAuthority = {
  controller: AbortController;
  open: boolean;
};

export type PluginToolLlmBinding = {
  llm: OpenClawPluginToolLlm;
  run<T>(
    signal: AbortSignal | undefined,
    execute: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
};

function notAuthorized(message: string): Error {
  return createLlmCompleteError("LLM_COMPLETION_NOT_AUTHORIZED", message);
}

/**
 * Creates one factory-context completion capability. The concrete invocation
 * authority is supplied only while the registered tool's execute callback runs.
 */
export function createPluginToolLlmBinding(params: {
  context: OpenClawPluginToolContext;
  pluginId: string;
}): PluginToolLlmBinding {
  const invocation = new AsyncLocalStorage<ToolInvocationAuthority>();
  const agentId = params.context.agentId?.trim();
  const sessionKey = params.context.sessionKey?.trim();
  const resolveConfig = (): OpenClawConfig | undefined =>
    params.context.getRuntimeConfig?.() ?? params.context.runtimeConfig ?? params.context.config;

  const assertCurrent = (): ToolInvocationAuthority => {
    const authority = invocation.getStore();
    if (!authority?.open || authority.controller.signal.aborted) {
      throw notAuthorized("Plugin tool LLM completion invocation is no longer active.");
    }
    if (!agentId || !sessionKey) {
      throw notAuthorized("Plugin tool LLM completion is not bound to an active session agent.");
    }
    return authority;
  };

  return {
    llm: {
      complete: async (request) => {
        const authority = assertCurrent();
        const requestSignal = request.signal;
        const signal = requestSignal
          ? AbortSignal.any([requestSignal, authority.controller.signal])
          : authority.controller.signal;
        const { createRuntimeLlm } = await import("./runtime/runtime-llm.runtime.js");
        assertCurrent();
        const result = await createRuntimeLlm({
          getConfig: resolveConfig,
          authority: {
            caller: { kind: "plugin", id: params.pluginId },
            pluginIdForPolicy: params.pluginId,
            requiresBoundAgent: true,
            agentId,
            sessionKey,
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete({ ...request, signal });
        assertCurrent();
        return result;
      },
    },
    async run(signal, execute) {
      const authority: ToolInvocationAuthority = {
        controller: new AbortController(),
        open: true,
      };
      const abort = () => authority.controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
      try {
        return await invocation.run(authority, () => execute(signal));
      } finally {
        authority.open = false;
        authority.controller.abort(new Error("Plugin tool invocation closed"));
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
