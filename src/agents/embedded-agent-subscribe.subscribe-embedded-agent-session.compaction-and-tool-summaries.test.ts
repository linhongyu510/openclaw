import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { EmbeddedContextAccountingEvent } from "./embedded-agent-runner/run/internal-params.js";
import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { makeZeroUsageSnapshot } from "./usage.js";

function harness(params: Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId"> = {}) {
  const result = createSubscribedSessionHarness({ runId: "compaction", ...params });
  onTestFinished(() => result.subscription.unsubscribe());
  return result;
}
function completed(willRetry = true, tokensBefore = 100, tokensAfter = 50) {
  return {
    type: "compaction_end",
    reason: willRetry ? "overflow" : "threshold",
    outcome: { status: "completed", tokensBefore, tokensAfter, willRetry },
  } as const;
}
const skipped = {
  type: "compaction_end",
  reason: "threshold",
  outcome: { status: "skipped", reason: "Nothing to compact (session too small)" },
} as const;
function assistant(input: number, stopReason: AssistantMessage["stopReason"] = "stop") {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text: "model reply" }],
    usage: { ...makeZeroUsageSnapshot(), input, totalTokens: input },
    stopReason,
  });
}
type Emit = ReturnType<typeof harness>["emit"];
function message(emit: Emit, value: AssistantMessage) {
  emit({ type: "message_start", message: value });
  emit({ type: "message_end", message: value });
}

