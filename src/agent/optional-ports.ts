import { createEffortClassifier } from "@/agent/effort-classifier"
import { createFastApplyFallback } from "@/agent/fast-apply-fallback"
import { dispatchSideConversation } from "@/agent/side-conversation"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import type { LLMPort } from "@/llm"
import { defaultRoleModelResolver, type RoleModelResolver } from "@/llm/role-model-override"
import { gateOn, logger } from "@/shared"
import { AgentMetaRegistry, TurnWakeRegistry } from "@/subagent"
import type { CloseoutCritic, CloseoutCriticVerdict } from "./closeout-critic"
import { buildCodeCellDispatchPort } from "./codemode-wire"
import { materializeReviewerAgent } from "./tier1/reviewer-subagent"
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
/** RFC jun-6-code-mode (Phase 1) — `code_cell` dispatch-port wire gate. Strict
 *  `"1"` (mirrors `runtimeConfig().codeMode` — NOT the `=on` convention the
 *  subagent gates use) so the composition root flips the SAME knob the tool
 *  registration (`DefaultToolPorts.codeMode`) reads. */
const QUANTA_CODE_MODE_ENV = "QUANTA_CODE_MODE"
/** P12 — `closeout-critic` port wire gate. Same `QUANTA_CLOSEOUT_CRITIC` env the
 *  knob's `enabled` fold reads; the truthy set mirrors the knob's
 *  (`["1","on","true"]`) so the port is constructed on EXACTLY the runs the knob
 *  turns the feature on. */
const QUANTA_CLOSEOUT_CRITIC_ENV = "QUANTA_CLOSEOUT_CRITIC"
const CLOSEOUT_CRITIC_TRUTHY = new Set(["1", "on", "true"])

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

// Delegate to the canonical SSOT gate reader (`@/shared#gateOn`) so the whole
// optional-ports family (fast-apply / effort-auto / mailbox / batch / introspect
// / followup / code-mode) accepts the SAME vocabulary as every other gate —
// `=1` AND `=on` (and `true`/`yes`) all activate. Previously this was a strict
// `=== "on"`, which silently ignored `=1` (the followup-task footgun). Superset:
// the value `"on"` still activates, unset is still OFF.
const envGateOn = (env: OptionalPortEnv, key: string): boolean => gateOn(env, key)

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

  // RFC jun-6-code-mode (Phase 1) — wire the `code_cell` per-cell dispatch-port
  // FACTORY behind `QUANTA_CODE_MODE=1`. Default-OFF byte-identical when unset.
  next = wireCodeCellDispatch(next, env)

  // P12 — wire the REAL `closeout-critic` port behind `QUANTA_CLOSEOUT_CRITIC`.
  // Default-OFF byte-identical when unset; gate ON but no reviewer subagent
  // available ⇒ no port ⇒ the loop fails open (byte-identical completion).
  next = wireCloseoutCritic(next, env)

  // RFC-02/04 — subagent batch + introspect + followup tool gates. Extracted
  // so this function stays under biome's cognitive-complexity cap. Each gate is
  // default-OFF (`=on` only); unset ⇒ `next` returned verbatim (byte-identical).
  return wireSubagentToolGates(next, env)
}

/**
 * RFC jun-6-code-mode (Phase 1) — composition-root wire for the `code_cell`
 * tool's dispatch-port FACTORY. When `QUANTA_CODE_MODE=1` (the SAME knob that
 * registers the tool via `DefaultToolPorts.codeMode`), set
 * `AgentConfig.codeCellDispatchFactory` to a factory that, per cell-call-id,
 * builds the security-critical {@link buildCodeCellDispatchPort} closing over the
 * LIVE assembled `config` (`base`) + its `permission`. The dispatch seam
 * (`dispatch.ts`) then calls `codeCellDispatchFactory(toolCallId)` for each
 * `code_cell` dispatch and surfaces the port on `ctx.codeCellDispatch`.
 *
 * SECURITY (RFC §6.1 — structural no-bypass): the port routes EVERY in-cell
 * `tools.X(args)` through the REAL `dispatchTool` with the SAME `config`/
 * `permission` the loop holds — a cell is N ordinary gated tool calls. The
 * factory closes over `base` BY REFERENCE so the gating reflects the exact posture
 * the turn runs under (no snapshot, no widening). `autoClassifier` is left absent
 * here (the loop's auto-mode classifier is a per-session object not present on
 * `AgentConfig`); absent ⇒ in-cell read-only ops do NOT auto-pass, which is
 * STRICTLY MORE RESTRICTIVE than the direct path — never a bypass.
 *
 * Default-OFF byte-identical (RFC §1.2): with `QUANTA_CODE_MODE` unset, `base` is
 * returned UNCHANGED — no factory slot, and the tool is not registered, so the
 * QuickJS-WASM module is never instantiated. Caller-override-precedence: a
 * pre-set `codeCellDispatchFactory` is preserved verbatim.
 */
