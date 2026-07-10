import type { CircumventionTracker, EffectSignature } from "./circumvention"
import {
  type AutoModeClassifier,
  CLASSIFIER_SYSTEM_PROMPT,
  withCircumventionContext,
} from "./classifier"
import { hostMutationVerdict } from "./per-host-mode"
import { threadAllowsMutation } from "./per-thread-store"
import type {
  ControlPolicy,
  NetworkPolicy,
  ApprovalPolicy as PermissionApprovalPolicy,
  PermissionProfile,
  SandboxPolicy as PermissionSandboxPolicy,
} from "./permission-profile"
import type { PermissionReader } from "./permission-store"
import {
  HARD_DENY,
  HARD_DENY_RULES,
  type HardDenyRule,
  normalizeShellForDeny,
} from "./policy-rules"
import {
  emitPermissionDecision,
  type PermissionOutcomeLabel,
  type PermissionRiskLevel,
  type PermissionStackSource,
} from "./recorder"
import type { HITLTierReason, ToolCapability } from "@/shared"
import type {
  HITLTier,
  PermissionContext,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionSoftDenySource,
  ToolAction,
} from "./types"

/** Exposed for the rule-level unit test (positive + negative case enforcement,
 *  unique-name check). NOT intended for production callers — use
 *  `hardDenyReason()` for the projected check. */
export { HARD_DENY_RULES, type HardDenyRule }

/** Last-resort extraction for actions whose dispatcher did NOT populate
 *  `shellCommand` (legacy callers / tests). Modern call sites populate the
 *  field via `ToolRegistry.extractShellCommand`. This back-compat probe ONLY
 *  triggers for `bash` so it cannot widen the gate; new shell tools must use
 *  the typed registry-populated path. */
const legacyBashCommand = (action: ToolAction): string | null => {
  if (action.tool !== "bash") return null
  const input = action.input
  if (input === null || typeof input !== "object" || !("command" in input)) return null
  const c = (input as { command: unknown }).command
  return typeof c === "string" ? c : null
}

/** Returns the HARD_DENY reason string for any shell-equivalent action, or
 *  null if no pattern matches. Path-independent dangerous patterns always win
 *  first, before mode. HARD_DENY hits ARE the `hand-off-required` tier —
 *  they cross a security boundary that no agent mode can authorize.
 *
 *  S16 — STRUCTURAL CHANGE: this previously gated on `action.tool === "bash"`,
 *  which meant any sibling shell tool (a future `shell`/`exec`/MCP `run`, a
 *  typo'd `Bash`) silently sidestepped the entire dangerous-command denylist.
 *  Now the gate fires on EVERY action whose `shellCommand` is set — populated
 *  by the dispatch seam from `ToolRegistry.extractShellCommand` which in turn
 *  reads each tool's own `extractShellCommand` method. Tools that don't
 *  represent shell commands leave `shellCommand` unset and skip the gate. */
export const hardDenyReason = (action: ToolAction): string | null => {
  const cmd =
    typeof action.shellCommand === "string" ? action.shellCommand : legacyBashCommand(action)
  if (cmd === null || cmd.length === 0) return null
  const cached = action.hardDenyProse
  const expected = `Blocked dangerous command: ${cmd}`
  if (typeof cached === "string" && cached === expected) return cached
  // R7 fix — match against the shell-normalized form so empty-quote
  // (`r""m`) / mid-token-backslash (`c\url`) command-name splitting cannot
  // slide a dangerous binary past the word-boundary anchors. See
  // `normalizeShellForDeny` for why this is deny-widening-only and safe.
  const probe = normalizeShellForDeny(cmd)
  for (const pat of HARD_DENY) {
    if (pat.test(probe)) return `Blocked dangerous command: ${cmd}`
  }
  return null
}

const hardDeny = (action: ToolAction): PermissionDenyDecision | null => {
  const reason = hardDenyReason(action)
  return reason ? { kind: "deny", reason, hardDeny: true, stackSource: "hard-deny" } : null
}

const softDeny = (
  reason: string,
  stackSource: PermissionSoftDenySource,
): PermissionDenyDecision => ({
  kind: "deny",
  reason,
  hardDeny: false,
  stackSource,
})

