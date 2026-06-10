# RFC-06 (FINAL): Rule Provenance & Conflict Observability

**Status:** FINAL · **Priority:** P2 · **Axis:** 5 (룰 우선순위)
**R4 revision:** W2 corrected — the hook bus does NOT know registrant identity today; the deliverable is a registration-API extension. Function name fixed (`discoverSkills`). SOTA section added.

## Problem statement

The rule-priority audit came back healthier than expected — most suspected gaps were refuted (deterministic glob ordering, same-dir first-wins, caller-system precedence, trust-gated loosening; see index). What remains is **observability**: when the precedence machinery decides — a vendor rule loses a collision, a hook injects text — the decision is invisible. Silent-by-design is indistinguishable from silently-broken, and "why did the agent ignore my .cursor rule" costs a deep-dive every time.

## Evidence (3-round audit + R4 corrections; refuted items live in 00-index, not here)

- **Vendor collisions silent:** `resolveCollisions` (`src/rules/vendor-detector/normalizer.ts:109-139`) drops losers with no warn/log/emit; comment (`:12-16`) documents intent, but ADR-0205 specified a collision warning that was never built. Losing rules vanish without trace.
- **Hook injects carry no identity:** `HookPromptInject` = `{injectAfterSystem?, injectBeforeUser?}` (`src/agent/hooks.ts:293-296`); generic `## Hook context` header (`src/agent/prompt.ts:430`). **R4-M6:** `HookOnOptions` = `{matcher?, timeoutMs?}` and `StoredHandler` carries no identity (`hooks.ts:540-549`) — the bus does NOT know the registrant; threading identity is an API extension, not population of existing knowledge. (Content IS defanged via `embedUntrusted` — safety fine; attribution is the gap.)
- **SKILL.md tier declarations unvalidated at load:** enforcement is correct (`hand-off-required` non-escalatable, 32-cell matrix), but authors get zero feedback at discovery; runtime denial is the first signal.
- Recorded, no action: non-canonical same-dir rule filenames silently ignored (documented loader behavior, `src/agent/repo-rules.ts:30-32`).

## SOTA alignment (R4 corpus)

- **Claude Code (strongest baseline on hook provenance):** hook output wrapped in labeled `<system-reminder>` ("The hook's output was: …") and — notably — the **permission dialog displays the hook's source** (settings/plugin/skill origin; changelog v1.1698). W2 absorbs this (label the source) and exceeds it (identity in the *prompt* attribution and on decision events, not just the permission UI).
- **Claude Code settings precedence** (user<project<local<flag<policy, schema-documented) ≈ quanta's verified multi-tier stack — parity, recorded in W4's SSOT page for comparison.
- **Untrusted repo config:** CC ships trust warnings + `claudeMdExcludes`; Cursor leans on VSCode workspace trust. quanta's trust gate (deny-always / loosening-dropped, `src/config/merge.ts:85-149`) is already at or above both — no action.
- **Frontmatter validation:** CC has a passive JSON schema for skills/agents, no author-facing lint at load. **No competitor ships collision observability or active frontmatter feedback** — W1/W3 are exceed-class.

## Goals

1. Every rule-collision decision leaves an observable trace.
2. Every hook injection is attributable to its source — in the prompt, and on decision events.
3. Skill authors get validation feedback at discovery time.

## Non-goals

- Changing precedence semantics (verified correct; rule selection stays byte-identical).
- Defanging changes (sound; single `embedUntrusted` path).
- A general rules-conflict resolver (concat-with-attribution across levels is working as designed).

## Workstreams (ticket-able; see tickets/T-601..604)

### W1 — Collision surfacing in the vendor detector
Additive `collisions: ReadonlyArray<{sourcePath, winnerVendor, loserVendor}>` on `DetectionResult`, populated by `resolveCollisions`. Consumers: composition-time debug/log line + a `/state`-class panel listing active rules and dropped collisions. Selection behavior unchanged.

**Acceptance:** same sourcePath two vendors → collision recorded, winner unchanged; zero collisions → empty array, byte-identical render. ADR-0205 amended to note the spec/code gap closure.

### W2 — Hook identity (registration-API extension + attributed render)
**Deliverable is the API change (R4-M6):** extend the registration surface (`HookOnOptions` or a parallel arg) with `source?: {name, origin: "builtin"|"settings"|"plugin"}`; store on `StoredHandler`; thread into `HookPromptInject`. Render `## Hook context (from: <name>)`; absent source → today's generic header (backward compatible — unswept registrants keep working). Same identity attached to hook decision/OTel events. Registrant sweep is incremental: first-party registrants in this ticket; long-tail plugins follow the optional-field path naturally.

**Acceptance:** named hook → labeled header; legacy hook → byte-identical output; defang preserved (prompt-escape hellgate extended with a labeled case); decision event carries identity.

### W3 — SKILL.md frontmatter validation at discovery
In `discoverSkills` (`src/skill/discover.ts:301`): validate tier/allowedTools — unknown tool names (vs manifest SSOT), `hand-off-required` tools in `allowedTools` (will never run), malformed scope fields. Surface as discovery **warnings** (CLI startup + `/state` skills panel); never fail discovery (broken third-party skill must not brick the session). Wording: "suspicious", not "invalid", for judgment-call classes.

**Acceptance:** fixture skills per defect class → warning w/ file+field; valid skills → zero warnings; discovery no-throw preserved.

### W4 — (Tiny, docs) precedence SSOT page
One `docs/` page consolidating the verified precedence rules (deeper-wins, same-dir candidate order, vendor priority, 4-section preset order, dynamic-block assembly order + rationale from `src/agent/prompt.ts:517-569`), each line citing its pinning test; includes the CC settings-hierarchy comparison. Two audit rounds independently re-derived all of this — the page stops the re-derivation tax.

## Risks

- W2 touches hook registration sites — optional field + render fallback keeps unswept hooks working.
- W3 false alarms on exotic-but-valid skills — warnings only.

## Relations

- Amends ADR-0205; extends ADR-0133 (hooks) and ADR-0512 (skill scope) author-feedback story.
- `/state` panels coordinate with RFC-07 W4.