const wireCodeCellDispatch = <T extends OptionalPortBase>(base: T, env: OptionalPortEnv): T => {
  if (env[QUANTA_CODE_MODE_ENV] !== "1") return base
  if (base.codeCellDispatchFactory !== undefined) return base
  const config = base as unknown as AgentConfig
  // `permission` is REQUIRED on the assembled AgentConfig (the loop's live
  // posture); read it off the config so the in-cell gate matches the turn exactly.
  const permission = config.permission
  if (permission === undefined) return base
  return {
    ...base,
    codeCellDispatchFactory: (callId: string) =>
      buildCodeCellDispatchPort({ config, permission, cellId: callId }),
    // Phase 2 (FULL tool surface) — a thunk reading the LIVE registry so the
    // cell binds `tools.<name>` for the agent's ACTUAL registered set (each STILL
    // re-gated through the dispatch port above). Read lazily at cell-dispatch time
    // so a tool registered after assembly appears automatically. Caller-override-
    // precedence: a pre-set thunk is preserved (the spread keeps it below `...base`
    // only if it was unset — we guard explicitly to mirror the factory above).
    ...(base.codeCellSurfaceTools === undefined
      ? { codeCellSurfaceTools: () => config.registry.toolNames() }
      : {}),
  } as T
}

/**
 * P12 — composition-root wire for the `closeout-critic` PORT (FINDING C). When
 * `QUANTA_CLOSEOUT_CRITIC` is truthy (the SAME knob that flips
 * `cfg.closeoutCritic.enabled` via `wireInteractiveKnobs`), inject a REAL
 * `CloseoutCritic` adapter backed by the EXISTING reviewer subagent
 * infrastructure (`materializeReviewerAgent`), so the feature is FUNCTIONAL
 * rather than inert (an enabled-but-portless config always fails open to a
 * no-op).
 *
 * The adapter is DI: the loop never hardcodes a reviewer — it only ever calls
 * `cfg.closeoutCritic.critic`. Here we ADAPT the reviewer runner into the critic
 * port shape (request → verdict) by running a read-only review subagent over the
 * draft final answer + tool history and decoding its JSON reply into an
 * ADVISORY `CloseoutCriticVerdict` (never blocks completion — see
 * `closeout-critic.ts`).
 *
 * Default-OFF byte-identical (RFC §1.2):
 *   - env unset / not truthy ⇒ `base` returned UNCHANGED (no port, no slot).
 *   - knob ON but `config.subagent` absent ⇒ `materializeReviewerAgent` returns
 *     `undefined` ⇒ NO port wired ⇒ the loop fails open (byte-identical
 *     completion). Reviewer port CONSTRUCTION failing therefore degrades to the
 *     existing fail-open path, never a crash.
 *   - caller-override-precedence (ADR-0332): a pre-set `closeoutCritic.critic`
 *     is preserved verbatim; we only fill an ABSENT port.
 *
 * The knob's `apply` MERGES `{ ...cfg.closeoutCritic, enabled: true }`, so the
 * port we set here survives the subsequent `enabled` fold (and vice-versa: the
 * order of the two wires does not matter — each only fills its own slot).
 */
const wireCloseoutCritic = <T extends OptionalPortBase>(base: T, env: OptionalPortEnv): T => {
  const raw = env[QUANTA_CLOSEOUT_CRITIC_ENV]
  if (raw === undefined || !CLOSEOUT_CRITIC_TRUTHY.has(raw)) return base
  // Caller-override-precedence — never overwrite a host-supplied critic.
  if (base.closeoutCritic?.critic !== undefined) return base
  const critic = buildReviewerBackedCloseoutCritic(base as unknown as AgentConfig)
  // No reviewer subagent available ⇒ NO port ⇒ fail-open (byte-identical).
  // Surface this once at wire time: the operator turned the knob ON but the
  // critic will silently never fire because no subagent runner is configured —
  // a stderr warning makes the inert state visible instead of a silent no-op.
  if (critic === undefined) {
    logger.warn(
      `QUANTA_CLOSEOUT_CRITIC is on but no reviewer subagent is configured (config.subagent absent) — the closeout critic will not run. Configure a subagent runner to enable it.`,
    )
    return base
  }
  return {
    ...base,
    closeoutCritic: { ...base.closeoutCritic, critic },
  } as T
}

