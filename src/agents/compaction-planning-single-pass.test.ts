// Compaction must not force map-reduce when the whole history fits one summarizer call.
import { describe, expect, it } from "vitest";
import {
  BASE_CHUNK_RATIO,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import type { AgentMessage } from "./runtime/index.js";

// Mirrors the reported deployment: a 262K-window summarizer over a ~164K transcript.
const LARGE_CONTEXT_WINDOW = 262_144;

function buildTranscript(messageCount: number, charsPerMessage: number): AgentMessage[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${index} ${"context ".repeat(Math.floor(charsPerMessage / 8))}`,
    timestamp: 1_000 + index,
  }));
}

function resolveMaxChunkTokens(messages: AgentMessage[], contextWindow: number): number {
  const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
  return Math.max(1, Math.floor(contextWindow * ratio) - SUMMARIZATION_OVERHEAD_TOKENS);
}

describe("compaction single-pass fast path", () => {
  it("summarizes in one call when the whole history fits the summarizer window", () => {
    const messages = buildTranscript(120, 11_000);
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
    const messages = buildTranscript(400, 11_000);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("split");
  });

  it("keeps splitting for small-window summarizers", () => {
    // A 32K summarizer cannot absorb the same transcript, so chunking must remain.
    const messages = buildTranscript(120, 11_000);
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
    const messages = buildTranscript(120, 11_000);
    const maxChunkTokens = resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const plan = buildStageSplitPlan({ messages, maxChunkTokens });

    expect(plan.mode).toBe("split");
  });

  it("documents the ratio ceiling that forces the redundant split", () => {
    // Even the widest ratio caps the chunk budget below a fitting transcript,
    // which is why the fast path cannot be expressed via maxChunkTokens alone.
    const messages = buildTranscript(120, 11_000);
    const widestBudget =
      Math.floor(LARGE_CONTEXT_WINDOW * BASE_CHUNK_RATIO) - SUMMARIZATION_OVERHEAD_TOKENS;

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(widestBudget);
  });
});

describe("single-pass chunk budget", () => {
  it("emits one summarization chunk when the history fits the window", () => {
    const messages = buildTranscript(120, 11_000);
    const maxChunkTokens = resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW);
    // A "single" stage plan still routes through buildSummaryChunks, so the
    // per-chunk budget must also admit the whole history or it gets re-split.
    const chunks = buildSummaryChunks({
      messages,
      maxChunkTokens,
      contextWindow: LARGE_CONTEXT_WINDOW,
    });
    expect(chunks).toHaveLength(1);
  });
});
