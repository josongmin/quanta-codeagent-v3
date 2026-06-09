# RFC-06: Rule Provenance & Conflict Observability

**Status:** PROPOSED · **Priority:** P2 · **Axis:** 5 (룰 우선순위)

## Problem statement

The rule-priority audit came back **healthier than expected** — most suspected gaps were refuted (deterministic glob ordering, same-dir first-wins, caller-system precedence, trust-gated loosening all verified; see index). What remains is an **observability** problem, not a correctness problem: when the precedence machinery makes a decision — a vendor rule loses a collision, a hook injects text — the decision is invisible. Nobody (user, model, or auditor) can see that a rule was dropped or whose code injected a prompt fragment. Silent-by-design becomes indistinguishable from silently-broken, and debugging "why did the agent ignore my .cursor rule" costs a deep-dive every time.

## Evidence (3-round audit; refuted items listed in 00-index, NOT here)

Confirmed remaining gaps:

- **Vendor collisions are silent.** `resolveCollisions` (`src/rules/vendor-detector/normalizer.ts:109-139`) drops the losing rule with no warn/log/emit — the comment (`normalizer.ts:12-16`) documents this as intentional ("the loser is silently dropped"), but ADR-0205 specified a collision warning; the observable surface was never built. Losing rules vanish without trace in `DetectionResult`.
- **Hook injects carry no identity.** `HookPromptInject` = `{injectAfterSystem?, injectBeforeUser?}` (`src/agent/hooks.ts:293-296`) — no hookName/source field. Rendering shows only a generic `## Hook context` header (`src/agent/prompt.ts:430`); the code comment claims "the label exposes the source" but only exposes *that a* hook ran, not *which*. The model and any audit cannot distinguish a built-in hook from a third-party plugin's injection. (Content IS defanged via `embedUntrusted` — injection safety is fine; attribution is the gap.)
- **SKILL.md tier declarations are unvalidated at parse time.** `hand-off-required` is correctly non-escalatable at enforcement (`src/agent/skill-scope-escalation.ts`, 32-cell matrix test), but a repo-authored SKILL.md can declare tiers/allowedTools with no lint/validation feedback — authors discover constraints only at runtime denial.
- (Recorded, no action: repo-rules same-dir handling only recognizes the 3 canonical filenames; a non-canonical rules file is silently ignored — accepted behavior, documented in the loader comment `src/agent/repo-rules.ts:30-32`.)

## Goals

1. Every rule-collision decision leaves an observable trace (event/log + queryable surface).
2. Every hook injection is attributable to its source, in the prompt and in audits.
3. Skill authors get validation feedback at discovery time instead of runtime surprises.

## Non-goals

- Changing any precedence semantics — all verified correct; behavior stays byte-identical for rule selection itself.
- Defanging changes (already sound via single `embedUntrusted` path).
- A general rules-conflict resolver/dedupe (the concat-with-attribution model for cross-level rules is working as designed).

## Workstreams (ticket-able)

### W1 — Collision surfacing in the vendor detector
Add `collisions: ReadonlyArray<{sourcePath, winnerVendor, loserVendor}>` to `DetectionResult` (additive field), populated by `resolveCollisions`. Consumers: (a) debug/log line at composition (same channel as other rule diagnostics), (b) `/state` or `/rules`-style panel listing active rules + dropped collisions. Behavior of rule selection unchanged.

**Acceptance:** unit: same sourcePath, two vendors → collision recorded, winner per priority table unchanged; zero collisions → empty array, byte-identical render. Closes the ADR-0205 spec/code gap (note it in the ADR's amendment).

### W2 — Hook identity threading
Extend `HookPromptInject` with optional `source?: {name: string, origin: "builtin" | "settings" | "plugin"}` populated by the hook bus at registration (the bus knows the registrant). Render as `## Hook context (from: <name>)`; absent source renders today's generic header (backward compatible). Emit the same identity on the hook's OTel/decision events for audit parity.

**Acceptance:** unit: named hook → labeled header; legacy hook without source → byte-identical current output; defang still applied to body (existing prompt-escape hellgate extended with a labeled case).

### W3 — SKILL.md frontmatter validation at discovery
At `discoverAndParseSkills` time, validate tier/allowedTools declarations: unknown tool names (against manifest SSOT), `hand-off-required` tools listed in `allowedTools` (will never run — author almost certainly misunderstands), malformed scope fields. Verdicts surface as discovery warnings (CLI startup + `/state` skills panel), never hard-fail discovery (a broken third-party skill must not brick the session).

**Acceptance:** fixture skills per defect class → warning with file+field; valid skills → zero warnings; discovery never throws (no-throw contract).

### W4 — (Tiny, docs) precedence SSOT page
One page under `docs/` consolidating the now-verified precedence rules (deeper-wins, same-dir candidate order, vendor priority, 4-section preset order, dynamic-block assembly order with the rationale comments from `src/agent/prompt.ts:517-569`), each line citing its pinning test. Audit rounds independently re-derived all of this twice; a SSOT page stops the re-derivation tax and gives skill/rule authors one reference.

## Risks

- W2 touches every hook registration site — keep the field optional and sweep registrants incrementally; the render fallback keeps unswept hooks working.
- W3 false alarms on exotic-but-valid skills — warnings only, never blocking; wording must say "suspicious", not "invalid", for the judgment-call classes.

## Relations

- Amends ADR-0205 (collision warning), extends ADR-0133 (hook RPC), ADR-0512 (skill scope) author-feedback story.
- `/state` panel work coordinates with RFC-07 surfacing.
