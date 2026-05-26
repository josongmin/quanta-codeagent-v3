# ADR-0333 — image-sanitization-retry production hookup in `createRunAgentContext`

## Status
Accepted. Hookup landed in `src/agent/loop.ts#createRunAgentContext` via user commit `1f95988554fa2a5cdb913c966088b15ef0730f7f` (`done`), which absorbed the W-D draft and tightened two decisions.

## Provenance

This ADR was drafted in parallel with W-D's worktree commit `dc821e90`. While the W-D agent was working, the user landed the same production hookup directly on `main` (`1f959885`). The landed code is **superset-strict** to the W-D draft, so this ADR is rewritten to document the landed semantics rather than the draft.

| Decision axis | W-D draft | Landed (1f959885) | Note |
| --- | --- | --- | --- |
| Engage condition | `enabled !== false` (default-ON when slot present) | `enabled !== true` (default-OFF unless explicit) | Landed is **safer** — empty `{}` knob does NOT engage |
| Helper name | `applyImageSanitizationRetryHookup` | `maybeWrapImageSanitizationRetry` | Naming-only |
| cfg clone trigger | `(dedupGateActive ∨ imageRetryActive) ∧ baseCfg===config` | **Unconditional** clone whenever `baseCfg === config` | Landed fixes a pre-existing leak — see §"cfg ownership" |

The W-D hellgate (`tests/unit/loop-image-retry-hookup-hellgate.test.ts`) was rewritten to pin the **landed** semantics — previously two cases asserted the draft's looser `enabled !== false` gate; both were updated to pin the stricter `enabled !== true` invariant.

## Context

ADR-0328 shipped `withImageSanitizationRetry` (`src/llm/image-sanitization-retry/`) — a closed-port `LLMPort` wrap that, on `LLMError("invalid_image", ...)` thrown BEFORE any event is yielded, calls ADR-0323's `HistorySanitizationPort.replaceLastTurnImages` and re-streams the inner adapter. Codex parity (`codex-rs/core/src/session/turn.rs:363-381`).

ADR-0328 explicitly deferred the production hookup pending a cfg-ownership decision. ADR-0332 added the `installCodexR2Wires` helper that populates the `cfg.imageSanitizationRetry` knob slot from a composition root's dep bag. With the slot reachable but no consumer, every session still got the bare `cfg.llm` and any `invalid_image` 400 propagated as `fatal/bad_request`.

This ADR documents the closing hookup that landed in `1f959885`.

## Decision

In `src/agent/loop.ts#createRunAgentContext`, immediately after `wm` is constructed, the cfg's LLM is wrapped via a private file-scope helper:

```ts
const wm = createWorkingMemory<Message>(buildSeedMessages(cfg))
cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)
```

The helper (extracted to keep cognitive-complexity under cap):

```ts
const maybeWrapImageSanitizationRetry = (cfg: AgentConfig, wm: WorkingMemory<Message>): LLMPort => {
  if (cfg.imageSanitizationRetry?.enabled !== true) return cfg.llm
  const port = createWorkingMemoryHistorySanitization(wm)
  const wrapOpts = {
    ...(cfg.imageSanitizationRetry.maxAttempts !== undefined
      ? { maxAttempts: cfg.imageSanitizationRetry.maxAttempts }
      : {}),
    ...(cfg.imageSanitizationRetry.placeholder !== undefined
      ? { placeholder: cfg.imageSanitizationRetry.placeholder }
      : {}),
  }
  return withImageSanitizationRetry(cfg.llm, port, wrapOpts)
}
```

### Default-OFF posture

The wrap engages only when `cfg.imageSanitizationRetry?.enabled === true`. Slot absent, `enabled === false`, `enabled === undefined`, or `{}` (no `enabled` key) all leave `cfg.llm` UNTOUCHED. This is stricter than the W-D draft's `enabled !== false` — a composition root must explicitly opt in (`{ enabled: true }`).

### cfg ownership — unconditional clone

