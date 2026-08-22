/**
 * RFC-06 F5 — the TYPED outcome the host's `setSkillEnabled` projection returns
 * to the kernel scheduler for a `session.skill.set_enabled` command.
 *
 * A PLAIN structural mirror of the F1 authority's `SkillSetEnabledRejection`
 * arms (the `@/skill` VALUE slice is never imported by `@/protocol`; only this
 * plain shape crosses the kernel/host boundary — it does NOT cross the wire, so
 * it needs no generator narrowing). A negative arm is a typed refusal with NO
 * live mutation and NO success echo (RFC-06 F5 hard rule: unsupported-host /
 * stale / policy / persist ⇒ a typed negative, never a silent success). On `ok`
 * the scheduler emits the session revision echo the reducer produced; the host
 * being ABSENT (not returning this) is the distinct unsupported-host negative the
 * scheduler raises.
 */
export type SkillCommandOutcome =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false
      readonly kind: "stale_revision"
      readonly expected: number
      readonly actual: number
    }
  | { readonly ok: false; readonly kind: "unknown_skill"; readonly name: string }
  | {
      readonly ok: false
      readonly kind: "policy_denied"
      readonly name: string
      readonly reason: "required" | "banned"
    }
  | { readonly ok: false; readonly kind: "persist_failed"; readonly detail: string }
