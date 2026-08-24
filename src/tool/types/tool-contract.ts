/**
 * Tool CONTRACT declarations for the `@/tool` slice (extracted from
 * `../types.ts` to keep that module under the god-module line threshold).
 *
 * RESPONSIBILITY — what a tool IS (as opposed to what it RECEIVES, which is
 * `./tool-context`, or what it YIELDS, which is `./tool-result`). Namely the
 * `Tool<I, O>` intersection and the five Interface-Segregation groups it is
 * assembled from — {@link ToolCore} (the required surface), plus the optional
 * {@link ToolSecurityHooks} / {@link ToolInterruptPolicy} /
 * {@link ToolResultShape} / {@link ToolStreamingInput} arms — together with
 * the provider-agnostic {@link ToolSpec} the agent forwards to the LLM.
 *
 * This module is the only one of the three that depends on the other two
 * (`ToolContext` for `execute`'s 2nd arg, `ToolEvent`/`ToolResult` for what it
 * yields). It never imports `../types`, so the dependency edge stays one-way:
 * `../types` → here → `./tool-context` + `./tool-result`.
 *
 * The complete original public surface is RE-EXPORTED verbatim from `../types`
 * so every external importer of `@/tool/types` stays byte-compatible.
 */
import type { z } from "zod"
import type { SensitivityClass } from "@/security"
import type { HITLTier, ToolCapability } from "@/shared"
import type { ToolContext } from "./tool-context"
import type { ToolEvent, ToolResult } from "./tool-result"

/**
 * Phase 2 tool contract (RFC §6.2). `execute` is an async generator yielding
 * `ToolEvent`s; `isConcurrencySafe(input)` lets the dispatcher batch pure
 * reads to run in parallel while keeping side-effecting calls serialized.
 *
 * `Tool<I, O>` is the intersection of FOUR concerns (Interface-Segregation
 * grouping — structural guardrail for ISP):
 *
 *   1. {@link ToolCore}            — required surface, always set.
 *   2. {@link ToolSecurityHooks}   — optional permission / sensitivity hooks
 *                                    populated by built-in tools today.
 *   3. {@link ToolResultShape}     — optional result-shape contract
 *                                    (structured payload + model rendering +
 *                                    deferred-results opt-in).
 *   4. {@link ToolStreamingInput}  — optional streaming-input callbacks
 *                                    mirroring LLM `tool_use_*` events.
 *   5. {@link ToolInterruptPolicy} — optional per-tool interrupt policy
 *                                    (jun-6) read by the dispatch abort-router.
 *
 * Every member of groups 2–5 is OPTIONAL on `Tool` (the `Partial<…>`s below
 * preserve the previous flat shape), so all existing readers — `registry.run`,
 * `registry.extractShellCommand`, `factory.enforceOutputSchema` /
 * `renderToolOutput` / `driveStreamingInput`, the permission gate's
 * `inferToolTier`, and the dispatch redaction layer — keep working unchanged.
 *
 * Grouping is the structural guardrail: a future "dead optional" sticks out
 * because it has no consumer in its group. Do NOT add a scanner rule.
 */
export type Tool<I = unknown, O = unknown> = ToolCore<I> &
  Partial<ToolSecurityHooks<I>> &
  Partial<ToolResultShape<O>> &
  Partial<ToolStreamingInput<I>> &
  Partial<ToolInterruptPolicy> &
  Partial<ToolDynamicSpec>

/**
 * Required surface every tool implements. The dispatch/registry seams call
 * `execute`, `isReadOnly`, and `isConcurrencySafe` on EVERY tool — no
 * `?.` access, no `!== undefined` guards. New tools start here.
 */
export interface ToolCore<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  /** True ⇒ this call has no observable interaction with any other call and
   *  may run concurrently with other concurrency-safe calls. */
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
}

/**
 * Optional security / sensitivity hooks. Built-in tools populate these today
 * (`hitlTier` — 10 tools; `extractShellCommand` — `bash`; `classifySource` —
 * `bash`, `read`). Each is consumed by a real seam in `@/permission` (`policy`
 * — `inferToolTier`), `@/tool/registry` (`extractShellCommand`), or the
 * dispatch redaction layer (`classifySource`).
 */
