/** Close/reset path for ACP runtime sessions and persisted manager metadata. */
import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { toAcpRuntimeError } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { createSupersededActorError } from "./manager.runtime-handle-ensure.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import {
  discardPersistedManagerRuntimeState,
  isRecoverableManagerAcpxExitError,
  tryPrepareFreshManagerRuntimeSession,
} from "./manager.runtime-resume-state.js";
import type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  requireReadySessionMeta,
  resolveAcpSessionResolutionError,
  resolveAcpSessionTarget,
} from "./manager.utils.js";

/** Closes an ACP session runtime handle and optionally discards persistent state/meta. */
export async function runManagerCloseSession(params: {
  input: AcpCloseSessionInput;
  sessionKey: string;
  agentId: string;
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
}): Promise<AcpCloseSessionResult> {
  const { input, sessionKey, agentId } = params;
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(sessionKey);
  }
  input.assertActive?.();
  const resolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
    agentId,
  });
  const resolutionError = resolveAcpSessionResolutionError(resolution);
  if (resolutionError) {
    if (input.requireAcpSession ?? true) {
      throw resolutionError;
    }
    return {
      runtimeClosed: false,
      metaCleared: false,
    };
  }
  const meta = requireReadySessionMeta(resolution);
  const currentIdentity = resolveSessionIdentityFromMeta(meta);
  const shouldSkipRuntimeClose =
    input.discardPersistentState &&
    currentIdentity != null &&
    !identityHasStableSessionId(currentIdentity);

  // Maintenance cleanup of a terminal oneshot runs after turn finalization has
  // already closed and evicted its runtime handle (`oneshot-complete` in the turn
  // runner). There is nothing live to close: re-ensuring here would launch a new
  // prompt-less runtime session only to close it (and leave an orphan if that
  // close fails).
  //
  // The trusted maintenance flag is set only by the task-registry closer, after
  // that closer independently verifies a terminal, parent-owned oneshot with no
  // active task. Defense in depth: we ALSO require an in-layer terminal session
  // state here (`state !== "running"` — turn success/failure both leave "idle"/
  // "error", never "running"), so the bypass can never apply to an in-flight
  // oneshot even if a future caller supplied the deletion flags. We additionally
  // require the irrevocable deletion contract (`discardPersistentState +
  // clearMeta`, which destroys persisted state and the resume identity) and a
  // oneshot mode; the runtime close is skipped only when the cache is empty
  // (checked non-mutatingly, never via ensureRuntimeHandle). Manual close, reset,
  // and config reconfigure never set the flag and keep the real runtime close.
  const liveRuntimeHandle = params.runtimeHandles.get(
    resolveAcpSessionTarget({ cfg: input.cfg, sessionKey, agentId }),
  );
  const shouldMetadataOnlyCloseTerminalOneshot =
    !shouldSkipRuntimeClose &&
    input.terminalOneshotMaintenanceClose === true &&
    input.clearMeta === true &&
    input.discardPersistentState === true &&
    meta.mode === "oneshot" &&
    meta.state !== "running" &&
    liveRuntimeHandle === null;
  if (shouldMetadataOnlyCloseTerminalOneshot) {
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    input.assertActive?.();
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      agentId,
      isCurrentActor: params.isCurrentActor,
      mutate: () => null,
      failOnError: true,
    });
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    return {
      runtimeClosed: false,
      runtimeNotice:
        "Skipped runtime close for terminal oneshot without a live handle; cleared session metadata.",
      metaCleared: true,
    };
  }

  let runtimeClosed = false;
  let runtimeNotice: string | undefined;
  if (shouldSkipRuntimeClose) {
    input.assertActive?.();
    await tryPrepareFreshManagerRuntimeSession({
      deps: params.deps,
      cfg: input.cfg,
      meta,
      sessionKey,
      agentId,
      logPrefix: "acp close fast-reset",
    });
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    params.runtimeHandles.clear(params);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        assertActive: input.assertActive,
        cfg: input.cfg,
        sessionKey,
        agentId,
        meta,
        isCurrentActor: params.isCurrentActor,
      });
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(sessionKey);
      }
      input.assertActive?.();
      await ensuredRuntime.close({
        handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      });
      runtimeClosed = true;
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(sessionKey);
      }
      params.runtimeHandles.clear(params);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      if (!params.isCurrentActor()) {
        throw acpError;
      }
      input.assertActive?.();
      if (
        !isAcpOwnerRepairRequired(acpError) &&
        input.allowBackendUnavailable &&
        (acpError.code === "ACP_BACKEND_MISSING" ||
          acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
          (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
          (input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
          isRecoverableManagerAcpxExitError(acpError.message))
      ) {
        if (input.discardPersistentState) {
          input.assertActive?.();
          await tryPrepareFreshManagerRuntimeSession({
            deps: params.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            agentId,
            logPrefix: "acp close recovery",
            missingBackendError: acpError,
          });
          if (!params.isCurrentActor()) {
            throw acpError;
          }
        }
        // Treat unavailable backends as terminal for this cached handle so a
        // later operation cannot reuse an unusable runtime.
        if (!params.isCurrentActor()) {
          throw createSupersededActorError(sessionKey);
        }
        params.runtimeHandles.clear(params);
        runtimeNotice = acpError.message;
      } else {
        throw acpError;
      }
    }
  }

  if (input.discardPersistentState && !input.clearMeta) {
    await discardPersistedManagerRuntimeState({
      cfg: input.cfg,
      sessionKey,
      agentId,
      writeSessionMeta: params.writeSessionMeta,
      isCurrentActor: params.isCurrentActor,
    });
  }

  if (!params.isCurrentActor()) {
    throw createSupersededActorError(sessionKey);
  }
  const metaCleared = Boolean(input.clearMeta);
  if (metaCleared) {
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      agentId,
      isCurrentActor: params.isCurrentActor,
      mutate: () => null,
      failOnError: true,
    });
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