The landed wire fixed a pre-existing leak. The previous gate `dedupGateActive && baseCfg === config` left the no-dedup / no-extra-tools path leaking subsequent mutations (`cfg.onPlanExitOutcome = ...`, `shellSnapshotSession`, the new `cfg.llm` wrap, dedup-gate attach, cap-enforcer attach, localize-phase attach, prompt-hook pending wire) back into the caller's `config`. Landed code clones unconditionally whenever `baseCfg === config`:

```ts
const baseCfg = buildEffectiveConfig(config, features.extraTools)
const cfg: AgentConfig = baseCfg === config ? { ...baseCfg } : baseCfg
```

The caller's `config` object is therefore NEVER mutated by ANY of the seven downstream mutations — including this ADR's wrap. Verified by `tests/unit/loop-image-retry-hookup-hellgate.test.ts §D`.

### Hookup site

The wrap runs immediately AFTER `createWorkingMemory<Message>` because `createWorkingMemoryHistorySanitization(wm)` needs the live wm. It runs BEFORE the dedup-gate / cap-enforcer / localize-phase attaches (none of those read `cfg.llm`, but the position keeps `cfg.llm` identity stable across the rest of the assembly).

### Codex parity

Retry budget defaults to 1 (Codex `maxAttempts: 1`). Placeholder defaults to `"[invalid image removed]"`. Caller knobs override.

## Limitations

- **Stale `input.messages` on retry.** The wrap re-passes the SAME `input` reference. The wm is mutated by `port.replaceLastTurnImages` but `input.messages` was snapshotted by the loop before the call. Under Codex's model `input.messages` IS the wm so the model sees the sanitized turn on retry; under our snapshot-decoupled model the retry sees the stale list. A future ADR may convert `input.messages` to a wm-live reference (or pass a re-snapshot callback into the wrap). Out of scope here.

- **Per-session hookup, not per-turn.** A composition root that wants to toggle the wrap mid-session must rebuild the session.

- **Opt-in default.** The stricter `enabled !== true` guard means callers that pass `imageSanitizationRetry: {}` get NO retry. Composition roots that want default-ON retry must pass `{ enabled: true }` (or use the `installCodexR2Wires` knob with `enabled: true`).

## Tests

`tests/unit/loop-image-retry-hookup-hellgate.test.ts` — 6 cases pinning the landed semantics:

| Section | Coverage |
| --- | --- |
| §A absent slot ⇒ `cfg.llm` untouched | 1 |
| §B `enabled === false` ⇒ no wrap | 1 |
| §C `enabled !== true` ⇒ no wrap (undefined treated as off — landed semantics) | 1 |
|     `enabled === true` ⇒ wrap engages, bounded retry | 1 |
| §D caller's `config.llm` reference NEVER mutated | 1 |
| §E empty knob `{}` ⇒ NO wrap (default-OFF) | 1 |
| Total | 6 |

`bun test tests/unit/loop-image-retry-hookup-hellgate.test.ts` ⇒ 6 / 0 fail / 8 expects.

Companion suites unchanged: `tests/unit/working-loop.test.ts`, `tests/unit/recovery-hellgate.test.ts`, `tests/unit/retry-hellgate.test.ts`, `tests/unit/prompt-adr-0327-wire-hellgate.test.ts` — all green, no regression.

## Non-goals

- Per-turn rebuild of the wrap.
- Switching `input.messages` to a wm-live reference (separate ADR).
- Re-snapshotting the wm inside the retry decorator.

## References

- User commit `1f95988554fa2a5cdb913c966088b15ef0730f7f` — landed hookup (`done`).
- `src/agent/loop.ts` — `maybeWrapImageSanitizationRetry` helper + call site (post-rebase line numbers shift per file edits — see commit diff).
- ADR-0323 — `HistorySanitizationPort` + WorkingMemory adapter.
- ADR-0328 — `withImageSanitizationRetry` decorator + `invalid_image` LLMErrorKind. The user also updated ADR-0328's body in `1f959885` with the wire section that mirrors this ADR's §Decision.
- ADR-0332 — composition wire helper (`installCodexR2Wires` populates the `cfg.imageSanitizationRetry` knob slot).
