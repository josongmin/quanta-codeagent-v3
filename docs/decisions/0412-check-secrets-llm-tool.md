# ADR-0404 — `check_secrets` LLM-facing tool over async secret-detection

**Status:** Accepted (2026-05-28)
**Slice:** new `src/tool/check_secrets.ts` (leaf tool) + new `src/agent/tier1/check-secrets.ts` (env-gated tier-1 builder) + 1-line wires in `src/agent/tier1/index.ts` and `src/agent/features.ts` + hellgate `tests/unit/check-secrets-tool-hellgate.test.ts`.
**Default-OFF:** Yes — absent `QUANTA_SECRET_CHECK_TOOL=on` ⇒ the tool is NOT registered, `extraTools` is unchanged, and every existing session is byte-identical.

## Context

The codebase has two complementary secret-handling surfaces today:

1. `src/security/redaction.ts` (`applyRedaction`, ADR-0078) — a
   **sync, masking-only** path wired into `dispatch.ts:739`. It mutates
   tool_result text on its way back to the model, replacing matched
   secrets with `[REDACTED]` placeholders. Always-on. The model NEVER
   sees that a redaction happened.
2. `src/security/secret-detection/` (ADR-0164) — an **async,
   detection-only** module. `compositeSecretScanner` returns a
   `SecretFinding[]` (`kind`/`line`/`column`/`preview`/`confidence`/
   `entropyBits`) and does not mutate the input. The barrel comment is
   explicit: "Default-OFF: nothing in dispatch/loop/agent wires this
   today." No consumer exists.

The natural next step is to expose the detector to the LLM so the
model can branch on its result ("is this text/file safe to commit?",
"does this PR diff leak a key?"). The closely-adjacent ADR-0399 wired
the analogous **PII** scanner into the sync `applyRedaction` slot —
this ADR is its sibling for **secrets**, but lands on a different seam
because the two scanners have incompatible semantics with that slot
(below).

### Why this can NOT drop into `applyRedaction`

ADR-0399 was able to wire `compositePiiScanner.redactText(text, opts)`
into `dispatch.applyRedaction` because:

- `redactText` is a sync `(text, opts) => string` — exactly the shape
  `applyRedaction` expects.
- The PII scanner SPLICES masks into the input string (it has a
  redaction semantic, not a detection semantic).

`compositeSecretScanner` has neither property:

- `scanText` / `scanFile` are `Promise<SecretFinding[]>` — async. The
  `applyRedaction` call site is sync, lives on the
  per-`tool_result` text hot path, and is called from synchronous
  dispatch code; making it async cascades a Promise through the entire
  redaction pipeline and pays an `await` per tool result for a
  *detection* signal that the redactor has no way to consume.
- The scanner returns **findings** (positions + confidence +
  entropy), not a rewritten string. There is no return channel from
  `applyRedaction` back to the model — the masking step is invisible
  by design (the model never knows it happened). Trying to bolt a
  finding-emitter onto a masking slot either drops the findings (no
  consumer) or regresses the masking behavior (which is the
  always-on contract).
- The secret slice already provides a built-in always-on masking path
  via the older `src/security/redaction.ts` (the pre-detection-slice
  AWS/PEM regex pipeline). That path is the canonical sync seam; the
  detection slice exists **for a different consumer** — one that
  needs structured findings.

The LLM is exactly that consumer. A tool surface lets the model:

- inspect a string/file BEFORE committing it (`pre-commit gate`
  semantic), branch on `findings.length === 0`, and decide whether to
  push, edit, or ask the operator;
- read structured `kind`/`confidence` so it can distinguish a
  high-confidence AWS key from a medium-confidence entropy hit and
  choose the right next action;
- avoid drowning in the false-positive surface that the always-on
  redactor would otherwise create if it were tuned to maximum recall.

### What is NOT in this ADR

- Wiring `check_secrets` into `defaultTools` (always-on). Default-OFF
  is intentional: registering the tool exposes a new surface to the
  model and changes the prompt token bill. Sessions that have no
  use for the tool stay byte-identical until the operator opts in
  with the env knob.
- A pre-commit hook / CI gate consumer. Those are sibling surfaces
  that can call `compositeSecretScanner` directly; the LLM tool is
  one consumer of the same port.