/* ------------------------------------------------------------------------- *
 * OTel emit (ADR-0032 vocabulary activation).
 *
 * Maps the {@link PermissionDecision.kind} discriminant to the closed
 * {@link PermissionOutcomeLabel} union exposed to dashboards. `"ask"`
 * surfaces as `"prompt"` (operator-visible event name); the `"trust"` bucket
 * is reserved for stack-axis override paths (`evaluateStack`'s post-denial
 * branch wires it explicitly).
 *
 * SECURITY INVARIANT: NEVER pass the matched HARD_DENY regex source through
 * any attribute. The only categorical fields emitted here are:
 *   - `outcome`         — the {@link PermissionOutcomeLabel} string.
 *   - `reviewerTier`    — coarse `"auto_review"` label (this is the synchronous
 *                         policy path, not a user/guardian review).
 *   - `riskLevel`       — coarse `"low" | "medium" | "high"` tier.
 *   - `decidedBy`       — `"stack" | "reviewer" | "hook" | "hitl"` layer.
 *   - `stackSource`     — pre-defined axis name (NEVER a regex source).
 *   - `stackVerdict`    — the verdict literal (allow/deny/ask).
 *
 * The action's `shellCommand`, the matched HARD_DENY rule name, and the
 * raw `action.input` are deliberately NOT plumbed through. A dashboard
 * sees "HARD_DENY hit on tool=bash" — never "rm -rf /".
 * ------------------------------------------------------------------------- */

const labelFor = (kind: PermissionDecision["kind"]): PermissionOutcomeLabel =>
  kind === "allow" ? "allow" : kind === "deny" ? "deny" : "prompt"

/** Risk-level heuristic for the synchronous policy path. HARD_DENY ⇒ "high"
 *  (security boundary); ask ⇒ "medium"; allow ⇒ "low". Coarse on purpose —
 *  the fine-grained tier comes from the reviewer port when the action escalates. */
const riskLevelFor = (kind: PermissionDecision["kind"]): PermissionRiskLevel =>
  kind === "deny" ? "high" : kind === "ask" ? "medium" : "low"

const verdictFor = (kind: PermissionDecision["kind"]): "allow" | "deny" | "ask" => kind

/** Internal helper: emit the decision through the recorder seam IF
 *  registered. Pass-through return so the caller can keep its terse
 *  `return emit(d, ...)` form. The `extra` overlay lets stack-axis callers
 *  supply `actionSignature` / `threadId` / `hostId` without re-typing
 *  the base fields. */
const emit = (
  decision: PermissionDecision,
  extra: {
    stackSource: PermissionStackSource
    actionSignature?: string
    threadId?: string
    hostId?: string
  },
): PermissionDecision => {
  const label = labelFor(decision.kind)
  emitPermissionDecision({
    outcome: label,
    reviewerTier: "auto_review",
    riskLevel: riskLevelFor(decision.kind),
    decidedBy: "stack",
    stackVerdict: verdictFor(decision.kind),
    stackSource: extra.stackSource,
    ...(extra.actionSignature !== undefined ? { actionSignature: extra.actionSignature } : {}),
    ...(extra.threadId !== undefined ? { threadId: extra.threadId } : {}),
    ...(extra.hostId !== undefined ? { hostId: extra.hostId } : {}),
  })
  return decision
}

/** Specialized emit for the post-denial-override allow path. Emits the
 *  `"trust"` counter label so dashboards distinguish operator-overridden
 *  allows from baseline allows. */
const emitTrust = (
  decision: PermissionDecision,
  extra: {
    actionSignature: string
    threadId: string
    hostId?: string
  },
): PermissionDecision => {
  emitPermissionDecision({
    outcome: "trust",
    reviewerTier: "auto_review",
    riskLevel: "high", // override implies an action that was previously denied
    decidedBy: "stack",
    stackVerdict: "allow",
    stackSource: "post-denial-override",
    actionSignature: extra.actionSignature,
    threadId: extra.threadId,
    ...(extra.hostId !== undefined ? { hostId: extra.hostId } : {}),
  })
  return decision
}

