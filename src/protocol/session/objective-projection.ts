/**
 * RFC-03 M7 — the TYPED outcome the host's `mutateObjective` projection returns
 * to the kernel scheduler for a `session.objective.mutate` command.
 *
 * A PLAIN structural mirror of the objective authority's `commit` result arms
 * (the `@/objective` VALUE slice is never imported by `@/protocol`; only this
 * plain shape crosses the kernel/host boundary — it does NOT cross the wire, so
 * it needs no generator narrowing). A negative arm is a typed refusal with NO
 * live mutation and NO success echo (M7 hard rule: a stale / policy-rejected
 * objective edit must conflict, never a silent `session.state.updated`).
 *
 * On `ok` the scheduler emits the session-revision echo the reducer produced.
 * The host projection being ABSENT is NOT an error here (unlike posture/skill):
 * the objective domain is optional and a host that wired no authority is a
 * benign no-op echo — the scheduler treats that as `ok` (the authority-absent
 * `ok:true` is produced by the host adapter itself).
 */
export type ObjectiveCommandOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly kind: "stale_revision"
      readonly expected: number
      readonly actual: number
    }
  | { readonly ok: false; readonly kind: "rejected"; readonly reason: string }
