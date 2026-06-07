# ADR-0502: auto-mode user-rule overlay + tool-switch circumvention detection

- **상태**: Accepted
- **날짜**: 2026-06-07
- **슬라이스**: `@/permission` (auto-mode classifier overlay composer + a new effect-tracking detector; reuses `@/rules` 3-layer DSL) — no new slice
- **티켓**: `docs/tickets/misc-jun-7/04-auto-mode-rule-overlay-circumvention.md`
- **게이트**: `QUANTA_AUTO_MODE_RULES` + `QUANTA_CIRCUMVENT_DETECT` (둘 다 `gateOnStrict`, default-OFF, 독립)
- **관련**:
  - `src/permission/classifier.ts` (`withUserRuleOverlay`, the four `<user_*_to_replace>` baseline slots, the `$defaults` splice helper, `AUTO_MODE_DEFAULTS_SENTINEL`, `AutoModeOverlay`, the circumvention advisory taxonomy line)
  - `src/permission/circumvention.ts` (new: `CircumventionTracker`, `EffectSignature`, `extractWriteEffect(s)`, `extractShellWritePaths`, `canonicalizeEffectPath`, `buildAutoModeOverlay`, `CIRCUMVENTION_TTL_TURNS`)
  - `src/permission/policy.ts` (`evaluateAuto`: compose overlaid prompt; `noteDenied` / `matchCircumvention` on the soft-deny arm)
  - Reuses jun-6 `StructuredDenyReason` (`deny-reason.ts`) + `@/rules` DSL
  - Absorbs: Claude Code CLI 2.1.150 (`_cli-symbols.txt`: `YG_`/`uB7` overlay merge, the circumvention taxonomy line, `tengu_settings_auto_mode_untrusted_source_ignored`)

## Context

quanta's auto-mode (AFK) classifier (`classifier.ts`) had the threat taxonomy, the 2-stage orchestration,
and the denial-limit circuit-break at mechanism parity with Claude — but two things were missing that turn
the classifier from a *static prompt* into an *operator-tunable, bypass-resistant* gate
(verified jun-07: `soft_deny`/`hard_deny`/`tool_switch`/`circumvent` grep 0 in `src/`):

1. **No user-rule overlay.** `CLASSIFIER_SYSTEM_PROMPT` was a frozen constant — an operator could not layer
   their own `allow`/`soft_deny`/`hard_deny`/`environment` rules to tune the AFK boundary per environment.
2. **No tool-switch circumvention detection — a real security bypass.** When an action is soft-denied via
   tool A, an agent (especially a prompt-injected one) can achieve the *same effect via a different tool B*
   (a soft-denied `Edit`/`Write` to path X → a `bash` `echo … > X` / `sed -i` / `cat >` / heredoc /
   `python -c` to the same X) and sail through. quanta evaluated each action on its own merits with no
   memory of denied effects, so the redirect-around-deny was invisible.

## Decision

Two independent, separately-knobbed, default-OFF, byte-identical-when-off halves.

### A. User-rule overlay (`withUserRuleOverlay`, pure)

Mirrors the existing default-OFF `withExfilScoutingTaxonomy` shape. `overlay === undefined` (knob OFF or no
rules) ⇒ return `CLASSIFIER_SYSTEM_PROMPT` **byte-identical**. Else substitute the four
`<user_*_to_replace>` slots, honoring the `$defaults` sentinel (`AUTO_MODE_DEFAULTS_SENTINEL`) — a verbatim
port of Claude's `YG_`/`uB7`: a user list `["$defaults", "- extra"]` = baseline THEN extra (spliced once);
a list *without* `$defaults` = full replace of that category's baseline; an empty list = baseline verbatim.

- **Rule source — reuse `@/rules`, do not invent a store.** `buildAutoModeOverlay` adapts the existing
  3-layer DSL (`RulesStore`, `RuleLayer = system|user|project`) into an `AutoModeOverlay`.
- **Precedence (load-bearing):** user `hard_deny` is unconditional (NOT User-Intent-clearable) and composes
  as a HARD-BLOCK line; user `soft_deny` is User-Intent-clearable; user `allow` is a soft-block carve-out
  only and can NEVER widen a real HARD_DENY denylist hit (still checked deterministically before the
  classifier in `evaluateAuto`).