/* ------------------------------------------------------------------------- *
 * Codex HITL 4-tier (hitl-audit.md) — tier inference.
 *
 * Precedence: `tool.hitlTier(input)` explicit value wins (e.g. `bash`'s
 * network-egress + mutating-git classifier returning `always-confirm`).
 * Absent ⇒ FAIL-CLOSED fallback:
 *   - read-only tool                    ⇒ "none" (reversible, harmless)
 *   - mutating tool with NO hitlTier()  ⇒ "always-confirm" (NOT
 *     "pre-approval-ok")
 *
 * Rationale (security audit Round 3): a future high-blast-radius tool —
 * `email_send`, `payment_authorize`, `slack_dm` — that forgets to implement
 * `hitlTier()` would silently drop into a tier batch-approved by
 * `acceptEdits`/`bypass` mode. Secure-by-default reverses the burden: the
 * registry MUST explicitly opt a mutating tool into `pre-approval-ok`
 * before it can ride loose. Existing default tools (`write`/`edit`/
 * `test_runner`/`scripted_replace`) declare `hitlTier(): "pre-approval-ok"`
 * explicitly to preserve their current behavior; an audit catches a missing
 * declaration on a new tool as soon as a user invokes it under `bypass`.
 *
 * `@/permission` stays leaf: the helper duck-reads the `hitlTier` method off
 * a thin interface (no `@/tool` import).
 * ------------------------------------------------------------------------- */

interface HITLToolDuck {
  isReadOnly(): boolean
  hitlTier?(input: unknown): HITLTier
  capability?(input: unknown): ToolCapability | undefined
}

/** Infer the effective HITL tier for a call, WITH the reason it resolved that
 *  way (jul-10, D-1 follow-through — the PDP split's first-class output; see
 *  `pdp.ts`). The tool's own `hitlTier(input)` wins ("declared"); otherwise
 *  read-only ⇒ "none" ("inferred"), mutating ⇒ "always-confirm" (FAIL-CLOSED
 *  — see module comment) with reason "needs-sandbox": the unclassified-
 *  mutating catch-all (e.g. an MCP tool with no `hitlTier`) is gated because
 *  nothing vouches for it, NOT because it is inherently sensitive — so under
 *  an explicit `bypass` release the gate defers to mode policy (which still
 *  hard-denies the denylist). The dispatch seam composes this with the
 *  HARD_DENY check (which overrides to "hand-off-required") to obtain the
 *  final routing tier. */
export const inferToolTierDetailed = (
  tool: HITLToolDuck,
  input: unknown,
): { tier: HITLTier; reason: HITLTierReason } => {
  const explicit = tool.hitlTier?.(input)
  // The hardest tier is never downgraded by a capability.
  if (explicit === "hand-off-required") return { tier: explicit, reason: "declared" }
  // capability is the SSOT for the confirm axis (P2-T3): a declared confirm
  // reason (sensitive / needs-sandbox) implies the always-confirm tier, so a
  // tool declares ONE thing — not a redundant hitlTier — and a read-only-looking
  // tool that is actually sensitive can't silently infer "none" (no floor).
  const confirm = tool.capability?.(input)?.confirm
  if (confirm === "sensitive") return { tier: "always-confirm", reason: "sensitive" }
  if (confirm === "needs-sandbox") return { tier: "always-confirm", reason: "needs-sandbox" }
  // FAIL-CLOSED: an UNRECOGNIZED (untyped JS / MCP-bridge) truthy confirm value
  // keeps the legacy escalation to always-confirm — as reason "declared", so it
  // NEVER rides the needs-sandbox bypass fallthrough (parity with the previous
  // `if (confirm) return "always-confirm"` behavior under every mode).
  if (confirm) return { tier: "always-confirm", reason: "declared" }
  if (explicit) return { tier: explicit, reason: "declared" }
  return tool.isReadOnly()
    ? { tier: "none", reason: "inferred" }
    : { tier: "always-confirm", reason: "needs-sandbox" }
}

/** Tier-only view of {@link inferToolTierDetailed} (the legacy SSOT surface —
 *  every existing caller keeps its exact behavior). */
export const inferToolTier = (tool: HITLToolDuck, input: unknown): HITLTier =>
  inferToolTierDetailed(tool, input).tier

