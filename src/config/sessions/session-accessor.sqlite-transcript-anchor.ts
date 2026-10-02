import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Reads one active message identity from the caller's current SQLite transaction. */
export function readActiveTranscriptEntryAnchorInTransaction(params: {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
}): TranscriptEntryAnchor | undefined {
  // Branch changes retain old projection rows until deferred reconciliation.
  // An anchor must never certify those rows as the current active path.
  if (sessionTranscriptIndexNeedsReconcile(params.database.db, params.resolved.sessionId)) {
    return undefined;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
        join.onRef("rewrite.session_id", "=", "identity.session_id"),
      )
      .select([
        "identity.seq",
        "identity.parent_id",
        "identity.message_idempotency_key",
        "active.message_position",
        "rewrite.generation",
      ])
      .where("identity.session_id", "=", params.resolved.sessionId)
      .where("identity.event_id", "=", params.entryId)
      .limit(1),
  );
  return createTranscriptEntryAnchor({ ...params, row });
}

/** Projects anchor fields after the caller verifies readiness in the same snapshot. */
export function createTranscriptEntryAnchor(params: {
  database: Pick<OpenClawAgentDatabase, "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
  row:
    | {
        seq: number;
        parent_id: string | null;
        message_idempotency_key: string | null;
        message_position: number | null;
        generation: string | null;
      }
    | undefined;
}): TranscriptEntryAnchor | undefined {
  const { row } = params;
  if (
    row?.message_position === null ||
    row?.message_position === undefined ||
    row.generation === null
  ) {
    return undefined;
  }
  const idempotencyKey = row.message_idempotency_key ?? readMessageIdempotencyKey(params.message);
  return Object.freeze({
    agentId: params.resolved.agentId,
    sessionId: params.resolved.sessionId,
    sessionKey: params.resolved.sessionKey,
    storePath: params.database.path,
    generation: row.generation,
    entryId: params.entryId,
    rawSeq: row.seq,
    effectiveParentId: row.parent_id,
    activeMessagePosition: row.message_position,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** Reads one active message identity from the authoritative SQLite projection. */
export function readActiveTranscriptEntryAnchor(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): TranscriptEntryAnchor | undefined {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readActiveTranscriptEntryAnchorInTransaction({
    database,
    resolved,
    entryId: params.entryId,
  });
}

/** Result of an anchor read together with the index state observed in one snapshot. */
export interface ActiveTranscriptAnchorRead {
  /** The active anchor, or undefined when the projection is dirty or has no active row. */
  anchor: TranscriptEntryAnchor | undefined;
  /**
   * True when the projection index was transiently dirty (needs reconciliation) at read time,
   * so the anchor was short-circuited -- as opposed to a clean index that genuinely has no
   * active row for the cached entry.
   */
  indexDirty: boolean;
}

/**
 * Reads the active anchor together with the reconcile state against ONE opened database
 * snapshot. This lets callers distinguish a transiently dirty index (benign duplicate
 * delivery during the ~0.5-10s reconcile window) from a clean index whose active projection
 * no longer contains the cached entry (another writer removed/rewrote it).
 */
export function readActiveTranscriptEntryAnchorStatus(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): ActiveTranscriptAnchorRead {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  // Fail-closed: observe reconcile state first, on the same snapshot used for the anchor join.
  const indexDirty = sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId);
  if (indexDirty) {
    return { anchor: undefined, indexDirty: true };
  }
  return {
    anchor: readActiveTranscriptEntryAnchorInTransaction({
      database,
      resolved,
      entryId: params.entryId,
    }),
    indexDirty: false,
  };
}
