import type { ToolUseBlock } from "@/llm"
import { type RedactionHit, redactSecrets, type SensitivityClass } from "@/security"
import { compositePiiScanner } from "@/security/pii-redaction"
import { runtimeConfig, sliceTailWholeChars } from "@/shared"
import { deriveProvenance, type ToolContext, type ToolResult } from "@/tool"
import { composeToolResultContent } from "@/tool/image/compose"
import { wireCheckpointedEffectChannel } from "../checkpoint-wiring"
import { resultBlock } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import { LocalEffectChannel } from "../effect-channel"
import type { AgentConfig } from "../types"
import { wrapToolResult } from "../untrusted-envelope"
import { openLintBracket, runEditCommandRepair } from "./edit-repair"

/** Max chars of stderr retained on the dispatch result (RFC-0002 §5.2).
 *  Kept in lock-step with the per-tool cap (bash/test_runner = 4 000) so this
 *  is genuinely a defense-in-depth backstop — for a well-behaved tool the
 *  trim is idempotent (`slice(-4000)` of an already-≤4000 string), and it
 *  only kicks in when a third-party tool exceeds the agreed cap. R5 audit
 *  C1 found the previous 2 000 here silently dropped the front half of
 *  every well-behaved tool's evidence; matching caps removes that no-op
 *  layered halving. */
const STDERR_TAIL_CAP = 4_000

/** Read RFC-0002 §5.2 evidence from a `ToolResult.evidence` (CR3: typed, not
 *  duck-typed). The dispatch surface flattens the optional nested fields onto
 *  `DispatchResult` (`stderrTail` / `exitCode` / `fullLogPath`) — the stream
 *  and trajectory recorders consume those flat fields unchanged. Each output
 *  field is conditional-set so `exactOptionalPropertyTypes` never sees an
 *  `undefined` value. */
const evidenceOf = (
  result: ToolResult,
): Pick<DispatchResult, "stderrTail" | "exitCode" | "executedCommand" | "fullLogPath"> => {
  const out: Pick<DispatchResult, "stderrTail" | "exitCode" | "executedCommand" | "fullLogPath"> =
    {}
  const ev = result.evidence
  if (ev === undefined) return out
  if (typeof ev.stderr === "string" && ev.stderr.length > 0) {
    out.stderrTail = sliceTailWholeChars(ev.stderr, STDERR_TAIL_CAP)
  }
  if (typeof ev.exitCode === "number") out.exitCode = ev.exitCode
  if (typeof ev.executedCommand === "string" && ev.executedCommand.length > 0) {
    out.executedCommand = ev.executedCommand
  }
  if (typeof ev.fullLogPath === "string" && ev.fullLogPath.length > 0) {
    out.fullLogPath = ev.fullLogPath
  }
  return out
}

/**
 * ADR-0078 Layer-1 source-class derivation. PR-2 self-audit fix: consults the
 * tool's DECLARED `classifySource(input)` method via the registry — no
 * `tool.name` / argument-field-name string matching. Pre-fix this was a
 * hard-coded `PATH_TOOL_NAMES` / `COMMAND_TOOL_NAMES` set that silently
 * skipped any custom tool whose name wasn't in the set (a leak surface that
 * directly contradicted the structural posture PR-1 established for
 * `Tool.isReadOnly()`). Now every file/command-touching tool DECLARES its
 * classifier; absence means the tool surfaces no path/cmd input and Layer-2
 * pattern matching is the only redaction (behavior-preserving for tools
 * that don't deal with paths/commands).
 *
 * The `label` rides into the `source_class_secret` placeholder so the user/
 * audit can see WHERE the redacted output came from; we derive it from the
 * tool's `extractShellCommand` (already a declared method) or — for path
 * tools — from a single canonical `path` field on the input. The latter is
 * intentionally narrow: the structural contract is that a tool declaring
 * `classifySource` for a path input also exposes `{path: string}` (current
 * convention; the `read` tool's schema enforces this). Tools wanting a
 * different label can expose `extractShellCommand` or future
 * `extractSourceLabel`.
 *
 * Never throws — a tool that throws inside `classifySource` is caught and
 * treated as `null` (Layer-2 only) so a tool-side bug cannot break dispatch.
 */
