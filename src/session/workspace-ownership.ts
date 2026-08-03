/**
 * RFC-06 §RFC06-0 — persisted WorkspaceOwnership helpers (aug-02 absorption).
 *
 * PURE data helpers + a zod schema for the optional `workspaceOwnership` record
 * on {@link SessionMeta}. This RIDES the EXISTING atomic session snapshot
 * (`saveSessionById`/`loadSessionById`) — there is NO new binding/lease/TTL
 * store, NO reaper, NO PID/path-name ownership inference. The `@/session` slice
 * owns the record SHAPE, its validation, and the closed lifecycle transition
 * rule; the runtime git adapter (`@/runtime/worktree-inspect`) owns porcelain
 * inspection; the runner session-op orders user intent.
 *
 * Fail-closed migration contract (mirrors `rollback-record.ts`):
 *   - the field is OPTIONAL: absent on legacy/non-worktree sessions ⇒ the
 *     non-strict `sessionMetaSchema` validates and serialization is
 *     byte-identical.
 *   - `recordVersion` is pinned to a literal and `state` is a closed enum, so
 *     an UNKNOWN version/state fail-closes the WHOLE snapshot load (the file is
 *     refused, never partially applied).
 *
 * No behaviour, no I/O, no clock — callers inject `createdAt`/`updatedAt` from
 * their own injected clock so these helpers stay deterministic.
 */

import { z } from "zod"
import {
  WORKSPACE_OWNERSHIP_VERSION,
  type WorkspaceOwnership,
  type WorkspaceOwnershipState,
} from "./types"

/* ------------------------------------------------------------------ */
/* closed lifecycle transition table                                   */
/* ------------------------------------------------------------------ */

/** All valid `from → to` transitions of the closed workspace lifecycle. A
 *  transition NOT in this map is rejected by {@link transitionWorkspaceState}
 *  (typed failure, never silently applied). `creating` is the durable intent
 *  written BEFORE the git effect; `ready`/`active` are published AFTER the
 *  effect; `closing`→`removed` is teardown; `failed`/`quarantined` are terminal
 *  error states reachable from any pre-terminal state.
 *
 * A `creating` record with no forward transition is operator-visible recovery —
 * it is NEVER auto-promoted to `ready`; that must be an explicit effect
 * receipt. Terminal states (`removed`/`failed`/`quarantined`) have NO outgoing
 * transition (no resurrection). */
const ALLOWED_TRANSITIONS: Readonly<
  Record<WorkspaceOwnershipState, readonly WorkspaceOwnershipState[]>
> = {
  // intent → effect-published, or teardown-before-ready, or error.
  creating: ["ready", "closing", "failed", "quarantined"],
  // published → activated, teardown, or error (a stale-ready worktree may be
  // quarantined by GC).
  ready: ["active", "closing", "failed", "quarantined"],
  // active → teardown, or error.
  active: ["closing", "failed", "quarantined"],
  // teardown-in-progress → removed (success) or error.
  closing: ["removed", "failed", "quarantined"],
  // terminal states — no resurrection.
  removed: [],
  failed: [],
  quarantined: [],
}

/** `true` iff `state` is terminal (no outgoing transition). */
export const isTerminalWorkspaceState = (state: WorkspaceOwnershipState): boolean =>
  ALLOWED_TRANSITIONS[state].length === 0

/** `true` iff `from → to` is a permitted lifecycle transition. A same-state
 *  self-transition is NOT allowed (repeated transitions are rejected — the
 *  caller must have observed a real state change). */
export const isValidWorkspaceTransition = (
  from: WorkspaceOwnershipState,
  to: WorkspaceOwnershipState,
): boolean => ALLOWED_TRANSITIONS[from].includes(to)

/* ------------------------------------------------------------------ */
/* zod schema (consumed by the store loader — single SSOT)             */
/* ------------------------------------------------------------------ */

/** Closed lifecycle enum — a wire value outside this set fail-closes the load
 *  (zod `enum` rejects unknown strings). Mirrors {@link WorkspaceOwnershipState}
 *  exactly; adding a state here is a compile-forced update at every consumer. */
export const workspaceOwnershipStateSchema: z.ZodType<WorkspaceOwnershipState> = z.enum([
  "creating",
  "ready",
  "active",
  "closing",
  "removed",
  "failed",
  "quarantined",
])

/** A persisted workspace-ownership record. `recordVersion` is pinned to the
 *  current literal so a forward-incompatible record refuses to load rather than
 *  being half-read. All identity/target fields are non-empty strings; a blank
 *  `path`/`branch`/`ownershipId` is a corrupt record and fail-closes. */
export const workspaceOwnershipSchema = z.object({
  recordVersion: z.literal(WORKSPACE_OWNERSHIP_VERSION),
  ownershipId: z.string().min(1),
  ownerThreadId: z.string().min(1),
  repoRoot: z.string().min(1),
  repoId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
  state: workspaceOwnershipStateSchema,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastErrorCode: z.string().min(1).optional(),
})

/* ------------------------------------------------------------------ */
/* pure record helpers                                                 */
/* ------------------------------------------------------------------ */

/** Input to mint a `creating` intent record. All identity/target facts are
 *  supplied by the caller (composition) — NONE are derived from PID/path. */
export interface WorkspaceCreateIntent {
  ownershipId: string
  ownerThreadId: string
  repoRoot: string
  repoId: string
  path: string
  branch: string
  baseSha: string
  /** Injected clock — epoch-ms. */
  now: number
}

/** Build the durable `creating` INTENT record. Written BEFORE the git effect;
 *  the caller persists it, runs `createPersistentWorktree`, THEN transitions to
 *  `ready`. Pure — no I/O, no clock (clock is injected via `intent.now`). */
export const makeWorkspaceCreateIntent = (intent: WorkspaceCreateIntent): WorkspaceOwnership => ({
  recordVersion: WORKSPACE_OWNERSHIP_VERSION,
  ownershipId: intent.ownershipId,
  ownerThreadId: intent.ownerThreadId,
  repoRoot: intent.repoRoot,
  repoId: intent.repoId,
  path: intent.path,
  branch: intent.branch,
  baseSha: intent.baseSha,
  state: "creating",
  createdAt: intent.now,
  updatedAt: intent.now,
})

/** Typed result of a lifecycle transition attempt. */
export type WorkspaceTransitionResult =
  | { readonly ok: true; readonly record: WorkspaceOwnership }
  | { readonly ok: false; readonly reason: string }

/**
 * Transition a workspace-ownership record to `to`, returning a NEW record on
 * success or a typed refusal. An INVALID or REPEATED transition (same-state, or
 * not in the closed table) is REFUSED — never silently applied. `errorCode` is
 * carried onto `failed`/`quarantined` targets. Never mutates the input.
 */
export const transitionWorkspaceState = (
  record: WorkspaceOwnership,
  to: WorkspaceOwnershipState,
  now: number,
  errorCode?: string,
): WorkspaceTransitionResult => {
  if (record.state === to) {
    return { ok: false, reason: `repeated transition: already in "${to}"` }
  }
  if (!isValidWorkspaceTransition(record.state, to)) {
    return { ok: false, reason: `invalid transition: "${record.state}" → "${to}"` }
  }
  const next: WorkspaceOwnership = {
    ...record,
    state: to,
    updatedAt: now,
    ...(errorCode !== undefined ? { lastErrorCode: errorCode } : {}),
  }
  return { ok: true, record: next }
}