- **Untrusted-source fence (security crux):** rules from a repo-controllable (`project`) source are read
  ONLY in the tightening/context direction (`soft_deny`/`environment`), NEVER `allow`/`hard_deny`
  (loosening). A repo cannot inject an `allow`/`hard_deny` into your AFK classifier — parity with
  `tengu_settings_auto_mode_untrusted_source_ignored`, asserted red-on-injection.

### B. Circumvention detector (`CircumventionTracker`, advisory-first)

A small, conservative, session-scoped tracker giving the classifier (and gate) a memory of *denied effects*
so a same-effect-different-tool follow-up is flagged and escalated to HITL — **never auto-allowed**.

- **Effect signature.** On a **soft-deny** (NOT a HARD_DENY — already terminal), record a coarse
  `EffectSignature { kind:"write", path: <canonical-abs> }`. Path is canonicalized
  (`canonicalizeEffectPath`: resolve `..`, normalize) so `./X`, `/repo/X`, `/repo/./X` collide while
  `/repo/X` vs `/repo/sub/X` do not. Write-effect only in v1 (the §3.2 mechanism is write-centric).
- **Effect extraction.** For a non-shell write tool, the target path; for a shell action,
  `extractShellWritePaths` parses redirect targets (`>`/`>>`), `sed -i`, `tee`, `cp`/`mv` destinations,
  `cat >`/heredoc, `python -c`-style inline writes — reusing the central shell-resolution surface, not a
  fresh regex pile.
- **Detection + escalation.** On a *later* action whose extracted write path matches a still-live denied
  signature **via a DIFFERENT tool**, raise a `CircumventionSignal`. Default (knob ON): **advisory** — thread
  a taxonomy/context line into the classifier for the next evaluation and let the LLM decide. Stricter
  posture: forced **`ask`** (HITL) at the gate with `StructuredDenyReason { layer:"stack",
  pillar:"approval", safeReason:"tool-switch circumvention of a prior soft-deny" }` (categorical, never the
  path/command — C6 no-leak boundary). NEVER auto-allow, NEVER auto-hard-block.
- **Conservatism + TTL.** Fires ONLY on (1) a *soft-denied* write, (2) a *later* write to the *same*
  canonical path, (3) via a *different* tool. A bash write to a different path, a same-tool re-attempt
  (that is the denial-limit's job), or a bash read all do NOT match. Signatures are TTL'd
  (`CIRCUMVENTION_TTL_TURNS = DENIAL_LIMITS.maxTotal`) and cleared on a genuine allow of that path, so a
  stale deny cannot haunt the session.

## Default posture

OFF, byte-identical. Both knobs `gateOnStrict` (`=== "1"`). `QUANTA_AUTO_MODE_RULES` unset ⇒
`withUserRuleOverlay(base, undefined)` ⇒ `CLASSIFIER_SYSTEM_PROMPT` byte-for-byte (and the scout-overlaid
prompt unchanged when scout is on). `QUANTA_CIRCUMVENT_DETECT` unset ⇒ the tracker is never constructed,
zero signatures recorded, `evaluateAuto` byte-identical. Both halves are ADDITIVE — they ride new optional
fields / new composition seams and never replace the existing path.

## False-positive posture (honest)

"Same effect" is undecidable in general; an aggressive equivalence matcher would be a regex swamp and would
false-block legitimate work. The design therefore accepts **false NEGATIVES over false POSITIVES**:
same-path-required, write-only, different-tool-required, advisory-by-default, escalate-to-HITL-never-block.
A sufficiently clever circumvention (computed path, `$VAR`/`eval`/base64 obfuscation) slips past v1 — the
right trade, since the alternative breaks legit agent work. No granularity/prefix heuristic is picked
without data (`no-heuristics-only-validated`); widening (directory-prefix, network-exfil signature, the
`deny → soft/hard` DSL tagging) is a measured follow-up.

## Consequences

- Closes a real AFK bypass (denied-via-A → same-effect-via-B) — a TOP security gap in
  `jun-07-gap-other-agent-audit` — and gives operators the per-environment AFK tuning Claude has.
- The overlay also unblocks honest interop ("operator can tune the AFK classifier" is table-stakes for an
  AFK mode).
- Residual: the untrusted-source fence is path/source-level, not content-level — a once-trusted user-layer
  settings file later mutated still applies (same residual as the central-config trust gate, ADR-0498).
  Network-exfil circumvention and the auto-mode critique/lint pass are out of scope for v1.