const deriveSourceClass = (
  call: ToolUseBlock,
  config: AgentConfig,
): { cls: SensitivityClass; label: string } | null => {
  const tool = config.registry.get(call.name)
  if (tool === undefined || tool.classifySource === undefined) return null
  let cls: SensitivityClass | null
  try {
    cls = tool.classifySource(call.input)
  } catch {
    // Tool-side bug must not break dispatch — treat as no source class.
    return null
  }
  if (cls === null) return null
  // Label derivation: prefer the tool's declared shell-command extractor
  // (already used by HARD_DENY); fall back to a `path` field on the input
  // for filesystem tools. A tool exposing neither still gets Layer-1 by
  // class but a generic label. Go through `registry.extractShellCommand`
  // (NOT `tool.extractShellCommand` directly) so the tool's method receives
  // its SCHEMA-VALIDATED input — the registry safeParses first (registry.ts:80),
  // exactly the contract HARD_DENY relies on. Calling the tool method with the
  // RAW `call.input` here would hand it the uncoerced/maybe-invalid shape the
  // schema would have rejected/normalized.
  const shellCmd = config.registry.extractShellCommand(call.name, call.input)
  const inputPath =
    call.input !== null && typeof call.input === "object" && "path" in call.input
      ? (call.input as { path: unknown }).path
      : null
  const label =
    typeof shellCmd === "string" && shellCmd.length > 0
      ? shellCmd
      : typeof inputPath === "string" && inputPath.length > 0
        ? inputPath
        : `<${call.name}>`
  return { cls, label }
}

/**
 * ADR-0078 application point #1 — tool result normalization. Applies
 * `redactSecrets({origin:"tool_result", sourceClass})` with the Layer-1
 * class derived from the call's input shape. When the host has opted out
 * via `config.redaction.disabled === true` (validated at startup) we
 * skip — the disabled mode is announced as a `<system-reminder>` so the
 * model is never silently unprotected.
 *
 * ADR-0399 application point #2 — OPTIONAL PII-redaction pass. Runs AFTER
 * the secret pass on the already-secret-masked text (so a secret placeholder
 * can never accidentally re-expose PII that was hiding inside the secret
 * span, and PII never accidentally rewrites a `[REDACTED:*]` token already
 * substituted by secret-redaction). Strict gate: `pii?.enabled === true`
 * — any other value (false / undefined / absent block) means OFF and the
 * scanner is never instantiated. Default-OFF: absent config ⇒ byte-identical
 * to the secret-only baseline. Orthogonal to the secret branch — the two
 * passes never cross-talk; either branch can be on with the other off.
 *
 * NOT in scope for ADR-0399: the async `src/security/secret-detection/`
 * module is detection-only (no splice) and cannot drop in here. Its wire
 * is a separate gate/tool ADR.
 */
const applyRedaction = (
  text: string,
  call: ToolUseBlock,
  config: AgentConfig,
): { output: string; hits: ReadonlyArray<RedactionHit> } => {
  let postSecret = text
  let hits: ReadonlyArray<RedactionHit> = []
  if (config.redaction?.disabled !== true) {
    const src = deriveSourceClass(call, config)
    const result = redactSecrets(text, {
      origin: "tool_result",
      ...(src !== null ? { sourceClass: src.cls, sourceLabel: src.label } : {}),
      ...(config.redaction?.whitelist !== undefined
        ? { whitelist: config.redaction.whitelist }
        : {}),
    })
    postSecret = result.text
    hits = result.hits
  }
  // PII pass — independent toggle. Strict `=== true` so any other shape
  // (false / undefined / missing block) keeps the byte-identical secret-only
  // path. The scanner is opts-in by call, no shared mutable state.
  const piiConfig = config.redaction?.pii
  if (piiConfig?.enabled === true) {
    const scanner = compositePiiScanner({
      ...(piiConfig.kinds !== undefined ? { kinds: piiConfig.kinds } : {}),
      ...(piiConfig.allowlist !== undefined ? { allowlist: piiConfig.allowlist } : {}),
      ...(piiConfig.redactionTemplate !== undefined
        ? { redactionTemplate: piiConfig.redactionTemplate }
        : {}),
    })
    postSecret = scanner.redactText(postSecret)
  }
  return { output: postSecret, hits }
}