/** P12 — adapt the EXISTING reviewer subagent (`materializeReviewerAgent`) into
 *  the {@link CloseoutCritic} port shape. Returns `undefined` when no reviewer
 *  can be materialized (no `config.subagent`) ⇒ the wire fails open. The adapter
 *  runs a READ-ONLY review child (`toolFilter` read/grep/glob, `taskKind:
 *  "review"`) over the draft answer + name-only tool history and decodes its
 *  reply into an advisory verdict. A failed/garbage child ⇒ a `denied`
 *  ADVISORY verdict (the host/UI sees the second opinion); it NEVER throws and
 *  NEVER blocks (the loop ignores the verdict for control flow). */
const buildReviewerBackedCloseoutCritic = (config: AgentConfig): CloseoutCritic | undefined => {
  const reviewer = materializeReviewerAgent(config)
  if (reviewer === undefined) return undefined
  return async (req): Promise<CloseoutCriticVerdict> => {
    const result = await reviewer({
      prompt: closeoutCriticPrompt(req.finalText, req.history),
      depth: 1,
      taskKind: "review",
      toolFilter: ["read", "grep", "glob"],
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
    if (!result.ok) {
      return {
        outcome: "denied",
        rationale: `critic reviewer unavailable: ${result.finalText || "no result"}`,
        riskLevel: "medium",
      }
    }
    return decodeCloseoutVerdict(result.finalText)
  }
}

/** Render the closeout-critic review prompt. Mirrors the guardian-reviewer
 *  prompt posture but framed for a turn-closeout second opinion: the child
 *  decides whether the agent's DRAFT final answer is acceptable as the turn's
 *  conclusion, replying with the same JSON envelope the guardian uses. */
const closeoutCriticPrompt = (
  finalText: string,
  history: ReadonlyArray<{ name: string }> | undefined,
): string => {
  const tools =
    history !== undefined && history.length > 0 ? history.map((h) => h.name).join(", ") : "(none)"
  return [
    "You are a second-opinion critic at an agent turn's CLOSEOUT.",
    "The agent is about to declare the turn complete. Decide whether the draft",
    "final answer is acceptable as the conclusion, given the tools it ran.",
    "Respond with JSON only.",
    "",
    "Decision rules:",
    '- return {"outcome":"approved",...} when the draft answer is acceptable to ship.',
    '- return {"outcome":"denied",...} when the agent should keep working',
    "  (claims unverified, task incomplete, obvious gap).",
    "",
    `Tools invoked this turn: ${tools}`,
    "Draft final answer:",
    "```",
    finalText,
    "```",
    "",
    'Output shape: JSON only: {"outcome":"approved"|"denied","rationale":"string","riskLevel?":"low"|"medium"|"high"}',
  ].join("\n")
}

/** Decode the reviewer child's reply into an advisory {@link
 *  CloseoutCriticVerdict}. Malformed / non-JSON output ⇒ a `denied` advisory
 *  (surfaced as the second opinion, never a throw — the loop survives any
 *  reviewer output). NO Zod here (the verdict is advisory-only; a missing field
 *  degrades to a safe default rather than a hard parse failure). */
const decodeCloseoutVerdict = (finalText: string): CloseoutCriticVerdict => {
  let decoded: unknown
  try {
    decoded = JSON.parse(finalText)
  } catch {
    return { outcome: "denied", rationale: "critic returned non-JSON output", riskLevel: "medium" }
  }
  if (typeof decoded !== "object" || decoded === null) {
    return {
      outcome: "denied",
      rationale: "critic returned a non-object reply",
      riskLevel: "medium",
    }
  }
  const rec = decoded as Record<string, unknown>
  const outcome = rec.outcome === "approved" ? "approved" : "denied"
  const rationale =
    typeof rec.rationale === "string" && rec.rationale.length > 0 ? rec.rationale : "(no rationale)"
  const riskLevel =
    rec.riskLevel === "low" || rec.riskLevel === "medium" || rec.riskLevel === "high"
      ? rec.riskLevel
      : undefined
  return {
    outcome,
    rationale,
    ...(riskLevel !== undefined ? { riskLevel } : {}),
  }
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
