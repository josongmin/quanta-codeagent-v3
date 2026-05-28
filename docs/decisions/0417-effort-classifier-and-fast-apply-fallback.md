# ADR-0417 — Effort classifier + apply-patch fast-apply fallback (ports only)

**Status:** Accepted (2026-05-28)
**Slices:** new `src/agent/effort-classifier/` (`types` / `keyword-detector` / `store` / `index`) + new `src/agent/fast-apply-fallback/` (`types` / `runner` / `index`) + 2 `AgentConfig` slots + 2 `FeaturesConfig` Pick entries (`src/agent/types.ts`) + 2 hellgates (`tests/unit/effort-classifier-hellgate.test.ts`, `tests/unit/fast-apply-fallback-hellgate.test.ts`) + 2 feature-catalog rows.
**Default-OFF (ports only, consumer wiring deferred):** both slots are inert this wave — no code in `loop.ts` / `prompt-pipeline.ts` / `apply-patch.ts` triggers them, so the loop is byte-identical to the pre-ADR path (RFC §1.2).

## Context

Two competitor-absorption gaps share the trait "infra exists, wire later":

- **A1 — prompt-keyword effort escalation.** Claude/Codex bump reasoning effort when the user writes "ultrathink" / "think harder" / "be thorough", and when a tool keeps failing. quanta already owns the 5-tier `EffortLevel` axis (`src/agent/effort.ts`) and a `sessionEffort` accessor on `AgentConfig`, but nothing maps prompt signals onto that axis.
- **A2 — apply-patch fast-apply fallback.** When `apply_patch` rejects a V4A patch (anchor drift / parse error), Codex/Cursor make one focused model call to re-emit the patch before surfacing the failure. quanta has `apply-patch.ts`, a `RoleModelResolver` (`src/llm/role-model-override/`, currently 0 consumers), and a side-conversation dispatcher (`src/agent/side-conversation/`), but no glue that composes them on a patch failure.

Wiring either consumer this wave would touch hot files (`loop.ts` / `prompt-pipeline.ts` / `apply-patch.ts`) that sibling worktrees + the user are editing in-flight. So this ADR ships PURE PORTS + logic + tests and defers the consumer wire.

## Decision

Add two self-contained leaf slices and two inert `AgentConfig` slots.

### A1 — `src/agent/effort-classifier/`

`createEffortClassifier(opts?)` → `EffortClassifierPort`:

- `onUserPrompt(text)` scans against the keyword rules (default `/ultrathink|think harder/i`→max, `/think hard|deeper/i`→high, `/be thorough/i`→high), emitting one `keyword` signal per match.
- `onToolFailure(toolName)` increments a per-tool counter; it fires exactly ONE `tool_failure_accumulation` signal at the moment the count reaches `failureThreshold` (default 3), voting `failureLevel` (default `high`) — not on every subsequent failure (avoids signal-log thrash).
- `currentRecommendation()` rolls signals up HIGHEST-WINS (`max>high>medium>low>default`, encoded by an exhaustive `EFFORT_INTENSITY` record) and NEVER downgrades.
- `reset()` clears keyword + failure + log state.

Pure leaf: imports only `EffortLevel`/`DEFAULT_EFFORT` from the sibling `./effort` (single-sourced tier vocabulary). NO-THROW: empty/whitespace/unicode prompts and pathological caller RegExps yield empty signals. Custom `keywordRules` REPLACE the default set (not merge) so a host has full control.

### A2 — `src/agent/fast-apply-fallback/`

`createFastApplyFallback(deps)` → `FastApplyFallbackPort` with `attempt({ failure, sourceFile?, sourceContent? }, signal?)`:

1. abort short-circuit (`signal.aborted` ⇒ `ok:false`, no dispatch);
2. `roleResolver.resolve("executor", defaultModel)` (Roo-style per-role pick; role miss ⇒ `defaultModel`);
3. build a focused prompt (names V4A, states `errorKind`+`errorMessage`, folds in the optional source snapshot, asks for ONLY the corrected patch);
4. `sideConversation.dispatch({ prompt, model })`;
5. extract a COMPLETE `*** Begin Patch` … `*** End Patch` block (`indexOf` scan — a Begin without an End yields `null`, never a half patch).

Result is `{ ok:true, newPatch, modelUsed }` on a complete block, else `{ ok:false, newPatch:null, rationale }` with a non-empty rationale.

**Slice fence:** types + `@/shared` only. The collaborators are DUCK-TYPED (`RoleResolverLike` / `SideConversationLike`) so this slice has NO import edge to `@/llm` (role-model-override) or `@/tool/apply-patch`. NO-THROW: a resolver throw, a dispatch throw, a non-ok dispatch, or an aborted signal all collapse to a typed `{ok:false}`.

### `AgentConfig` slots

`effortClassifier?: EffortClassifierPort` and `fastApplyFallback?: FastApplyFallbackPort`, plus both names on the `FeaturesConfig` Pick. Both are inert this wave (no consumer reads them) — absent ⇒ byte-identical.

## Consequences

- **Blast-radius minimal:** zero hot-file edits beyond the +25-line `src/agent/types.ts` slot/import addition. No collision surface with sibling worktrees or user in-flight (`loop.ts`/`prompt-pipeline.ts`/`apply-patch.ts` untouched).
- **TDD:** both hellgates were RED (module-not-found) before the slices existed; 27 cases (14 effort-classifier + 13 fast-apply) GREEN after.
- **No heuristics:** keyword matching is concrete regex, failure tracking is integer counters, patch extraction is substring scan — no fuzzy/LLM-judged intent (per [[no-heuristics-only-validated]]).

## Wire (deferred — follow-up ADR)

- **A1:** loop feeds seed user messages to `onUserPrompt`, dispatch tool failures to `onToolFailure`, and folds `currentRecommendation().level` into per-turn effort resolution (below an explicit skill/session override). Surface the recommendation on a status line / OTel attribute.
- **A2:** composition-root adapter maps the real `RoleModelResolver` + `dispatchSideConversation` onto `RoleResolverLike` / `SideConversationLike`; `apply-patch.ts` calls `attempt(...)` on a typed apply failure BEFORE surfacing the error, re-attempting `apply_patch` with `newPatch` when `ok:true`.