/** Drive the registry through the relocatable effect boundary (ADR-0093 M1).
 *  The {@link LocalEffectChannel} owns the no-throw + duration contract that
 *  used to live in the inline try/catch below — it normalizes executor
 *  exceptions into `{ok:false, output:<msg>}` envelopes and measures
 *  `durationMs` channel-internal, so the orchestration plane here only has
 *  redaction + DispatchResult shaping to do. Adopting a SandboxEffectChannel /
 *  RemoteEffectChannel later swaps the channel constructor here ONLY — the
 *  surrounding redaction / failure / evidence flatten is substrate-agnostic.
 *
 *  Byte-identical to the prior inline try/catch: the channel's catch wording
 *  mirrors the QuantaError/toError(e).message path, and `durationMs` is still
 *  measured around `registry.run` (channel-entry → executor-return/throw). */
export const execute = async (
  call: ToolUseBlock,
  config: AgentConfig,
  ctx: ToolContext,
  onProgress?: (message: string) => void,
): Promise<DispatchResult> => {
  const localChannel = new LocalEffectChannel({
    execute: (c, c2, op) => config.registry.run(c.name, c.input, c2, op),
  })
  // ADR-0121 wire: when `config.shadowCheckpoint` is configured AND
  // `config.shadowOdb` is wired (and mode !== "off"), wrap with the auto-
  // checkpoint policy. Otherwise this returns `localChannel` UNCHANGED → the
  // entire dispatch path is byte-identical for any caller that did not opt
  // into ADR-0121. `resolveTool` delegates to the registry's `get` so the
  // policy's destructiveness oracle classifies the call via the same registry
  // the executor consults.
  const channel = wireCheckpointedEffectChannel(localChannel, config, (name) =>
    config.registry.get(name),
  )
  // ADR-0472 — open the lint-delta bracket BEFORE the edit so the pre-snapshot
  // reflects the file's diagnostics prior to the mutation. `null` ⇒ feature off /
  // non-edit / no provider (byte-identical).
  const lintBracket = await openLintBracket(call, config)
  const { result, durationMs } = await channel.execute({ call, ctx }, onProgress)
  // The channel collapses BOTH "tool returned ok:false" and "executor threw"
  // into the same `{ok:false, output:<msg>}` envelope shape — the throw path
  // simply lacks `failure` and `evidence`. Handling them uniformly here keeps
  // the DispatchResult shape byte-identical to the prior try-success branch:
  // `evidenceOf({})` is empty and the typed-failure spread is conditional, so
  // a normalized-throw result yields exactly the same fields as the old catch.
  const { output: redacted, hits } = applyRedaction(result.output, call, config)
  // ADR-0471 — untrusted-source envelope. Redact FIRST (above), then wrap the
  // already-redacted text so the model treats EXTERNAL output (mcp / web_fetch /
  // file content / plugin / bash) as DATA, not instructions. Provenance is
  // DERIVED from the CALL SITE (registry origin + tool name) via `deriveProvenance`
  // — never name-guessing. Default-OFF: `enabled:false` ⇒ `wrapToolResult` returns
  // the input unchanged ⇒ byte-identical. Trusted/internal output is never wrapped.
  const enveloped = wrapToolResult(
    redacted,
    deriveProvenance(call.name, config.registry.originOf(call.name)),
    { enabled: runtimeConfig().untrustedEnvelope },
  )
  // ADR-0287 — async-tool deferred-handle wire. When the tool's terminal
  // result carries a `deferred` marker (set by `defineToolAsync`), prepend
  // a stable `<deferred handle="..."/>` envelope so the LLM can branch on
  // the format. Absent ⇒ byte-identical (default-OFF). The deferred marker stays
  // OUTSIDE the untrusted envelope (it is a harness control token, not data).
  const outputBase =
    result.deferred !== undefined
      ? `<deferred handle="${result.deferred.id}"/>\n${enveloped}`
      : enveloped
  // ADR-0472 — append the INTRODUCED-lint delta (post − pre) so the model sees
  // exactly what THIS edit broke. No bracket ⇒ outputBase unchanged.
  let output = lintBracket !== null ? await lintBracket.finish(outputBase) : outputBase
  // ADR-0472 / H1 — LoopOnCommand: run the configured test/build/lint command
  // after a SUCCESSFUL path-bearing edit and auto-repair until green. Returns
  // `output` unchanged when unconfigured / non-edit (byte-identical default-OFF).
  // GATED on `result.ok`: a FAILED edit (old_string not found, jail-denied, …)
  // changed nothing, so running the command + letting the fast model rewrite the
  // file would be repairing a phantom edit (and could clobber the file over an
  // unrelated command failure). The lint loop is self-gating here (empty delta on
  // a no-op edit), but the command loop is NOT — so the guard lives at the seam.
  if (result.ok) output = await runEditCommandRepair(call, config, output)
  // ADR-0062 rule #3 — record the nextAction hint in the session tracker so
  // a subsequent call to the same (tool, path) can be checked. DEFAULT-OFF:
  // absent enforcer ⇒ optional-chain is a no-op, byte-identical.
  config.capEnforcer?.record(call.name, call.input, result.nextAction)
  // ADR-0126 wire: ask the composer whether this tool result needs the
  // structured `contentBlocks` form (only when `result.images` is non-empty).
  // The composer returns the legacy STRING when no images are attached, in
  // which case we omit `contentBlocks` and the tool_result block is
  // byte-identical to the pre-feature path. The `output` text inside the
  // composed array is the POST-REDACTION string, so secret-redaction keeps
  // firing on every code path (image bytes are opaque base64 attachments
  // the tool's own policy gates upstream).
  const composed = composeToolResultContent({ ...result, output })
  const contentBlocks = typeof composed === "string" ? undefined : composed
  // Defense-in-depth (#12) — route `failure.modelVisibleError` through the SAME
  // redaction chokepoint as `output` so a future surfacing of the field can never
  // leak a secret. Byte-identical when absent / no secret (applyRedaction returns
  // its input unchanged); redaction hits merge into `redactionHits`.
  const failureRedaction =
    result.failure?.mode === "error" && result.failure.modelVisibleError !== undefined
      ? applyRedaction(result.failure.modelVisibleError, call, config)
      : undefined
  const finalFailure =
    failureRedaction !== undefined
      ? ({ ...result.failure, modelVisibleError: failureRedaction.output } as typeof result.failure)
      : result.failure
  const allHits = failureRedaction !== undefined ? [...hits, ...failureRedaction.hits] : hits
  return {
    block: resultBlock(call.id, output, !result.ok, contentBlocks),
    ok: result.ok,
    preview: output,
    durationMs,
    ...evidenceOf(result),
    // absorb #2 (Cursor failure model): surface the tool's typed failure
    // reason verbatim when it classified one. Omitted when absent so
    // `exactOptionalPropertyTypes` never sees `undefined` and callers that
    // do not read `failure` stay byte-identical.
    ...(finalFailure !== undefined ? { failure: finalFailure } : {}),
    ...(allHits.length > 0 ? { redactionHits: allHits } : {}),
    // ADR-0062 rule #3 — forward the nextAction hint onto the DispatchResult
    // so consumers (stream emitters, recorders) can observe it. Omitted when
    // absent (exactOptionalPropertyTypes).
    ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
  }
}