export interface ToolSecurityHooks<I = unknown> {
  /** Input-dependent HITL tier (Codex hitl-audit.md absorption).
   *  When omitted, the dispatch gate infers tier from `isReadOnly()`:
   *  `true ⇒ "none"` (reversible, harmless), `false ⇒ "always-confirm"`
   *  (fail-closed secure-by-default, see `inferToolTier` in
   *  `@/permission/policy`). Tools that DO mutate but want pre-approval
   *  semantics (e.g. `write`/`edit`/`test_runner`/`scripted_replace`)
   *  explicitly opt in via `hitlTier: () => "pre-approval-ok"`. Tools whose
   *  tier varies per-input (`bash` — `git push` is always-confirm, `ls` is
   *  pre-approval-ok) provide their own classifier here. Only consulted
   *  when the HITL gate is explicitly enabled in `AgentConfig.hitl`. */
  hitlTier(input: I): HITLTier
  /** PDP capability declaration (jun-10, P2-T3). Optional, additive: the SSOT for
   *  WHY a tool needs a confirm, read by the security-floor decider
   *  (`@/permission` `decideFloor`). A tool that declares `confirm: "sensitive"`
   *  joins the UNIVERSAL always-confirm floor — confirmed on every surface,
   *  even under bypass, even without the HITL opt-in. `needs-sandbox` (e.g. bash
   *  without a profile) DEFERS to the sandbox / mode layer. Absent ⇒ defer
   *  (byte-identical legacy). Per-input so a tool can vary it. */
  capability?(input: I): ToolCapability
  /** S16: when a tool accepts a raw shell command string, it implements this
   *  to expose the command for HARD_DENY evaluation. The permission policy
   *  gates ANY tool whose `extractShellCommand` returns a non-null value
   *  through the same dangerous-pattern denylist as `bash` — so a sibling
   *  shell tool (a future `shell`/`exec`/MCP `run` tool, a typo'd `Bash`,
   *  etc.) cannot silently slip past the gate that previously only matched
   *  `action.tool === "bash"`. Tools whose input is not a shell string omit
   *  the method entirely. */
  extractShellCommand(input: I): string | null
  /** PR-2 self-audit fix (ADR-0078): structural declaration of the tool
   *  result's source sensitivity class for the secret-redaction gate.
   *  Mirrors the `extractShellCommand` pattern — tools that touch a
   *  filesystem path or run a shell command DECLARE their classifier here,
   *  rather than the dispatch seam guessing from `tool.name` / argument-field
   *  names. Returning `"secret"` causes the dispatch redaction layer to
   *  replace the entire tool result with `[REDACTED:source_class_secret]`
   *  before the model sees it; returning `"public"`/`"internal"` falls
   *  through to the Layer-2 deterministic-regex pattern matcher; returning
   *  `null` (or omitting the method) is identical to today's behavior
   *  (Layer-2 only, no source-class short-circuit). Pre-fix this lived in a
   *  hard-coded `PATH_TOOL_NAMES` / `COMMAND_TOOL_NAMES` set in dispatch.ts
   *  — a name-and-field-string heuristic that silently skipped any tool
   *  whose name wasn't `"Read"/"read"/"view_file"/"open_file"/"Bash"/...`.
   *  Declaration-based posture: a custom tool that adds a new file/command
   *  surface explicitly opts in by implementing this method. */
  classifySource(input: I): SensitivityClass | null
  /** ADR-0298 / T02 reconciliation — opt a NON-read-only tool into
   *  streaming-dispatch EARLY-START (Phase 1 in-flight overlap).
   *
   *  T02 (`streaming-dispatch.ts`) restricts early-start to tools that are
   *  read-only AND concurrency-safe, so a turn that ends in a `refusal` cannot
   *  have already committed a MUTATING side effect at the PARENT dispatch seam
   *  (e.g. `session_config` set_effort, `automation_update`). Those tools must
   *  stay deferred and must NOT implement this method.
   *
   *  `agent` is the deliberate exception: it is `isConcurrencySafe:true` but
   *  `isReadOnly:false` (it spawns a child loop that owns an unrestricted tool
   *  set). Its effects do NOT land at the parent seam — they happen INSIDE the
   *  child loop, behind the child's OWN dispatch gates and its OWN
   *  `AbortController`, with the parent's depth/budget guards already applied.
   *  Without this opt-in, T02's read-only gate silently serializes sibling
   *  `agent` fan-out (ADR-0296/0298), defeating the whole parallel-worker
   *  design. Implementing `isEarlyDispatchSafe: () => true` restores in-flight
   *  concurrency for agent fan-out WITHOUT loosening the parent-seam mutation
   *  guard for any other tool.
   *
   *  When omitted, the streaming-dispatch gate falls back to `isReadOnly()` —
   *  byte-identical to the T02 behavior. Returning `true` here means "early
   *  start is acceptable even though I am not read-only". */
  isEarlyDispatchSafe(): boolean
}

