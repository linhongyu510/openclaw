// Three-state regression for the duplicate keyed-user dedup boundary.
//
// A duplicate keyed-user delivery that hits this manager's cached current turn
// can get an `anchor === undefined` for two very different reasons, which must be
// kept apart:
//   (A) the projection index is transiently dirty (needs_rebuild=1) -- a benign
//       ~0.5-10s window after a concurrent side-append (#152511): degrade to an
//       idempotent no-op without throwing.
//   (B) the index is clean and the cached turn IS active: return its anchor.
//   (C) the index is clean but the cached turn has no active row -- another
//       manager removed/rewrote it (stale cache): must REJECT, never silently
//       false-acknowledge a non-existent turn.
//
// Also covers (D) a normal fresh append and (E) the async wrapper delegating to
// this same decision.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

function assistantMessage(text: string) {
  return { role: "assistant" as const, content: text, timestamp: 1 };
}

function userMessage(key: string, content = "hi") {
  return { role: "user" as const, content, idempotencyKey: key, timestamp: 1 };
}

async function seedSession(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  await upsertSessionEntryCore(scope, {
    sessionFile: formatSqliteSessionFileMarker(scope),
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  await appendTranscriptMessage(scope, {
    cwd: path.dirname(scope.storePath),
    eventId: "existing-assistant",
    message: assistantMessage("previous answer"),
    now: 1,
  });
}

function markIndexDirty(
  scope: { agentId: string; sessionId: string; sessionKey: string },
  dir: string,
) {
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath({
      ...scope,
      storePath: path.join(dir, "sessions.json"),
    }),
  });
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
}

describe("SessionManager anchor dedup three-state boundary", () => {
  it("A: transiently dirty index degrades duplicate keyed delivery without throwing", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-a-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-a",
      sessionKey: "agent:main:dashboard:anchor-3state-a",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-a:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);
    expect(appendedId).toBeDefined();

    markIndexDirty(scope, dir);

    const dedup = m1.appendMessageWithTranscriptAnchor(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });

  it("B: clean index duplicate returns the existing canonical anchor", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-b-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-b",
      sessionKey: "agent:main:dashboard:anchor-3state-b",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-b:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // Index is clean (no side-append); the cached turn is active, so the anchor
    // resolves to a real canonical anchor.
    const dedup = m1.appendMessageWithTranscriptAnchor(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeDefined();
    expect(dedup.anchor?.entryId).toBe(appendedId);
  });

  it("C: a stale cached turn removed by another manager is rejected, not false-acked", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-c-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-c",
      sessionKey: "agent:main:dashboard:anchor-3state-c",
      storePath: path.join(dir, "sessions.json"),
    };
    const key = "anchor-3state-c:user";
    const user = userMessage(key);
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    m1.appendMessage(user);

    // A second manager on the same session removes the trailing keyed user K.
    const m2 = SessionManager.open(scope, dir);
    const removed = m2.removeTrailingEntries(
      (entry) =>
        (entry as { message?: { idempotencyKey?: string } }).message?.idempotencyKey === key,
    );
    expect(removed).toBeGreaterThan(0);

    // m1 never reloaded; its local cache still points at the removed turn. The
    // index is clean, so the active projection has no row for the cached entry
    // -- this must reject, not return appended:false.
    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("D: a fresh (non-duplicate) keyed append persists with appended:true and an anchor", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-d-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-d",
      sessionKey: "agent:main:dashboard:anchor-3state-d",
      storePath: path.join(dir, "sessions.json"),
    };
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const result = m1.appendMessageWithTranscriptAnchor(userMessage("anchor-3state-d:user"));
    expect(result.appended).toBe(true);
    expect(result.anchor).toBeDefined();
    expect(result.entryId).toBeDefined();
  });

  it("E: the async user wrapper shares the dirty-index degrade (no throw)", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-e-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-e",
      sessionKey: "agent:main:dashboard:anchor-3state-e",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-e:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);
    markIndexDirty(scope, dir);

    const dedup = await m1.appendMessageWithTranscriptAnchorAsync(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });

  it("F: dirty index but cached turn's identity row is gone still rejects (no false-ack)", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-f-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-f",
      sessionKey: "agent:main:dashboard:anchor-3state-f",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-f:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // Simulate another writer that both leaves the projection dirty AND physically removes
    // the cached turn's authoritative identity row (what a suffix remove does). Degrading on
    // "dirty" alone would false-acknowledge a non-existent turn; it must reject instead.
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath({ ...scope, storePath: scope.storePath }),
    });
    database.db
      .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .run(scope.sessionId, appendedId);
    database.db
      .prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1, leaf_event_id = 'some-other-turn' WHERE session_id = ?",
      )
      .run(scope.sessionId);

    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("G: dirty index but cached turn displaced off the canonical active path still rejects", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-g-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-g",
      sessionKey: "agent:main:dashboard:anchor-3state-g",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-g:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // Production stale-row mechanism: a leaf control / alternative-parent append marks the
    // index dirty WITHOUT removing the cached user's old active-event rows (reconciliation
    // rebuilds later). Only the canonical leaf moves elsewhere. Degrading on active-row
    // membership would false-ack; the leaf must not equal the cached turn -> reject.
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath({ ...scope, storePath: scope.storePath }),
    });
    database.db
      .prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1, leaf_event_id = 'some-other-turn' WHERE session_id = ?",
      )
      .run(scope.sessionId);

    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
    void appendedId;
  });

  it("H: duplicate delivery inside an enclosing write transaction reaches the replay", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-h-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-h",
      sessionKey: "agent:main:dashboard:anchor-3state-h",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-h:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    m1.appendMessage(user);

    // Pass the fixture's agent + store path (database options) so the callback actually opens
    // the agent db and reaches the replay (without options it threw TypeError before replay).
    // Reject ANY thrown error, and assert the dedup actually replayed.
    let replay: ReturnType<SessionManager["appendMessageWithTranscriptAnchor"]> | undefined;
    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        expect(database).toBeDefined();
        replay = m1.appendMessageWithTranscriptAnchor(user);
      }, scope),
    ).not.toThrow();
    expect(replay?.appended).toBe(false);
  });
});
