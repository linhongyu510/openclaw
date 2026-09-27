/**
 * Regression for issue #159057: task-registry maintenance closes a terminal ACP
 * oneshot whose runtime handle was already closed/evicted by turn finalization.
 *
 * Before the fix, `closeSession` unconditionally re-ensured a runtime handle in
 * that state, launching a fresh prompt-less session just to close it (and
 * orphaning it if that close failed). The fix takes a metadata-only close for
 * the narrow `oneshot + discardPersistentState + clearMeta + no live handle`
 * maintenance combination while leaving every real runtime-close path intact.
 */
import { describe, expect, it } from "vitest";
import { runManagerCloseSession } from "./manager.close-session.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  baseCfg,
  createRuntime,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";
import type {
  AcpCloseSessionInput,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";

const MAINTENANCE_CLOSE = {
  discardPersistentState: true,
  clearMeta: true,
  allowBackendUnavailable: true,
  requireAcpSession: false,
} as const;

/**
 * Direct unit boundary for runManagerCloseSession: a real handle cache, a real
 * ready-session resolver, and a writable meta store. Only the runtime backend is
 * a fake (vi.fn ensureSession/close), so the oneshot/terminal decision is the
 * production code path — no security/lifecycle predicate is mocked.
 */
function harness(meta: SessionAcpMeta) {
  const runtimeState = createRuntime();
  const cache = new ManagerRuntimeHandleCache();
  const metaHolder: { current: SessionAcpMeta | null } = { current: meta };
  const resolveSession: ResolveManagerSession = () => ({
    kind: "ready",
    sessionKey: "agent:codex:acp:target",
    storeSessionKey: "agent:codex:acp:target",
    agentId: "codex",
    meta: metaHolder.current as SessionAcpMeta,
  });
  const writeSessionMeta: WriteManagerSessionMeta = async ({ mutate }) => {
    const next = mutate(metaHolder.current ?? undefined, undefined);
    metaHolder.current = next ?? null;
    return { sessionId: "s1", updatedAt: Date.now(), acp: metaHolder.current ?? undefined };
  };
  const ensureRuntimeHandle: EnsureManagerRuntimeHandle = async (params) => {
    const handle = await runtimeState.runtime.ensureSession({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      agent: "codex",
      mode: meta.mode,
    });
    const state = {
      runtime: runtimeState.runtime,
      handle,
      backend: "acpx",
      agent: "codex",
      mode: meta.mode,
    };
    cache.set({ sessionKey: params.sessionKey, agentId: params.agentId }, state);
    return { runtime: state.runtime, handle: state.handle, meta: params.meta };
  };
  const close = (input: AcpCloseSessionInput) =>
    runManagerCloseSession({
      input,
      sessionKey: "agent:codex:acp:target",
      agentId: "codex",
      deps: {
        getRuntimeBackend: () => ({ id: "acpx", runtime: runtimeState.runtime }),
      },
      runtimeHandles: cache,
      resolveSession,
      ensureRuntimeHandle,
      writeSessionMeta,
      isCurrentActor: () => true,
    });
  return { close, runtimeState, cache, metaHolder };
}

describe("runManagerCloseSession terminal oneshot metadata-only cleanup", () => {
  it.each(["terminal-task-cleanup", "orphaned-parent-task-cleanup"] as const)(
    "metadata-only closes a terminal oneshot without relaunching a runtime (%s)",
    async (reason) => {
      const h = harness(readySessionMeta({ mode: "oneshot", state: "idle" }));

      const result = await h.close({ cfg: baseCfg, sessionKey: "x", reason, ...MAINTENANCE_CLOSE });

      expect(h.runtimeState.ensureSession).not.toHaveBeenCalled();
      expect(h.runtimeState.close).not.toHaveBeenCalled();
      expect(result.runtimeClosed).toBe(false);
      expect(result.metaCleared).toBe(true);
      expect(result.runtimeNotice).toContain("terminal oneshot");
      // The bookkeeping close still completed: persisted metadata is deleted.
      expect(h.metaHolder.current).toBeNull();
    },
  );

  it("still really closes a persistent session that has no cached handle", async () => {
    const h = harness(readySessionMeta({ mode: "persistent", state: "idle" }));
    const result = await h.close({
      cfg: baseCfg,
      sessionKey: "x",
      reason: "orphaned-parent-task-cleanup",
      ...MAINTENANCE_CLOSE,
    });
    expect(h.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(h.runtimeState.close).toHaveBeenCalledTimes(1);
    expect(result.runtimeClosed).toBe(true);
    expect(result.metaCleared).toBe(true);
  });

  it("really closes a terminal oneshot that still has a live cached handle", async () => {
    const meta = readySessionMeta({ mode: "oneshot", state: "idle" });
    const h = harness(meta);
    // Pre-seed a live handle directly (as turn execution would for an in-flight
    // close). A present cache entry must take the real runtime close path even
    // for a maintenance oneshot close.
    const liveHandle = { sessionKey: "x", backendSessionId: "", agentSessionId: "" };
    h.cache.set(
      { sessionKey: "agent:codex:acp:target", agentId: "codex" },
      {
        runtime: h.runtimeState.runtime,
        handle: liveHandle as never,
        backend: "acpx",
        agent: "codex",
        mode: "oneshot",
      },
    );
    const result = await h.close({
      cfg: baseCfg,
      sessionKey: "x",
      reason: "terminal-task-cleanup",
      ...MAINTENANCE_CLOSE,
    });
    // A present cache entry prevents the metadata-only short circuit. Whether
    // ensure reuses it or replaces a meta-mismatched handle, it takes the real
    // runtime-close path (never the metadata-only skip).
    expect(h.runtimeState.close).toHaveBeenCalled();
    expect(result.runtimeClosed).toBe(true);
    expect(result.runtimeNotice).toBeUndefined();
  });

  it("does not metadata-only close a manual oneshot close without clear/discard", async () => {
    const h = harness(readySessionMeta({ mode: "oneshot", state: "idle" }));
    const result = await h.close({
      cfg: baseCfg,
      sessionKey: "x",
      reason: "manual-close",
      allowBackendUnavailable: true,
    });
    expect(h.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(h.runtimeState.close).toHaveBeenCalledTimes(1);
    expect(result.runtimeClosed).toBe(true);
    expect(result.metaCleared).toBe(false);
  });
});
