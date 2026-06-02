import { createEffortClassifier } from "@/agent/effort-classifier"
import { createFastApplyFallback } from "@/agent/fast-apply-fallback"
import { dispatchSideConversation } from "@/agent/side-conversation"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import type { LLMPort } from "@/llm"
import { defaultRoleModelResolver, type RoleModelResolver } from "@/llm/role-model-override"
import { AgentMetaRegistry, TurnWakeRegistry } from "@/subagent"
import type { AgentConfig } from "./types"

const QUANTA_FAST_APPLY_ENV = "QUANTA_FAST_APPLY"
const QUANTA_EFFORT_AUTO_ENV = "QUANTA_EFFORT_AUTO"
const QUANTA_SUBAGENT_MAILBOX_ENV = "QUANTA_SUBAGENT_MAILBOX"
/** RFC-02 / ADR-0436 — `spawn_batch` fan-out tool gate. */
const QUANTA_SUBAGENT_BATCH_ENV = "QUANTA_SUBAGENT_BATCH"
/** RFC-04 / ADR-0437 — `list_agents` read-only enumeration tool gate. */
const QUANTA_SUBAGENT_INTROSPECT_ENV = "QUANTA_SUBAGENT_INTROSPECT"
/** RFC-04 / ADR-0437 — `followup_task` deliver-and-trigger tool gate. */
const QUANTA_SUBAGENT_FOLLOWUP_ENV = "QUANTA_SUBAGENT_FOLLOWUP"

/** Per-sender undelivered quota baked into the env-gated wire (R3 audit-H).
 *  Hosts wiring the mailbox by hand still get to override via the closed-port
 *  option; this constant only governs the default-on path. 32 = ~16× the
 *  expected steady-state sibling fan-out (subagent siblings rarely exceed 4)
 *  while still being tiny vs the 1024-cell global cap, so legitimate burst
 *  traffic stays below it and a hostile flood is capped within ~1 round-trip. */
const DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER = 32

type OptionalPortEnv = Readonly<Record<string, string | undefined>>

type OptionalPortBase = Pick<
  AgentConfig,
  | "llm"
  | "signal"
  | "modelCandidates"
  | "fastApplyFallback"
  | "effortClassifier"
  | "roleModelResolver"
  | "sessionId"
> &
  Partial<AgentConfig>

const envGateOn = (env: OptionalPortEnv, key: string): boolean => env[key] === "on"

const resolveModelPort = (base: OptionalPortBase, modelId: string): LLMPort | null => {
  if (base.llm.model === modelId) return base.llm
  return base.modelCandidates?.find((candidate) => candidate.id === modelId)?.port ?? null
}

const resolveSessionId = (base: OptionalPortBase): string => base.sessionId ?? crypto.randomUUID()

const roleModelResolverOf = (base: OptionalPortBase): RoleModelResolver | undefined => {
  return base.roleModelResolver
}

export const wireOptionalAgentPorts = <T extends OptionalPortBase>(
  base: T,
  // REQUIRED — the composition root (apps/host/runner) passes its already-loaded
  // env so this slice never reads `process.env` itself (slice-boundary
  // invariant). Pass `{}` for a hermetic wire (every `=on` gate stays off).
  env: OptionalPortEnv,
): T => {
  let next = base

  if (envGateOn(env, QUANTA_FAST_APPLY_ENV)) {
    const roleModelResolver = roleModelResolverOf(next) ?? defaultRoleModelResolver()
    if (next.roleModelResolver === undefined) {
      next = { ...next, roleModelResolver } as T
    }
    if (next.fastApplyFallback === undefined) {
      const defaultModel = next.llm.model
      if (defaultModel !== undefined && defaultModel.length > 0) {
        const parentSessionId = resolveSessionId(next)
        next = {
          ...next,
          fastApplyFallback: createFastApplyFallback({
            roleResolver: roleModelResolver,
            defaultModel,
            sideConversation: {
              dispatch: async (req) => {
                const llm = resolveModelPort(next, req.model)
                if (llm === null) return { ok: false, text: "" }
                const result = await dispatchSideConversation(
                  {
                    parentSessionId,
                    question: req.prompt,
                    model: req.model,
                  },
                  {
                    resolveLlm: () => llm,
                    resolveTools: () => [],
                    signal: next.signal,
                  },
                )
                return { ok: true, text: result.answer }
              },
            },
          }),
        } as T
      }
    }
  }

  if (next.effortClassifier === undefined && envGateOn(env, QUANTA_EFFORT_AUTO_ENV)) {
    next = {
      ...next,
      effortClassifier: createEffortClassifier(),
    } as T
  }

  // R3 audit-H production wire for the subagent mailbox. Default-OFF (the
  // tier-1 builder still returns [] when `subagentMailbox` is undefined). Env
  // gate `QUANTA_SUBAGENT_MAILBOX=on` flips it on with the per-sender DoS cap
  // BAKED IN — the audit-H R2 contract becomes a property of every production
  // wiring instead of a knob a downstream caller might forget to set.
  if (next.subagentMailbox === undefined && envGateOn(env, QUANTA_SUBAGENT_MAILBOX_ENV)) {
    next = { ...next, subagentMailbox: defaultSubagentMailbox() } as T
  }

  // RFC-02/04 — subagent batch + introspect + followup tool gates. Extracted
  // so this function stays under biome's cognitive-complexity cap. Each gate is
  // default-OFF (`=on` only); unset ⇒ `next` returned verbatim (byte-identical).
  return wireSubagentToolGates(next, env)
}