/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`.
 *
 *  "auto" mode is async (needs the injected classifier) — this synchronous
 *  entrypoint cannot await it, so it degrades "auto" safely to "ask" after
 *  applying the read-only allow and the HARD_DENY guard. The main thread
 *  should call `evaluateAuto()` instead when it can drive the classifier. */
export const evaluate = (action: ToolAction, ctx: PermissionContext): PermissionDecision => {
  // HARD_DENY ALWAYS wins — checked BEFORE the read-only fast-path so a tool
  // mislabeled `isReadOnly:true` that nonetheless carries a shell-equivalent
  // `shellCommand` (registry bug / spoofed action) can never sidestep the
  // denylist. `hardDeny` only fires when a shell command is present, so a
  // genuine read-only tool (no `shellCommand`) still falls straight through
  // to the allow below. This mirrors `evaluateStack`'s ordering (precedence
  // level 1) and the documented "HARD_DENY beats everything" invariant.
  const denied = hardDeny(action)
  if (denied) return emit(denied, { stackSource: "hard-deny" })

  if (action.isReadOnly) return emit({ kind: "allow" }, { stackSource: "read-only-bypass" })

  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") {
    return emit({ kind: "allow" }, { stackSource: "global-default" })
  }
  if (ctx.mode === "auto") {
    return emit(
      {
        kind: "ask",
        reason: "auto mode requires the async classifier (use evaluateAuto)",
      },
      { stackSource: "global-default" },
    )
  }
  return emit(
    { kind: "ask", reason: `${action.tool} modifies state` },
    { stackSource: "global-default" },
  )
}

/**
 * Async permission evaluation for "auto" mode. Ordering (permission-system.md
 * §3.5): read-only → allow; HARD_DENY still wins first; otherwise consult the
 * injected classifier via the stateful AutoModeClassifier. A `fallback`
 * verdict from the classifier (denial-limit exceeded, circuit-broken, or
 * classifier absent) surfaces as a hard "ask".
 *
 * Behavior-preserving for the 3 existing modes: anything that is not "auto"
 * delegates verbatim to the synchronous `evaluate()`.
 */
/**
 * jun-7-misc 04 — optional auto-mode overlay + circumvention wiring. ALL fields
 * optional; an OMITTED `opts` (the default, knobs OFF) ⇒ `evaluateAuto` runs the
 * exact legacy path BYTE-IDENTICALLY (the OFF ratchet). Every field is consumed
 * additively and only when present.
 */
export interface EvaluateAutoOptions {
  /** Pre-composed, overlay-extended system prompt (the gate builds it via
   *  `withUserRuleOverlay(withExfilScoutingTaxonomy(...), overlay)`). When
   *  absent, the canonical `CLASSIFIER_SYSTEM_PROMPT` flows through unchanged. */
  overlaidSystemPrompt?: string | undefined
  /** Session-scoped denied-effect tracker (constructed ONLY when the
   *  `QUANTA_CIRCUMVENT_DETECT` knob is ON). Absent ⇒ no effect memory. */
  tracker?: CircumventionTracker | undefined
  /** The current action's WRITE effect signature (gate-extracted via
   *  `extractWriteEffect`). Required for any tracker interaction. */
  effect?: EffectSignature | undefined
  /** ALL of the current action's WRITE effect signatures (gate-extracted via
   *  `extractWriteEffects`). A single shell command can write MORE THAN ONE path
   *  (`a > X; b > Y`); tracking only `effect` (the first) let a decoy-prefixed
   *  redirect route around a soft-deny silently (round-4 finding). When present
   *  this SUPERSEDES `effect` for match/note/clear so EVERY path is checked.
   *  Absent ⇒ fall back to the single `effect` (back-compat). */
  effects?: readonly EffectSignature[] | undefined
  /** Monotonic session turn number (the injected "clock"). */
  turn?: number | undefined
  /** Posture: `"escalate"` turns a circumvention match into a forced HITL
   *  `ask`; the default (advisory) threads a context line to the classifier and
   *  lets it decide. NEVER auto-allow / auto-hard-block on a signal. */
  posture?: "advisory" | "escalate" | undefined
}

/** The resolved write-effect set for this action: the plural `effects` when the
 *  gate supplies it (round-4 multi-path fix), else the single `effect` boxed
 *  into a 1-list (back-compat). Empty ⇒ no tracker interaction. */
const effectsOf = (opts: EvaluateAutoOptions | undefined): readonly EffectSignature[] => {
  if (opts?.effects !== undefined) return opts.effects
  return opts?.effect !== undefined ? [opts.effect] : []
}

/** True iff `opts` carries the full circumvention wiring (tracker + at least one
 *  effect + turn). All-or-nothing so a partially-wired opts never half-activates. */
const circumventionArmed = (
  opts: EvaluateAutoOptions | undefined,
): opts is EvaluateAutoOptions & {
  tracker: CircumventionTracker
  turn: number
} => opts?.tracker !== undefined && opts.turn !== undefined && effectsOf(opts).length > 0

/** Pre-classification circumvention check. Returns a forced-`ask` decision
 *  (stricter `escalate` posture) when a same-effect-different-tool match fires,
 *  an `{advisory}` note (default posture) to thread into the prompt, or
 *  `undefined` (no signal / detector inert). NEVER auto-allow / hard-block. */
const precheckCircumvention = (
  action: ToolAction,
  opts: EvaluateAutoOptions | undefined,
): { decision: PermissionDecision } | { advisory: string } | undefined => {
  if (!circumventionArmed(opts)) return undefined
  // Check EVERY write effect — a decoy-prefixed redirect (`a > DECOY; b > X`)
  // must not hide the soft-denied path. First match wins (advisory/escalate).
  let signal: ReturnType<CircumventionTracker["matchCircumvention"]>
  for (const eff of effectsOf(opts)) {
    signal = opts.tracker.matchCircumvention(eff, action.tool, opts.turn)
    if (signal !== undefined) break
  }
  if (signal === undefined) return undefined
  if (opts.posture === "escalate") {
    return {
      decision: emit(
        {
          kind: "ask",
          reason: "tool-switch circumvention of a prior soft-deny — escalating to review",
        },
        { stackSource: "global-default" },
      ),
    }
  }
  return { advisory: signal.advisory }
}

export const evaluateAuto = async (
  action: ToolAction,
  ctx: PermissionContext,
  classifier: AutoModeClassifier,
  opts?: EvaluateAutoOptions,
): Promise<PermissionDecision> => {
  if (ctx.mode !== "auto") return evaluate(action, ctx)

  // HARD_DENY beats the classifier AND the read-only fast-path — it crosses a
  // security boundary and no user/model context (nor a possibly-spoofed
  // `isReadOnly:true` on a shell-bearing action) authorizes it. Checked first
  // so it matches `evaluate`/`evaluateStack` precedence level 1. `hardDeny`
  // is a no-op when no `shellCommand` is present, so genuine read-only tools
  // still allow below. NOTE: a HARD_DENY hit is terminal and is NEVER routed
  // through the circumvention tracker — it needs no soft-deny memory.
  const denied = hardDeny(action)
  if (denied) return emit(denied, { stackSource: "hard-deny" })

  if (action.isReadOnly) return emit({ kind: "allow" }, { stackSource: "read-only-bypass" })

  // jun-7-misc 04 (b) — circumvention detection (advisory-first). A match under
  // the `escalate` posture short-circuits to a forced HITL `ask`; otherwise it
  // yields an advisory context line threaded into the classifier prompt.
  const circ = precheckCircumvention(action, opts)
  if (circ !== undefined && "decision" in circ) return circ.decision
  const circumventionNote = circ?.advisory

  // Compose the model-facing system prompt: the gate-supplied overlaid prompt
  // (or the canonical taxonomy) plus the advisory circumvention context line for
  // this one evaluation. Both seams are byte-identical when their input is
  // absent (`withCircumventionContext(base, undefined) === base`).
  const basePrompt = opts?.overlaidSystemPrompt ?? CLASSIFIER_SYSTEM_PROMPT
  const composedPrompt = withCircumventionContext(basePrompt, circumventionNote)

  const decision = await classifier.evaluate({
    tool: action.tool,
    input: action.input,
    systemPrompt: ctx.classify
      ? // The injected port owns the real system prompt; pass the canonical
        // taxonomy so a mock/echo port still sees the canonical wording.
        composedPrompt
      : "",
  })

  if (decision.fallback) {
    return emit({ kind: "ask", reason: decision.reason }, { stackSource: "global-default" })
  }
  if (decision.verdict === "allow") {
    // A genuine allow of these effects clears any prior denied-effect signature
    // so the detector cannot poison the rest of the session (§4.b clear-on-allow).
    // Clear EVERY effect (the multi-path action allowed all of them).
    if (opts?.tracker !== undefined) {
      for (const eff of effectsOf(opts)) opts.tracker.clearOnAllow(eff)
    }
    return emit({ kind: "allow" }, { stackSource: "global-default" })
  }
  if (decision.verdict === "deny") {
    // SOFT deny — record the denied WRITE effect so a same-effect-different-tool
    // follow-up is caught. HARD_DENY already returned above (terminal), so this
    // is unambiguously a soft policy deny.
    // Record EVERY denied write effect so a later tool-switch to ANY of them is
    // caught (a multi-path soft-deny remembers all its targets).
    if (circumventionArmed(opts)) {
      for (const eff of effectsOf(opts)) opts.tracker.noteDenied(eff, action.tool, opts.turn)
    }
    return emit(softDeny(decision.reason, "global-default"), { stackSource: "global-default" })
  }
  return emit({ kind: "ask", reason: decision.reason }, { stackSource: "global-default" })
}

/* ------------------------------------------------------------------------- *
 * ADR-0046 — Permission stack (per-thread + per-host + post-denial).
 *
 * `evaluateStack` extends the base policy with three Codex-inspired axes
 * stacked on top of HARD_DENY:
 *
 *  precedence (highest to lowest):
 *    1. HARD_DENY                  — security boundary; nothing overrides.
 *    2. post-denial user override  — `(threadId, actionSignature)` has a
 *                                    complete `denied → seenRisk → override`
 *                                    sequence ⇒ allow.
 *    3. per-thread permission      — `threadId` has an explicit record ⇒
 *                                    use its sandboxPolicy to allow/deny.
 *    4. per-host agent mode        — `hostId` has an explicit record ⇒
 *                                    `read-only`/`full-access` decides.
 *    5. global default             — fall through to `evaluate(action, ctx)`.
 *
 * read-only actions still bypass everything except HARD_DENY (consistent
 * with the base `evaluate`). The function is SYNCHRONOUS — the same
 * "auto mode degrades to ask" contract as `evaluate`. Callers needing the
 * classifier path should compose `evaluateAuto` themselves.
 *
 * Pure with respect to global state: the store is the singleton by default,
 * but tests can inject a per-test instance via `opts.store`.
 * ------------------------------------------------------------------------- */

export interface PermissionStackContext {
  /** Thread id — anchors per-thread + post-denial precedence. */
  threadId: string
  /** Host id — anchors per-host mode. Use `resolveHostId()` from
   *  `per-host-mode.ts` when uncertain. */
  hostId: string
  /** Canonical action signature for the post-denial axis. Caller computes
   *  via `computeActionSignature({tool, workdir, args})`. */
  actionSignature: string
  /** Workdir — feeds `threadAllowsMutation`'s writable-root check. */
  workdir: string
}

export interface EvaluateStackOptions {
  /** Caller-injected store (composition-root supplies). Narrowed to
   *  {@link PermissionReader} — `evaluateStack` only reads (ISP, refactor #3);
   *  the concrete `PermissionStore` still satisfies it.
   *
   *  REQUIRED: removed the service-locator fallback. The composition root
   *  (apps/*) MUST pass an explicit store; tests already inject via
   *  `createPermissionStore({filePath})`. The singleton stays available via
   *  `getDefaultPermissionStore()` for the composition path only. */
  store: PermissionReader
}

/** Synchronous precedence-aware permission resolver. Returns the same
 *  `PermissionDecision` shape as `evaluate()` so call sites that wrap it
 *  remain interchangeable.
 *
 *  See module comment for the precedence table. */
export const evaluateStack = (
  action: ToolAction,
  ctx: PermissionContext,
  stack: PermissionStackContext,
  opts: EvaluateStackOptions,
): PermissionDecision => {
  // Common axis overlay for every emit below — anchors threadId/hostId/
  // actionSignature so a dashboard can pivot across all 5 precedence levels
  // for the same `(threadId, action)`. SECURITY: actionSignature is the
  // 32-hex hash from `computeActionSignature`; raw args never leave the
  // caller.
  const axes = {
    threadId: stack.threadId,
    hostId: stack.hostId,
    actionSignature: stack.actionSignature,
  }

  // HARD_DENY ALWAYS wins — even read-only actions can't reach a shell-
  // equivalent path that hits the denylist (defensive: `isReadOnly=true`
  // for a shell tool would be a registry bug, but the gate fires anyway).
  const denied = hardDeny(action)
  if (denied) return emit(denied, { stackSource: "hard-deny", ...axes })

  if (action.isReadOnly) {
    return emit({ kind: "allow" }, { stackSource: "read-only-bypass", ...axes })
  }

  const store = opts.store

  // 2. Post-denial user override — explicit re-approval after seeing risk
  //    overrides any rule below. The store enforces the timestamp ordering
  //    invariant (deniedAt ≤ seenRiskAt ≤ userOverrideAt). Emit the "trust"
  //    counter label so dashboards distinguish operator-overridden allows
  //    from baseline allows.
  if (store.hasPostDenialOverride(stack.threadId, stack.actionSignature)) {
    return emitTrust(
      { kind: "allow" },
      { actionSignature: stack.actionSignature, threadId: stack.threadId, hostId: stack.hostId },
    )
  }

  // 3. Per-thread permission record (highest among rule-based axes).
  const threadPerm = store.getThread(stack.threadId)
  if (threadPerm !== undefined) {
    const writable = threadAllowsMutation(threadPerm, stack.workdir)
    if (writable) return emit({ kind: "allow" }, { stackSource: "per-thread", ...axes })
    return emit(
      softDeny(
        `Per-thread policy (${threadPerm.sandboxPolicy.type}) refuses ${action.tool} on ${stack.workdir}`,
        "per-thread",
      ),
      { stackSource: "per-thread", ...axes },
    )
  }

  // 4. Per-host agent-mode default. Branch on the TYPED verdict — the legacy
  //    boolean adapter collapses `defer` (custom) into the same `undefined`
  //    as `unpinned`, which would let a custom-pinned host fall through to
  //    the global default and be IMPLICITLY ALLOWED under bypass/acceptEdits.
  //    A `custom`-pinned host is a deliberate "restrict me with a bespoke
  //    policy" marker: until that bespoke policy is resolved it MUST fail
  //    CLOSED, never ride the global default's mode-based allow.
  const hostMode = store.getHost(stack.hostId)
  const hostVerdict = hostMutationVerdict(hostMode)
  if (hostVerdict === "deny") {
    return emit(
      softDeny(
        `Per-host mode (${hostMode}) refuses ${action.tool} on host ${stack.hostId}`,
        "per-host",
      ),
      { stackSource: "per-host", ...axes },
    )
  }
  if (hostVerdict === "defer") {
    // `custom` — bespoke per-host policy not yet wired into this gate. Fail
    // CLOSED: deny outright rather than let bypass/acceptEdits implicitly
    // allow it. When the bespoke-policy resolver lands it replaces THIS
    // branch (resolve → allow/deny), never the fall-through below.
    return emit(
      softDeny(
        `Per-host mode (custom) on host ${stack.hostId} requires a bespoke policy that has not been resolved — refusing ${action.tool} (fail-closed)`,
        "per-host",
      ),
      { stackSource: "per-host", ...axes },
    )
  }
  if (hostVerdict === "allow") {
    return emit({ kind: "allow" }, { stackSource: "per-host", ...axes })
  }

  // 5. `unpinned` — fall through to the global default (mode-based evaluate).
  //
  //    EMIT-ONCE INVARIANT (P3 OTel double-count guard): `evaluate` already
  //    emits the decision through the same recorder seam with
  //    `stackSource: "global-default"`. The fall-through therefore returns its
  //    verdict VERBATIM — it MUST NOT wrap the call in another `emit(...)` /
  //    `emitTrust(...)`, nor add a second `emitPermissionDecision` afterward,
  //    or a dashboard over `quanta.permission.decision` would over-count every
  //    global-default allow/ask/deny by 2x whenever the stack feature is
  //    enabled. The bare `return evaluate(...)` is load-bearing; see
  //    permission-otel-global-default-emit-once-hellgate.test.ts.
  return evaluate(action, ctx)
}

/* ------------------------------------------------------------------------- *
 * ADR-0135 — 4-pillar inference helpers (additive, backward-compat).
 *
 * These helpers project a (possibly absent) {@link PermissionProfile} onto
 * each of the four pillars (approval / network / sandbox / control). When no
 * profile is supplied, each helper returns the strictest sensible default,
 * matching {@link DEFAULT_PERMISSION_PROFILE} — so a legacy caller migrating
 * one helper at a time always lands in a closed-by-default state.
 *
 * Wired by the composition root; library slices use the pure helpers and
 * never reach for IO.
 * ------------------------------------------------------------------------- */

/** Strictest defaults — match {@link DEFAULT_PERMISSION_PROFILE} field-for-
 *  field so behavior is uniform whether the caller passes a profile or not. */
const DEFAULT_APPROVAL: PermissionApprovalPolicy = Object.freeze({
  mode: "once" as const,
  promptUser: true,
})

const DEFAULT_NETWORK: NetworkPolicy = Object.freeze({ mode: "deny-all" as const })

const DEFAULT_SANDBOX: PermissionSandboxPolicy = Object.freeze({
  osSandbox: "none" as const,
  readOnly: true,
  workspaceWrite: false,
  networkIsolated: true,
})

const DEFAULT_CONTROL: ControlPolicy = Object.freeze({ auditRequired: false })

/** Read a pillar ONLY as an own enumerable/data property — NEVER through the
 *  prototype chain.
 *
 *  SECURITY (prototype-pollution defense, mirrors `pricing-null-proto-guard`):
 *  `profile?.approval` resolves via the prototype chain, so a poisoned
 *  `Object.prototype.approval = {mode:"always", promptUser:false}` upstream
 *  would make an absent-pillar profile (`{}`) read a PERMISSIVE value instead
 *  of falling through `?? DEFAULT_*` to the strict frozen default — silently
 *  defeating the security floor (no prompt / deny-all → allow-all /
 *  readOnly → workspaceWrite). `Object.hasOwn` reads only own properties, so a
 *  polluted prototype can never leak a pillar in. An own pillar that is
 *  explicitly `undefined` still falls through to the strict default via `??`.
 *  Profiles parsed from untrusted config thus cannot be silently widened by a
 *  pollution sink elsewhere in the process. */
const ownPillar = <K extends keyof PermissionProfile>(
  profile: PermissionProfile | undefined,
  key: K,
): PermissionProfile[K] | undefined =>
  profile !== undefined && Object.hasOwn(profile, key) ? profile[key] : undefined

/** Project the approval pillar. Absent profile ⇒ strictest defaults. */
export const inferApprovalPolicy = (profile?: PermissionProfile): PermissionApprovalPolicy =>
  ownPillar(profile, "approval") ?? DEFAULT_APPROVAL

/** Project the network pillar. Absent profile ⇒ `deny-all` (no egress). */
export const inferNetworkPolicy = (profile?: PermissionProfile): NetworkPolicy =>
  ownPillar(profile, "network") ?? DEFAULT_NETWORK

/** Project the sandbox pillar. The `fallback` argument lets callers seed
 *  from a legacy single-enum policy when migrating — when the profile lacks
 *  a sandbox member, the fallback wins over {@link DEFAULT_SANDBOX}. */
export const inferSandboxPolicy = (
  profile?: PermissionProfile,
  fallback?: PermissionSandboxPolicy,
): PermissionSandboxPolicy => ownPillar(profile, "sandbox") ?? fallback ?? DEFAULT_SANDBOX

/** Project the control pillar. Absent profile ⇒ user-managed, audit OFF. */
export const inferControlPolicy = (profile?: PermissionProfile): ControlPolicy =>
  ownPillar(profile, "control") ?? DEFAULT_CONTROL
