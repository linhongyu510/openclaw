// Compaction must not force map-reduce when the whole history fits one summarizer call.
import { describe, expect, it } from "vitest";
import { resolveSummaryOutputTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  BASE_CHUNK_RATIO,
  buildStageSplitPlan,
  estimateMessagesTokens,
  computeAdaptiveChunkRatio,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

// Mirrors the reported deployment: a 262K-window summarizer over a ~164K transcript.
const LARGE_CONTEXT_WINDOW = 262_144;
const LARGE_SUMMARY_OUTPUT_BUDGET = 65_536;

function buildTranscript(messageCount: number, charsPerMessage: number): AgentMessage[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: "user",
    content: `turn ${index} ${"context ".repeat(Math.floor(charsPerMessage / 8))}`,
    timestamp: 1_000 + index,
  }));
}

function resolveMaxChunkTokens(messages: AgentMessage[], contextWindow: number): number {
  const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
  return Math.max(1, Math.floor(contextWindow * ratio) - SUMMARIZATION_OVERHEAD_TOKENS);
}

describe("compaction single-pass fast path", () => {
  it("uses the completion owner's generated-summary budget", () => {
    expect(resolveSummaryOutputTokens({ reserveTokens: 100, modelMaxTokens: 64 })).toBe(64);
    expect(resolveSummaryOutputTokens({ reserveTokens: 100, modelMaxTokens: 0 })).toBe(80);
  });

  it("summarizes in one call when the whole history fits the summarizer window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    // Guard the fixture: this must be a transcript that genuinely fits.
    expect(totalTokens).toBeGreaterThan(120_000);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("single");
  });

  it("still splits when the history genuinely exceeds the summarizer window", () => {
    const messages = buildTranscript(400, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("split");
  });

  it("splits when the generated summary would exceed the remaining window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);
    expect(
      totalTokens * 1.2 + SUMMARIZATION_OVERHEAD_TOKENS + LARGE_SUMMARY_OUTPUT_BUDGET,
    ).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan.mode).toBe("split");
  });

  it("keeps splitting for small-window summarizers", () => {
    // A 32K summarizer cannot absorb the same transcript, so chunking must remain.
    const messages = buildTranscript(120, 5_500);
    const smallWindow = 32_768;

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
    });

    expect(plan.mode).toBe("split");
  });

  it("does not treat an absent context window as unlimited headroom", () => {
    // Callers that omit contextWindow must keep the pre-existing chunk behavior.
    const messages = buildTranscript(120, 5_500);
    const maxChunkTokens = resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const plan = buildStageSplitPlan({ messages, maxChunkTokens });

    expect(plan.mode).toBe("split");
  });

  it("documents the ratio ceiling that forces the redundant split", () => {
    // Even the widest ratio caps the chunk budget below a fitting transcript,
    // which is why the fast path cannot be expressed via maxChunkTokens alone.
    const messages = buildTranscript(120, 5_500);
    const widestBudget =
      Math.floor(LARGE_CONTEXT_WINDOW * BASE_CHUNK_RATIO) - SUMMARIZATION_OVERHEAD_TOKENS;

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(widestBudget);
  });
});

describe("single-pass budget gating", () => {
  it("does not lift the chunk budget for the small-message shortcut", () => {
    // Three ~25K messages against a 65,536-token summarizer: the transcript does
    // NOT fit, but messages.length < minMessagesForSplit already returned "single"
    // before any fit check. Lifting the chunk cap here sends ~75K in one request.
    const smallWindow = 65_536;
    const messages = buildTranscript(3, 200_000);
    const totalTokens = estimateMessagesTokens(messages);
    expect(messages).toHaveLength(3);
    expect(totalTokens).toBeGreaterThan(smallWindow);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
      summaryOutputTokens: 0,
    });

    // The planner must tell callers whether the whole request was verified to fit,
    // so a legacy single-stage shortcut keeps its bounded chunk budget.
    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest ?? false).toBe(false);
  });

  it("marks a verified whole-request fit", () => {
    const messages = buildTranscript(120, 5_500);
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: 0,
    });

    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest).toBe(true);
  });
});

describe("single-pass plan serialization", () => {
  it("survives the worker round trip", () => {
    // The worker returns indexes, not messages, so the flag must be serialized
    // explicitly or a verified single-pass plan silently becomes bounded again.
    const messages = buildTranscript(120, 5_500);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: 0,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: true });
  });

  it("does not mark the small-message shortcut as a verified fit", () => {
    const messages = buildTranscript(3, 200_000);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, 65_536),
      contextWindow: 65_536,
      summaryOutputTokens: 0,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: false });
  });
});

describe("single-pass serialization overhead", () => {
  // Per-message role labels and separators are invisible to estimateTokens() but
  // real in the request: 10,000 two-character messages estimate at 10,000 tokens
  // and serialize to 36,250.
  function buildShortMessages(pairs: number): AgentMessage[] {
    return Array.from({ length: pairs * 2 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "ok",
      timestamp: 1_000 + index,
    })) as AgentMessage[];
  }

  it("declines a whole-history request that only fits before serialization", () => {
    const messages = buildShortMessages(7_000);
    const contextWindow = 32_768;
    const summaryOutputTokens = 4_096;
    const contentEstimate = estimateMessagesTokens(messages);

    // The content estimate alone clears the window with room to spare.
    expect(
      contentEstimate * SAFETY_MARGIN + SUMMARIZATION_OVERHEAD_TOKENS + summaryOutputTokens,
    ).toBeLessThan(contextWindow);

    // Keep the chunk budget under the transcript so the legacy shortcut cannot
    // answer first and the fit check is the branch under test.
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: 2_048,
      contextWindow,
      summaryOutputTokens,
    });

    // Serialized, the same history overflows, so chunking must stay bounded.
    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("still approves a history that fits once serialization is counted", () => {
    const messages = buildShortMessages(200);
    // Below maxChunkTokens the legacy shortcut answers first, so keep the chunk
    // budget under the transcript to exercise the fit check itself.
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: 64,
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan).toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});