/**
 * jun-6 tool-interrupt-behavior — OPTIONAL per-tool interrupt policy. A THIRD
 * member of the per-tool-predicate family alongside `isReadOnly()` /
 * `isConcurrencySafe()` on {@link ToolCore}: a tool self-describes a property
 * the SCHEDULER (here, the abort-router in `@/agent`) consumes. Kept as its own
 * optional `Partial` arm (not a required `ToolCore` member) so the default is
 * absence-by-construction — exactly the {@link ToolSecurityHooks} shape.
 *
 * The dispatch abort-router reads it as `tool.interruptBehavior?.() ?? "cancel"`:
 *   - ABSENT / `"cancel"` ⇒ the raw `config.signal` is threaded into
 *     `ctx.signal` (legacy uniform turn-level cancel, BYTE-IDENTICAL). Every
 *     existing tool (`read`/`grep`/`glob`/`ls`/`bash`/…) is on this path.
 *   - `"block"` ⇒ the router threads a SUPPRESSIBLE derived signal and wires the
 *     {@link CriticalSectionSeam} so the tool can withhold the abort across its
 *     bounded atomic FS-mutating window only (see `ctx.criticalSection`).
 *     `write`/`edit` (and future atomic appliers) opt in here.
 *
 * `block` defers a cancel across ONE bounded window (a watchdog cap, RFC §4.3);
 * it can never veto an interrupt forever. The whole feature is additionally
 * gated OFF by the `QUANTA_TOOL_INTERRUPT_BLOCK` knob, so a tool returning
 * `"block"` while the knob is unset is byte-identical to `"cancel"`.
 */
export interface ToolInterruptPolicy {
  /** How an in-flight interrupt is handled while THIS tool's `execute` runs.
   *  Absent ⇒ `"cancel"` (legacy uniform behavior, byte-identical). */
  interruptBehavior(): "cancel" | "block"
}

/**
 * Optional result-shape contract (absorb #1). Wired into the registry/factory
 * seams so a tool can opt in WITHOUT changing dispatch. Removing a field would
 * break its seam, NOT just its callers. See STATUS below for per-field live use.
 *
 *   - `outputSchema`           → `factory.enforceOutputSchema` +
 *                                `registry.run` (also `@/subagent/tools-6`).
 *   - `toModelOutput`          → `factory.renderToolOutput` + `registry.run`.
 *   - `supportsDeferredResults` → `@/tool/deferred` registry + dispatch.
 *
 * STATUS — do NOT treat this interface as dead:
 *   - `toModelOutput` IS LIVE: set by the `apply_patch_structured` production
 *     tool (`makeApplyPatchStructuredTool`, `apply-patch-structured-tool.ts`),
 *     which is conditionally registered at `index.ts` when
 *     `ports.structuredPatch === true` (ADR-0464). Deleting the seam breaks a
 *     live tool, not just a latent one.
 *   - `outputSchema` has an external live consumer surface: the subagent's
 *     `output_schema` use (`@/subagent/tools-6`).
 *   - `supportsDeferredResults` is set only by the `defineToolAsync` helper
 *     (`async-helper.ts`), not by any registered tool — no live in-tree
 *     consumer today.
 * The dispatch/factory wiring is retained; new built-in tools SHOULD still be
 * conservative here. Prefer: (a) put structured payloads in the `output` text
 * directly, (b) keep result rendering inside the tool (`result.output` IS the
 * model-facing text) unless a compact model rendering genuinely helps (as
 * `apply_patch_structured` does), (c) use the orchestrator's polling for
 * long-running work rather than an in-band deferred handle.
 */
export interface ToolResultShape<O = unknown> {
  /** @deprecated Schema for the tool's STRUCTURED result
   *  (`ToolResult.structured`). When present, the dispatch seam validates the
   *  structured payload via {@link validateToolOutput}; a mismatch is surfaced
   *  as an `ok:false` ToolResult instructing the model to retry — never thrown
   *  past the loop. Absent ⇒ no structured-output contract (byte-identical).
   *  No built-in tool sets this today; the subagent's external use is the
   *  only live consumer. Prefer placing structured data in `output` directly. */
  outputSchema: z.ZodType<O>
  /** Produce a COMPACT, model-facing rendering of a result, distinct from the
   *  richer UI/`output` text, to save tokens. When absent the dispatch seam
   *  uses `result.output` as today (byte-identical). LIVE: set by the
   *  `apply_patch_structured` tool to render its per-file `AppliedChange[]` so
   *  the model can self-correct only the failed file(s). Other tools should
   *  keep rendering inside the tool so `result.output` is the single source of
   *  model-facing text unless a compact model rendering genuinely helps. */
  toModelOutput(result: ToolResult): string
  /** @deprecated When `true`, this tool may return a deferred result (a
   *  `{type:"deferred"}` event or `ToolResult.deferred`) that a
   *  `DeferredResultRegistry` resolves later. Absent/false ⇒ synchronous only.
   *  No built-in tool sets this today; prefer the orchestrator's polling over
   *  in-band deferred handles. */
  supportsDeferredResults: boolean
}