/** Mailbox factory shared with the `QUANTA_SUBAGENT_MAILBOX` gate so a
 *  `followup`-only operator still gets the same per-sender DoS cap baked in. */
const defaultSubagentMailbox = () =>
  createSubagentMailbox({
    maxUndeliveredPerSender: DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER,
  })

/**
 * RFC-02 (ADR-0436) + RFC-04 (ADR-0437) — composition-root activation of the
 * `spawn_batch` / `list_agents` / `followup_task` subagent tools, plus the
 * introspect dependency ports so the tools are FUNCTIONAL (not just present).
 *
 * Three independent env gates (all strict `=on`, all default-OFF):
 *   - `QUANTA_SUBAGENT_BATCH=on`      ⇒ `subagent.enableBatchSpawn = true`.
 *   - `QUANTA_SUBAGENT_INTROSPECT=on` ⇒ `subagent.enableIntrospect = true` +
 *     a shared {@link AgentMetaRegistry} side-table (richer `list_agents` rows).
 *   - `QUANTA_SUBAGENT_FOLLOWUP=on`   ⇒ `subagent.enableFollowup = true` +
 *     a shared {@link TurnWakeRegistry} (the TRIGGER substrate the subagent
 *     runner registers per-child wakers into — this is what makes a followup
 *     actually wake a child instead of degrading to `cause:"no_waker"`) +
 *     a {@link createSubagentMailbox} (the DELIVERY substrate) when the host
 *     did not already wire one via `QUANTA_SUBAGENT_MAILBOX`.
 *
 * Because the tier-1 batch builder requires a runner (`config.subagent` must
 * exist) and the introspect builder joins `config.subagent.taskRegistry`, ANY
 * enabled gate first ensures the nested `subagent` block exists (an empty `{}`
 * — the runner-enabling default; byte-identical to `QUANTA_SUBAGENT` on).
 * Caller-override-precedence (ADR-0332): a pre-set flag / port on `base` is
 * preserved verbatim.
 *
 * Default-OFF byte-identical (RFC §1.2): with every gate unset, `base` is
 * returned UNCHANGED — no `subagent` block is created, the tier-1 builders see
 * the flags absent, and the ToolRegistry is byte-identical.
 */
const wireSubagentToolGates = <T extends OptionalPortBase>(base: T, env: OptionalPortEnv): T => {
  const wantBatch = envGateOn(env, QUANTA_SUBAGENT_BATCH_ENV)
  const wantIntrospect = envGateOn(env, QUANTA_SUBAGENT_INTROSPECT_ENV)
  const wantFollowup = envGateOn(env, QUANTA_SUBAGENT_FOLLOWUP_ENV)
  if (!wantBatch && !wantIntrospect && !wantFollowup) return base

  let next = base
  // Any gate needs the runner to exist (batch) / the shared registry to live
  // (introspect/followup), so ensure the nested `subagent` block is present.
  // Empty `{}` is the runner-enabling default (== `QUANTA_SUBAGENT` on).
  const subagent: NonNullable<AgentConfig["subagent"]> = { ...(next.subagent ?? {}) }

  if (wantBatch && subagent.enableBatchSpawn !== true) subagent.enableBatchSpawn = true
  if (wantIntrospect && subagent.enableIntrospect !== true) subagent.enableIntrospect = true
  if (wantFollowup && subagent.enableFollowup !== true) subagent.enableFollowup = true
  next = { ...next, subagent } as T

  // Introspect dep — richer `list_agents` rows (depth/label). Optional even
  // when enabled (absent ⇒ depth=0 + description-derived label). Caller wins.
  if (wantIntrospect && next.subagentAgentMeta === undefined) {
    next = { ...next, subagentAgentMeta: new AgentMetaRegistry() } as T
  }

  // Followup deps — TRIGGER (shared TurnWakeRegistry the runner registers child
  // wakers into) + DELIVERY (mailbox). Both required for `followup_task` to be
  // built AND to wake a child (not `no_waker`). Caller-override-precedence.
  return wantFollowup ? wireFollowupDeps(next) : next
}

/** Wire the `followup_task` trigger + delivery substrate, preserving any port
 *  the caller already supplied (ADR-0332). Extracted to keep
 *  {@link wireSubagentToolGates} under biome's cognitive-complexity cap. */
const wireFollowupDeps = <T extends OptionalPortBase>(base: T): T => {
  let next = base
  if (next.subagentTurnWake === undefined) {
    next = { ...next, subagentTurnWake: new TurnWakeRegistry() } as T
  }
  if (next.subagentMailbox === undefined) {
    next = { ...next, subagentMailbox: defaultSubagentMailbox() } as T
  }
  return next
}
