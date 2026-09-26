import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginToolRegistration } from "./registry-types.js";
import { createPluginRecord } from "./status.test-helpers.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "./tool-factory-runtime.js";
import { createPluginToolLlmBinding } from "./tool-llm-binding.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

type OpenClawPluginToolLlm = NonNullable<OpenClawPluginToolContext["llm"]>;

const completionMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  complete: vi.fn(),
  resolveSelection: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: completionMocks.acquire,
  completeWithPreparedSimpleCompletionModel: completionMocks.complete,
  resolveSimpleCompletionSelectionForAgent: completionMocks.resolveSelection,
}));

const config = {
  agents: {
    defaults: { model: "openai/main-model" },
    list: [
      { id: "main", model: "openai/main-model" },
      { id: "data-analyst", model: "openai/analyst-model" },
    ],
  },
} satisfies OpenClawConfig;

function preparedModel() {
  return {
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId: "analyst-model",
      agentDir: "/tmp/data-analyst",
    },
    model: {
      provider: "openai",
      id: "analyst-model",
      name: "analyst-model",
      api: "openai" as const,
      baseUrl: "https://fixture.invalid/v1",
      input: ["text" as const],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    auth: { apiKey: "fixture", source: "test", mode: "api-key" as const },
  };
}

function createBinding(overrides: { agentId?: string; sessionKey?: string } = {}) {
  return createPluginToolLlmBinding({
    pluginId: "semantic-admission",
    context: {
      config,
      agentId: overrides.agentId === undefined ? "data-analyst" : overrides.agentId,
      sessionKey:
        overrides.sessionKey === undefined
          ? "agent:data-analyst:telegram:group:fixture"
          : overrides.sessionKey,
    },
  });
}

describe("plugin tool LLM binding", () => {
  beforeEach(() => {
    completionMocks.acquire.mockReset();
    completionMocks.complete.mockReset();
    completionMocks.resolveSelection.mockReset();
    completionMocks.resolveSelection.mockImplementation(({ agentId }: { agentId: string }) => ({
      provider: "openai",
      modelId: agentId === "data-analyst" ? "analyst-model" : "main-model",
      agentDir: `/tmp/${agentId}`,
    }));
    completionMocks.acquire.mockResolvedValue(preparedModel());
    completionMocks.complete.mockResolvedValue({
      content: [{ type: "text", text: "{not-json" }],
      responseModel: "analyst-model",
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
  });

  it("runs a registered tool with its factory's bound capability", async () => {
    let factoryLlm: OpenClawPluginToolLlm | undefined;
    const resolver = createPluginToolFactoryResolver(() => {});
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "semantic-admission" }));
    const entry: PluginToolRegistration = {
      pluginId: "semantic-admission",
      source: "/tmp/semantic-admission.js",
      names: ["semantic_tool"],
      optional: false,
      factory: (context: OpenClawPluginToolContext) => {
        factoryLlm = context.llm;
        return {
          name: "semantic_tool",
          label: "Semantic tool",
          description: "Classifies a request",
          parameters: Type.Object({}),
          execute: async (_toolCallId, _params, signal) => {
            const completion = await context.llm?.complete({
              messages: [{ role: "user", content: "classify" }],
              signal,
            });
            return {
              content: [{ type: "text", text: completion?.text ?? "missing" }],
              details: {},
            };
          },
        };
      },
    };
    const resolved = resolver.resolve(
      entry,
      {
        config,
        agentId: "data-analyst",
        sessionKey: "agent:data-analyst:telegram:group:fixture",
      },
      ["semantic_tool"],
      registry,
    );

    expect(factoryLlm).toBe(resolved.llmBinding.llm);
    expect(resolved.resolved).not.toBeNull();
    expect(Array.isArray(resolved.resolved)).toBe(false);
    const tool = bindPluginToolCallbacks(
      entry,
      registry,
      resolved.resolved as Exclude<typeof resolved.resolved, null | undefined | unknown[]>,
      resolved.llmBinding,
    );
    await expect(tool.execute("call-1", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "{not-json" }],
    });
    expect(completionMocks.resolveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "data-analyst" }),
    );
    expect(completionMocks.resolveSelection).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    await expect(
      factoryLlm?.complete({ messages: [{ role: "user", content: "outside invocation" }] }),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
  });

  it("selects the bound tool-session agent and leaves semantic JSON validation to the plugin", async () => {
    const binding = createBinding();
    const result = await binding.run(undefined, async () => {
      const completion = await binding.llm.complete({
        messages: [{ role: "user", content: "classify" }],
      });
      try {
        JSON.parse(completion.text);
        return { status: "ok", completion };
      } catch {
        return { status: "semantic_intent_invalid_json", completion };
      }
    });

    expect(completionMocks.resolveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "data-analyst" }),
    );
    expect(completionMocks.resolveSelection).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(result).toMatchObject({
      status: "semantic_intent_invalid_json",
      completion: { text: "{not-json", agentId: "data-analyst" },
    });
  });

  it("rejects ambient or explicit main selection", async () => {
    const binding = createBinding();
    await expect(
      binding.run(undefined, () =>
        binding.llm.complete({
          agentId: "main",
          messages: [{ role: "user", content: "classify" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(completionMocks.resolveSelection).not.toHaveBeenCalled();
  });

  it("fails closed without a complete session binding", async () => {
    for (const overrides of [{ agentId: "" }, { sessionKey: "" }]) {
      const binding = createBinding(overrides);
      await expect(
        binding.run(undefined, () =>
          binding.llm.complete({ messages: [{ role: "user", content: "classify" }] }),
        ),
      ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    }
    expect(completionMocks.resolveSelection).not.toHaveBeenCalled();
  });

  it("revokes retained capabilities when the tool invocation closes", async () => {
    const binding = createBinding();
    let retained: OpenClawPluginToolLlm | undefined;
    await binding.run(undefined, async () => {
      retained = binding.llm;
    });
    await expect(
      retained?.complete({ messages: [{ role: "user", content: "late" }] }),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(completionMocks.resolveSelection).not.toHaveBeenCalled();
  });
});
