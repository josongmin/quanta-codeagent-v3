# ADR-0058 — Anthropic beta channels + 30 MB skill size cap

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0002 (Anthropic SDK adapter), ADR-0022 (skill trigger + discovery), [[claude-desktop-1-7196-catalog]] §skills-2025-10-02, [[cc-v2-sota-absorption]] (Tier-0 absorption #0-6)

## Context

Two findings from the Claude Desktop 1.7196.3 catalog landed together because
they share one shipping concern: skill API access.

1. **`anthropic-beta` header.** Claude Desktop activates the Skills API with the HTTP header `anthropic-beta: skills-2025-10-02`. Desktop also uses `environments-2025-11-01` and `oauth-2025-04-20`. quanta's Anthropic adapter sends NO beta header — newer Claude features that gate behind a date-versioned channel are invisible to v3.

2. **30 MB skill file cap.** The Skills API itself enforces a 30 MB per-file ceiling (Claude Desktop's error copy: "Skill file is too large. Maximum size is 30 MB."). `src/skill/discover.ts` previously `readFile`'d every `.md` / `SKILL.md` unconditionally — a stray 500 MB log committed under a `skills/` dir would OOM the agent.

## Decision

### D1. Anthropic beta headers — opt-in `betaHeaders` config

`AnthropicConfig.betaHeaders?: readonly string[]`. The constructor joins
non-empty arrays with comma and sets `defaultHeaders: { "anthropic-beta": joined }` on the SDK client. Empty / undefined ⇒ the SDK is invoked WITHOUT
`defaultHeaders`, producing byte-identical requests to today.

Rationale for `defaultHeaders` over per-request: beta channels are a
PER-CONVERSATION property (one adapter = one session), so a single client-level
header is the minimal-surface seam. Per-request injection would multiply by
the number of request shapes (`messages.create`, future `messages.batches`,
etc.) without any benefit.

### D2. 30 MB skill size cap — pure module + discovery integration

`src/skill/skill-size.ts` — pure module exporting `MAX_SKILL_SIZE_BYTES = 30 * 1024 * 1024` and `checkSkillSize(path): Promise<SkillSizeCheck>`. The
return type is a DISCRIMINATED UNION:

```ts
type SkillSizeCheck =
  | { ok: true; size: number }
  | { ok: false; reason: "too-large" | "stat-failed"; path: string; size: number }
```

`reason` separates the two failure modes so a caller can log "too-large" loudly
(user-actionable) while staying quiet on "stat-failed" (a missing file is the
normal "not a skill" case).

`src/skill/discover.ts` calls `checkSkillSize` BEFORE `readFile` in both
`readNestedSkill` and `readFlatSkill`. Too-large files log a single
`console.warn` and are skipped; stat-failed files are silent.

## Consequences

**Positive**
- v3 can opt into the public Skills API by passing `betaHeaders: ["skills-2025-10-02"]` at adapter construction. Other beta channels (oauth, environments) compose into the same array.
- A pathological skill file no longer crashes discovery — it logs and the rest of the directory loads.

**Trade-offs**
- The 30 MB limit is duplicated in code AND the Anthropic API; if Anthropic raises the cap, we must bump the constant manually (no API to query).
- `console.warn` is used in `discover.ts` because `@/skill` is a leaf slice (no `@/observability` import allowed). Documented inline with a `biome-ignore`.

## Negative invariants

- `MAX_SKILL_SIZE_BYTES` MUST equal exactly `30 * 1024 * 1024`. Tested.
- `betaHeaders` UNSET MUST produce a request with no `anthropic-beta` header. Tested by inspecting the adapter's stored array.
- A file at exactly `MAX_SKILL_SIZE_BYTES` MUST be allowed (boundary inclusive). Tested.

## Files touched

- `src/skill/skill-size.ts` — NEW.
- `src/skill/discover.ts` — size-check guard in `readNestedSkill` and `readFlatSkill`.
- `src/llm/adapters/anthropic.ts` — `AnthropicConfig.betaHeaders?` + constructor wires `defaultHeaders`.
- `tests/unit/skill-size.test.ts` — NEW (7 cases incl. boundary).