- Mutating `applyRedaction`. The sync masking layer is untouched.
- Changes to `AgentConfig`. The builder reads `process.env` directly
  via an injectable `CheckSecretsEnvReader` port — mirroring the
  `runtime-wire.ts` env-gating posture, not the `AgentConfig`-gating
  posture. The reasoning: there is no port to inject (the scanner is
  pure), so the natural gate is the env knob itself.

## Decision

Add three artefacts and three one-line wires:

1. `src/tool/check_secrets.ts` — `checkSecretsTool` defined via
   `defineTool`, taking a zod-validated XOR input
   `{ text } | { file_path }`, returning
   `ToolResult<CheckSecretsStructured>` where `structured.findings` is
   `SecretFinding[]`. `isReadOnly() === true` and
   `isConcurrencySafe() === true`. The body wraps the scanner call in
   `try/catch` and yields a typed `{ mode: "error" }` failure on
   exception — the tool boundary never throws (RFC §6.2 no-throw).
2. `src/agent/tier1/check-secrets.ts` — `buildCheckSecretsBlock(env?)`
   returns `[checkSecretsTool]` iff `env.get("QUANTA_SECRET_CHECK_TOOL")
   === "on"`; `[]` otherwise. The env reader is injectable for tests.
   The gate uses the STRICT canonical value `"on"` (not any truthy
   string) — `"1"`/`"true"`/`"yes"`/`"On"` are all default-OFF, mirroring
   `AUTOMATION_ENV_FLAG`'s posture in `runtime-wire.ts`.
3. One export added to `src/agent/tier1/index.ts` and one line in
   `src/agent/features.ts` calling `buildCheckSecretsBlock()` after
   the budget block.
4. `tests/unit/check-secrets-tool-hellgate.test.ts` — 26 adversarial
   cases over the env gate (9), the byte-identical default-OFF
   composer integration (2), the zod XOR input (4), the scan
   behavior on known signatures + structural false-positives + file
   scans (7), the no-throw contract (2), and the tool surface
   metadata (4).

### Description text

The tool description spells out BOTH the use-case and the not-to-use
case:

> USE WHEN you must DECIDE whether text/file content is safe to commit,
> share, paste into a PR, or write to disk — the automatic redaction
> layer masks the transcript silently, so call this when you (the
> model) need to branch on the result.
>
> DO NOT USE for routine redaction of tool output; the dispatch layer
> already masks secrets in tool_result text automatically.

This avoids the failure mode where the model double-scans every
`read`/`grep` result and inflates token usage.

## Consequences

### Wins

- One more guardrail for "did this commit/share text contain a secret
  the model is about to push?" — closes the gap between the
  always-on redactor (silent) and the operator (out-of-band).
- The detection slice (`src/security/secret-detection/`) now has a
  first consumer; previously it was dead code. The hexagonal port
  shape is validated end-to-end.
- Default-OFF — zero token / prompt / runtime cost for sessions that
  do not opt in. Existing redaction contract preserved (untouched).

### Costs

- Two extra ports of surface area: the tool itself and the env knob.
- The env-gated tier-1 builder is the first that reads `process.env`
  inside `tier1/*` (other builders gate on `AgentConfig`). The
  reader is injectable so tests are deterministic, but the seam is
  novel for this directory. The mitigating posture: the gate IS the
  env, and synthesizing a config field would force the apps layer
  to read the env anyway.

### Negative invariants (compile / hellgate enforced)

- `applyRedaction` (`src/agent/dispatch.ts:739`) is byte-identical.
- `src/security/redaction.ts` is byte-identical.
- `src/security/secret-detection/*` is byte-identical (no public
  surface added or changed).
- `defaultTools` (`src/tool/index.ts`) is byte-identical (the tool
  is registered via `SessionFeatures.extraTools`, not the default
  set).
- `buildSessionFeatures` with no `QUANTA_SECRET_CHECK_TOOL` set
  produces an `extraTools` array that does NOT contain a tool named
  `check_secrets` (hellgate B1).
- Strict canonical gate — `"1"`/`"true"`/`"yes"`/`"On"`/`"off"` are
  all default-OFF (hellgate A1–A9).
- XOR input — exactly one of `text` / `file_path` (hellgate C1–C4).

## References

- ADR-0078 — sync secret redaction in dispatch.
- ADR-0164 — async secret-detection slice (port + adapters).
- ADR-0399 — PII redaction wire (the sibling that COULD drop into
  `applyRedaction` because its scanner is sync + masking).