/**
 * Optional streaming-input callbacks (absorb #1). Mirror of the LLM
 * `tool_use_start` / `tool_use_delta` / `tool_use_end` events. Wired into
 * `factory.driveStreamingInput` + `@/agent/tool-input-streaming`, but no
 * built-in tool sets these today. All three are individually optional and
 * side-effecting only — the parsed input is still passed to `execute`.
 *
 * @deprecated AS A GROUP — zero production tools set any of these. The
 * dispatch wiring is retained for a possible future opt-in (deleting would
 * break the seam, not just callers), but new built-in tools SHOULD NOT
 * implement them; let `execute(input, ctx)` receive the parsed input as
 * today. File an ADR if you have a real streaming-input use case.
 */
export interface ToolStreamingInput<I = unknown> {
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputStart(): void
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputDelta(delta: string): void
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputAvailable(input: I): void
}

/**
 * RFC-06 F3 — OPTIONAL dynamic-spec arm. A tool whose advertised {@link ToolSpec}
 * is NOT frozen at construction implements `getSpec()`, which the registry
 * dereferences ON EVERY MODEL REQUEST (see `ToolRegistry.specs`). Two live uses:
 *   - RFC-06 F3 (`Skill`): the "Available skills:" description tracks the LIVE
 *     runtime authority — a skill disabled after tool construction disappears
 *     from the model spec surface on the NEXT request, with no rebuilt registry.
 *   - RFC-05 E5b (`request_user_input`): the arm returns `undefined` to HIDE the
 *     tool while the live question-posture DENIES it, and the static spec while
 *     the posture ADMITS it — so the model-visible spec tracks the SAME live
 *     reader the pre-dispatch consult resolves through, per request. A session
 *     that STARTED in a denying posture reappears the moment the posture admits.
 *
 * Contract:
 *   - ABSENT (the common case — every static tool) ⇒ the registry advertises the
 *     tool's static `{name, description, inputSchema}` exactly as today
 *     (byte-identical). This is a `Partial` arm on {@link Tool}, so absence is
 *     the default by construction.
 *   - PRESENT but returns `undefined` ⇒ the tool is HIDDEN from THIS request's
 *     spec list (posture-driven visibility). This is DISTINCT from the absent-arm
 *     static fallback above: a dynamic tool that wishes to advertise its static
 *     shape returns a `ToolSpec`, never `undefined`. (The `Skill` tool always
 *     returns a `ToolSpec`, so it is never hidden.)
 *   - PRESENT and returns a `ToolSpec` ⇒ the registry advertises THAT spec for
 *     this request. The returned `name` MUST equal the tool's `name` (the
 *     registry keys dispatch by the static name; a dynamic spec only refreshes
 *     the description / schema, never the identity or the tool set — a disable
 *     changes what a tool SAYS, never the registry generation).
 *
 * Purely a READ: `getSpec` must be side-effect-free and cheap enough to call
 * once per model request. It owns no mutation of the runtime authority.
 */
export interface ToolDynamicSpec {
  /** The tool's CURRENT provider-facing spec, or `undefined` to HIDE the tool
   *  from this request's spec list (the RFC-05 E5b posture-driven hide — the
   *  registry drops it entirely, it does NOT fall back to the static fields).
   *  Dereferenced by `ToolRegistry.specs()` on every model request. */
  getSpec(): ToolSpec | undefined
}

/** Provider-agnostic schema the agent forwards to the LLM.
 *  `aliases` is a discovery-only hint used by the `ToolSearch` skill for
 *  lexical scoring (token + substring match at name-weight). It is NEVER
 *  forwarded to LLM provider adapters — both `@/llm/adapters/anthropic` and
 *  `@/llm/adapters/openai` explicitly project to `{ name, description,
 *  input_schema }` so the alias hint stays inside the tool catalog and the
 *  on-wire `tools` payload remains byte-identical for callers that omit
 *  `aliases`. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
  aliases?: string[]
}
