# ADR-0047 — HITL 4-tier annotation registry

Status: accepted (2026-05-21)
Phase: SOTA++ Codex Desktop build 2867 absorption — round 4
Supersedes: none. Extends ADR-0020 (4-tier enum + gate) and ADR-0026
(admissibility-gate SSOT).

## Context

ADR-0020 introduced the 4-tier `HITLTier` enum
(`"hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"`) and
wired it through `runHitlGate`. The gate consulted exactly ONE source for
each call: the tool's own `hitlTier?(input)` declaration, with a fallback
inference from `isReadOnly()`.

Two gaps surfaced during the Codex Desktop build 2867 round-4 review
(`codex-desktop-build-2867-round-4`) of the Computer Use SKILL.md
confirmation policy:

1. **Authored vs. deployed stance.** A tool author chooses a default tier
   when shipping the tool. Hosts that deploy that tool in a stricter
   environment (regulated industries, shared multi-user installs) have no
   way to tighten the tier without forking the tool source. Conversely,
   well-known orchestration tools (`spawn_agent`, `wait_agent`, …) that did
   not self-classify defaulted to the secure-by-default `always-confirm`
   fallback — an over-escalation that broke ergonomic subagent flows.
2. **Per-command, not per-tool, sensitivity.** `exec_command` /
   `bash` carry the most blast radius variance of any tool: `ls` and
   `rm -rf /` enter the same code path. The tool can self-declare a tier,
   but the declaration is per-INVOCATION (it sees `input.command`) — and
   our Codex review showed authors rarely encode the full
   "irreversible / privileged / network-egress" matrix. We needed a
   centrally-reviewable command/argv pattern table.

## Decision

Introduce a 2-layer composition in front of the existing tier gate:

1. **Per-tool annotation registry** (`src/agent/hitl-tier-registry.ts`).
   Built-in table maps tool names to default `ToolHitlAnnotation`
   `{ tier, reason?, handoffMessage? }`. The table is data, not policy —
   one-line additions are reviewable.

2. **Per-command pattern table** (same file). Shell-class tools
   (`bash`, `exec_command`, anything carrying `command` / `parsed_cmd` /
   `argv`) route through a regex/argv-pattern array that classifies the
   actual command string. First match wins; falls through to the tool's
   own annotation when nothing matches.

3. **User override file** at `~/.quanta/hitl-overrides.json` (or
   `$QUANTA_HITL_OVERRIDES`). Read ONCE at first call, cached. Maps tool
   name → annotation. Missing / malformed file ⇒ silent fallback to
   built-ins. Invalid tier values are dropped per-key.

4. **Composition rule (one-way ratchet)** inside
   `admissibility-gate.ts#resolveHitlAnnotation`:
   - If the tool DECLARED a tier explicitly (`tool.hitlTier(input)`
     exists), compose with the registry by taking the STRICTER of the
     two (`hand-off-required > always-confirm > pre-approval-ok > none`).
     A host's override can only TIGHTEN; never loosen an authored tool.
   - If the tool did NOT declare a tier, the registry's annotation is
     authoritative. This fixes the over-escalation of orchestration tools.

5. **`handoffMessage` propagation.** When the resolved tier is
   `hand-off-required` AND the registry / override carries a
   `handoffMessage`, the dispatch gate surfaces that message in the deny
   block's `content` (instead of the generic "X is classified
   hand-off-required" suffix). This is what makes the deny non-silent —
   the UI sees WHY the agent gave up and WHAT the operator should do.

## Tier rubric (with examples)

| Tier | Meaning | Examples |
|---|---|---|
| `hand-off-required` | Irreversible, privileged, or audit-trail-erasing. NO mode authorizes; deny is terminal and surfaces a handoff message. | `rm -rf /`, `mkfs`, `dd of=/dev/sda`, `chmod -R 777 /`, `sudo …`, `history -c` |
| `always-confirm` | High blast radius but reversible / observable. Forces `onConfirm` regardless of mode (even `bypass`). Missing handler ⇒ deny. | `git push --force`, `git push` (network egress), `rm -rf <subdir>` |
| `pre-approval-ok` | Mutating but reversible. Defers to the existing `approval_policy` / mode policy. | `apply_patch`, `write`, `edit`, `write_stdin`, `send_input` |
| `none` | Read-only or pure orchestration; no side effects an operator cares about. Skip mode policy. | `read`, `grep`, `glob`, `ls`, `spawn_agent`, `wait_agent`, `task_output`, `bash` with `ls` / `pwd` / `cat <file>` |

## Relationship to ADR-0026 (admissibility gate)

ADR-0026 set the canonical 4-stage admissibility-gate order:

1. visible
2. plan / review / audit mode block
3. HITL tier (this ADR's surface)
4. permission policy (HARD_DENY + mode decision)
5. repo-local `pre_tool_use` hook

This ADR fills in stage 3 with the registry composition above. The other
stages are untouched; backwards compat is preserved by the
`config.hitl?.enabled === true` gating — when unset, the legacy path is
byte-identical.

## Relationship to ADR-0029 (reviewer 3-tier)

`ReviewerTier` (ADR-0029) is ORTHOGONAL to `HITLTier`. HITL classifies
WHETHER a confirmation is required and HOW recoverable a deny is.
ReviewerTier selects WHO decides when confirmation IS required (which
reviewer escalation path runs). Both axes coexist; this ADR does not
change reviewer routing.

## Consequences

- Hosts can install `~/.quanta/hitl-overrides.json` to enforce a policy
  posture (e.g. "no writes without manual approval") without forking
  any tool.
- Subagent orchestration tools (`spawn_agent`, …) no longer escalate to
  `always-confirm` from the secure-by-default fallback.
- `exec_command` / `bash` invocations are tier-classified centrally; the
  pattern table is the SSOT for "what's a hand-off-class command".
- The composition is a one-way ratchet — a host CANNOT relax a tool's
  own declared tier through the override file. This is intentional.

## References

- `src/agent/hitl-tier.ts` — `HitlTier` re-export + `ToolHitlAnnotation`
  data shape.
- `src/agent/hitl-tier-registry.ts` — `getToolHitlTier(name, args)` resolver,
  command-pattern table, user-override loader, `__resetHitlOverrides`
  test seam.
- `src/agent/admissibility-gate.ts#resolveHitlAnnotation` — composition
  rule (one-way ratchet).
- `tests/unit/hitl-tier-registry.test.ts`,
  `tests/unit/hitl-tier-gate.test.ts`,
  `tests/integration/hitl-tier-dispatch-e2e.test.ts`.
- ADR-0020 — HITL 4-tier gate (enum + initial gate wiring).
- ADR-0026 — Admissibility-gate SSOT (canonical pre-execute order).
- ADR-0029 — Reviewer 3-tier (orthogonal axis).
- `codex-desktop-build-2867-round-4` — review notes that motivated the
  registry + per-command pattern surface.
