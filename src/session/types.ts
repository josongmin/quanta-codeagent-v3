import type { Message } from "@/llm"

/**
 * Id-addressable session persistence — V2 schema.
 *
 * V1 (path-based) lives in `src/agent/state.ts` and is NOT touched. This slice
 * is a NEW rail next to it: callers mint an opaque id and we keep the file at
 * `<sessionsRoot>/<id>.json` (or `<sessionsRoot>/archived/<id>.json` when
 * archived) plus a single `index.jsonl` for cheap listing. Inspired by the
 * Codex CLI's session UX.
 *
 * Schema bump: `SESSION_VERSION = 2` so a future reader can tell V1 / V2 apart
 * (their on-disk shapes differ — V2 has a `meta` envelope; V1 has flat fields).
 */
export const SESSION_VERSION = 2 as const

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastTouched: number
  archived: boolean
  /** ADR-0106 git fingerprint (Codex §18.9 absorption). Captured at session
   *  start when the cwd is a git repository; each field is independent —
   *  a detached HEAD has SHA but no branch; a local-only repo has branch
   *  but no originUrl. Absent fields mean "not captured" (cwd not a repo,
   *  spawn failure, etc.) — never lossy stripping. */
  gitSha?: string
  gitBranch?: string
  gitOriginUrl?: string
  /** Session id this transcript was forked from (`forkSession`). Absent on
   *  non-fork sessions AND on legacy transcripts minted before this field —
   *  absent means "no known parent", never lossy stripping (same discipline as
   *  the git-fingerprint fields above). Persisted so a `/fork` lineage chain
   *  survives rename + reload (the `" (fork)"` title suffix is cosmetic and
   *  mutable). The parent may later be deleted — this is provenance metadata,
   *  not a live pointer, so a dangling reference is acceptable. */
  forkedFromId?: string
  /* ----------------------------------------------------------------- */
  /* §8.2 (jun-08 long-tail) — Codex session-meta provenance fields.   */
  /* ALL OPTIONAL: absent on every legacy transcript ⇒ the (non-strict) */
  /* `sessionMetaSchema` still validates, and `JSON.stringify` drops    */
  /* `undefined` props so a session that never set them serializes      */
  /* byte-identically to the prior on-disk shape. Same discipline as    */
  /* the git-fingerprint optionals above — absent means "not captured", */
  /* never lossy stripping.                                             */
  /* ----------------------------------------------------------------- */
  /** Human-friendly agent label (Codex `agent_nickname`). Cosmetic. */
  agentNickname?: string
  /** Tool names dynamically added to this session (Codex `dynamic_tools`
   *  snapshot — the persisted set; see the `dynamic_tools` envelope record
   *  for the per-add event log). */
  dynamicTools?: string[]
  /** What spawned this session (Codex `originator` — "cli"/"vscode"/an
   *  app id). Provenance. */
  originator?: string
  /** Where the thread came from (Codex `thread_source` —
   *  "new"/"resumed"/"forked"/"subagent"). */
  threadSource?: string
  /** Provider transport that served the session (Codex `model_provider`
   *  — "anthropic"/"openai"/"chatgpt-oauth"). `model` above is the model
   *  id; this is the provider. */
  modelProvider?: string
  /* ----------------------------------------------------------------- */
  /* §13.2 (jun-08 long-tail) — PERSISTED interrupted-turn marker for   */
  /* crash recovery. The in-memory `InterruptedTurnBuffer` (jun-08)      */
  /* survives only WITHIN a process; a hard crash mid-turn loses it.     */
  /* This optional marker is written to the SNAPSHOT so a restart can    */
  /* DETECT a session that died mid-turn and OFFER to resume it. Absent  */
  /* ⇒ no interrupted turn (byte-identical default-OFF). Cleared on a    */
  /* clean turn completion. See `src/session/crash-resume.ts`.          */
  /* ----------------------------------------------------------------- */
  interruptedTurn?: PersistedInterruptedTurn
}

/** §13.2 — the persisted crash-resume marker stored on {@link SessionMeta}.
 *  Mirrors the in-memory `InterruptedTurn` shape (userText / partial progress
 *  / reason / wall-clock) so the restart-resume path can rebuild the exact
 *  same resume message the in-process buffer would have. Pure data — no
 *  behavior; absent unless a turn was persisted as interrupted. */
export interface PersistedInterruptedTurn {
  /** The user prompt that started the interrupted turn. */
  userText: string
  /** Assistant text produced before the crash/interrupt (partial progress). */
  partialAssistantText: string
  /** Why it was interrupted (e.g. "crash", a cancel reason). */
  reason: string
  /** Wall-clock ms when the turn was marked interrupted (injected clock). */
  interruptedAt: number
}

export interface SavedSession {
  version: typeof SESSION_VERSION
  meta: SessionMeta
  reason: string
  turns: number
  messages: Message[]
}

export interface SavePayload {
  reason: string
  turns: number
  messages: Message[]
}