describe("compaction accounting", () => {
  it.each([
    {
      name: "unavailable provider context despite billing usage",
      events: [
        accountingAssistant(90_000),
        completedCompactionEnd(false, 90_000, 12_000),
        accountingAssistant(18_000),
        completedCompactionEnd(false, 18_000, 8_000),
      ],
      expected: [
        { kind: "model", contextTokens: 90_000, admitted: true },
        { kind: "model", contextTokens: 18_000, admitted: true },
      ],
    },
    {
      name: "explicitly unavailable provider context despite billing usage",
      events: [
        completedCompactionEnd(false, 90_000, 12_000),

        completed(false, 90_000, 12_000),
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "context unavailable" }],
          usage: {
            ...makeZeroUsageSnapshot(),
            input: 90_000,
            totalTokens: 90_000,
            contextUsage: { state: "unavailable" },
          },
        }),
      ],
      expected: [{ kind: "model", contextTokens: undefined, admitted: true }],

      expected: [{ kind: "model", contextTokens: undefined, successful: false }],
    },
    {
      name: "failed zero-usage retry without old assistant backfill",
      events: [assistant(90_000), completed(true, 90_000, 12_000), assistant(0, "error")],
      expected: [
        { kind: "model", contextTokens: 90_000, admitted: true },
        // Zero-usage `error` response: the provider never accepted this prompt,
        // so it must not renew any per-episode recovery budget.
        { kind: "model", contextTokens: undefined, admitted: false },

        { kind: "model", contextTokens: 90_000, successful: false },
        { kind: "model", contextTokens: undefined, successful: false },
      ],
    },
    {
      // Overflow-length: the provider accepted the prompt and billed usage but
      // truncated the reply. Admission is proven, so the budget may renew.
      name: "admitted overflow-length response with real usage",
      events: [accountingAssistant(70_000, "length")],
      expected: [{ kind: "model", contextTokens: 70_000, admitted: true }],
    },
    {
      // Aborted: no completed turn, so admission cannot be claimed.
      name: "aborted response without admission",
      events: [accountingAssistant(0, "aborted")],
      expected: [{ kind: "model", contextTokens: undefined, admitted: false }],
    },
    {
      // A rejection that still reports usage is not an accepted turn either.
      name: "error response carrying usage without admission",
      events: [accountingAssistant(50_000, "error")],
      expected: [{ kind: "model", contextTokens: 50_000, admitted: false }],
    },
    {
      // isContextOverflow Case 2 (z.ai/GLM shape, openclaw#75799): a
      // successful-looking `stop` whose input already exceeds the window. The
      // usage is positive, so only the overflow classifier can tell this apart
      // from real progress - it must not renew the recovery budget.
      name: "silent overflow reported as a successful stop",
      events: [accountingAssistant(220_000)],
      contextWindowTokens: 200_000,
      expected: [{ kind: "model", contextTokens: 220_000, admitted: false }],
    },
    {
      // isContextOverflow Case 3 (Xiaomi MiMo shape): `length` stop with zero
      // output because the server truncated an oversized prompt, at 199,000 of a
      // 200,000 window (>= 99%). Also not progress.
      name: "length-stop overflow that left no room for output",
      events: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "" }],
          usage: { ...makeZeroUsageSnapshot(), input: 199_000, output: 0, totalTokens: 199_000 },
          stopReason: "length",
        }),
      ],
      contextWindowTokens: 200_000,
      expected: [{ kind: "model", contextTokens: 199_000, admitted: false }],
    },
    {
      // Same window, ordinary truncated reply that did produce output: the prompt
      // was admitted, so this one may renew.
      name: "length-stop with real output under the window",
      events: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "partial reply" }],
          usage: { ...makeZeroUsageSnapshot(), input: 50_000, output: 120, totalTokens: 50_120 },
          stopReason: "length",
        }),
      ],
      contextWindowTokens: 200_000,
      // The point of this control case is the admission verdict; the derived
      // context number belongs to the usage helper and is asserted as a number.
      expected: [{ kind: "model", contextTokens: expect.any(Number), admitted: true }],
    },
  ])("records $name in producer order", ({ events, expected, contextWindowTokens }) => {
    const observed: EmbeddedContextAccountingEvent[] = [];
    const { emit } = harness({
      sessionPersistence: "detached",
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      onContextAccountingEvent: (event) => {
        observed.push(event);
      },
    });
    for (const event of events) {
      if ("role" in event) {
        message(emit, event);
      } else {
        emit(event);
      }
    }
    expect(observed).toEqual(expected);
  });

  it("captures repaired model usage before queued delivery and throwing cleanup", async () => {
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const cleanupError = new Error("subscription cleanup failed");
    const observed: EmbeddedContextAccountingEvent[] = [];
    const { session, emit } = createStubSessionHarness();
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribe();
        throw cleanupError;
      };
    };
    let aborted = false;
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "held-accounting",
      sessionPersistence: "detached",
      isTerminalAborted: () => aborted,
      blockReplyBreak: "message_end",
      onBlockReply: () => {},
      onBlockReplyFlush: () => {
        deliveryStarted.resolve();
        return releaseDelivery.promise;
      },
      onContextAccountingEvent: (event) => {
        observed.push(event);
      },
    });
    const expected: EmbeddedContextAccountingEvent[] = [
      { kind: "model", contextTokens: 90_000, admitted: true },
      { kind: "model", contextTokens: 20_000, admitted: true },

      { kind: "model", contextTokens: 90_000, successful: false },
      { kind: "model", contextTokens: 20_000, successful: false },
    ];
    try {
      message(emit, assistant(90_000));
      await deliveryStarted.promise;
      emit(completed(false, 90_000, 12_000));
      const after = assistant(0);
      emit({ type: "message_start", message: after });
      const partial = {
        ...after,
        usage: { ...makeZeroUsageSnapshot(), input: 18_000, cacheRead: 2_000, totalTokens: 20_000 },
      };
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "model reply",
          partial,
        },
      } satisfies AgentSessionEvent);
      emit({ type: "message_end", message: after });
      for (const model of ["delivery-mirror", "gateway-injected"]) {
        message(emit, { ...assistant(99_000), provider: "openclaw", model });
        const withoutUsage = { role: "assistant", provider: "openclaw", model };
        emit({ type: "message_end", message: withoutUsage });
        expect(withoutUsage).not.toHaveProperty("usage");
      }
      expect(observed).toEqual(expected);
      expect(after.usage.input).toBe(18_000);
      aborted = true;
    } finally {
      try {
        expect(() => subscription.unsubscribe()).toThrow(cleanupError);
      } finally {
        releaseDelivery.resolve();
        await subscription.waitForPendingEvents();
      }
    }
    expect(observed).toEqual(expected);
  });

  it("preserves an accepted heartbeat response and private scratch through retry", async () => {
    const onHeartbeatToolResponse = vi.fn();
    const { emit, subscription } = harness({
      sessionPersistence: "detached",
      onHeartbeatToolResponse,
    });
    const tool = createHeartbeatResponseTool();
    const response = {
      outcome: "done" as const,
      notify: true,
      summary: "The monitored task completed.",
      notificationText: "Your report is ready.",
      scratch: "Private monitor notes: report completion confirmed.",
    };
    emit({
      type: "tool_execution_start",
      toolName: tool.name,
      toolCallId: "heartbeat",
      args: response,
    });
    const result = await tool.execute("heartbeat", response);
    emit({
      type: "tool_execution_end",
      toolName: tool.name,
      toolCallId: "heartbeat",
      isError: false,
      result,
    });
    await subscription.waitForPendingEvents();
    expect(subscription.getHeartbeatToolResponse()).toEqual(response);
    emit(completed());
    const reply = assistant(0);
    message(emit, reply);
    emit({ type: "agent_end", messages: [reply] });
    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.getHeartbeatToolResponse()).toEqual(response);
    expect(onHeartbeatToolResponse).toHaveBeenCalledExactlyOnceWith(response);
    expect(subscription.getCompactionCount()).toBe(1);
  });

  it("clears the assistant and its exact usage when compaction starts a new attempt", () => {
    const { emit, subscription } = harness();
    const reply = makeAgentAssistantMessage({
      content: [{ type: "text", text: "before compaction" }],
      usage: {
        ...makeZeroUsageSnapshot(),
        input: 100,
        output: 20,
        cacheRead: 300,
        totalTokens: 420,
      },
    });
    emit({ type: "message_end", message: reply });
    expect(subscription.getCurrentAttemptAssistant()).toEqual(reply);
    expect(subscription.assistantTexts).toEqual(["before compaction"]);
    expect(subscription.getLastAssistantUsage()).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 300,
      total: 420,
    });
    emit(completed());
    expect(subscription.getCurrentAttemptAssistant()).toBeUndefined();
    expect(subscription.assistantTexts).toEqual([]);
    expect(subscription.getLastAssistantUsage()).toBeUndefined();
  });

  it("resolves after compaction ends without retry", async () => {
    const { emit, subscription } = harness();
    emit({ type: "compaction_start" });
    expect(subscription.isCompacting()).toBe(true);
    let resolved = false;
    const pending = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    emit(skipped);
    await pending;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("zeros stale assistant usage after completed compaction without retry", () => {
    const reply = makeAgentAssistantMessage({
      content: [{ type: "text", text: "old" }],
      usage: {
        input: 120,
        output: 30,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 155,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    });
    const { emit, session, subscription } = harness({ sessionExtras: { messages: [reply] } });
    emit(completed(false, 12_345, 6_789));
    expect(session.messages?.[0]).toHaveProperty("usage", makeZeroUsageSnapshot());
    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toBe(6_789);
  });

  it("forwards max-attempt failure text to the compaction event", () => {
    const onAgentEvent = vi.fn();
    const { emit } = harness({ onAgentEvent });
    const failure =
      "Context overflow recovery failed after 3 compact-and-retry attempts. Try reducing context or switching to a larger-context model.";
    emit({
      type: "compaction_end",
      reason: "overflow",
      outcome: { status: "failed", reason: failure },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: expect.objectContaining({ phase: "end", completed: false, reason: failure }),
    });
  });

  it("counts completed compactions and waits for every retry", async () => {
    const { emit, subscription } = harness();
    emit({ type: "compaction_start" });
    expect(subscription.getCompactionCount()).toBe(0);
    emit(completed(true, 20_000, 12_345));
    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toBe(12_345);
    emit(completed());
    expect(subscription.getCompactionCount()).toBe(2);
    let resolved = false;
    const pending = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    emit({ type: "agent_end" });
    await Promise.resolve();
    expect(resolved).toBe(false);
    emit({ type: "agent_end" });
    await pending;
    expect(resolved).toBe(true);
  });

  it("does not count skipped or aborted compaction", () => {
    const { emit, subscription } = harness();
    emit(skipped);
    expect(subscription.getCompactionCount()).toBe(0);
    emit({ type: "compaction_end", reason: "threshold", outcome: { status: "aborted" } });
    expect(subscription.getCompactionCount()).toBe(0);
  });

  it("rejects compaction waits with AbortError when unsubscribed", async () => {
    const abortCompaction = vi.fn();
    const { emit, subscription } = harness({
      sessionExtras: { isCompacting: true, abortCompaction },
    });
    emit({ type: "compaction_start" });
    const pending = subscription.waitForCompactionRetry();
    subscription.unsubscribe();
    for (const wait of [pending, subscription.waitForCompactionRetry()]) {
      const aborted: unknown = await wait.catch((error: unknown) => error);
      expect(aborted).toBeInstanceOf(Error);
      expect(aborted).toHaveProperty("name", "AbortError");
    }
    expect(abortCompaction).toHaveBeenCalledTimes(1);
  });
});

describe("tool summaries", () => {
  it("honors shouldEmitToolResult over disabled verbose mode", async () => {
    const onToolResult = vi.fn();
    const { emit, subscription } = harness({
      verboseLevel: "off",
      shouldEmitToolResult: () => true,
      onToolResult,
    });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "read",
      args: { path: "/tmp/c.txt" },
    });
    await subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it.each(["exec", "server.exec"])(
    "hides command metadata for %s outside full verbose mode",
    async (toolName) => {
      const onToolResult =
        vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onToolResult"]>>();
      const { emit, subscription } = harness({ verboseLevel: "on", onToolResult });
      emit({
        type: "tool_execution_start",
        toolName,
        toolCallId: "exec",
        args: { command: "echo private-sentinel" },
      });
      await subscription.waitForPendingEvents();
      const payload = onToolResult.mock.calls[0]?.[0];
      expect(payload?.text).toContain(toolName === "exec" ? "Exec" : "Server.exec");
      expect(payload?.text).not.toContain("private-sentinel");
    },
  );

  it("emits exec and read output in full verbose mode with the PTY indicator", async () => {
    const onToolResult = vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onToolResult"]>>();
    const { emit, subscription } = harness({ verboseLevel: "full", onToolResult });
    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "exec",
      args: { command: "claude", pty: true },
    });
    await subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0].text).toContain("pty");
    expect(onToolResult.mock.calls[0]?.[0].text).toContain("claude");
    emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "exec",
      isError: false,
      result: { content: [{ type: "text", text: "hello\nworld" }] },
    });
    await subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult.mock.calls[1]?.[0].text).toContain("hello");
    expect(onToolResult.mock.calls[1]?.[0].text).toContain("```txt");
    emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "read",
      isError: false,
      result: { content: [{ type: "text", text: "file data" }] },
    });
    await subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledTimes(3);
    expect(onToolResult.mock.calls[2]?.[0].text).toContain("file data");
  });
});
