# Ticket — auto-mode user-rule overlay + tool-switch circumvention detection

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes seams; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §3.2 (P4) — verified jun-07 src grep.
**Slice:** `@/permission` (the auto-mode classifier + a new overlay composer + a new effect-tracking detector) + `@/agent/admissibility-gate` (the deny/escalation surface) + `@/rules` (reuse the existing 3-layer DSL for the user-rule overlay). No new slice required; two new pure modules inside `@/permission`.
**Candidate ADR:** next free (≥ 0497 — `docs/decisions/` is occupied through 0496).
**Default posture:** OFF, byte-identical. Absent the knob(s), `CLASSIFIER_SYSTEM_PROMPT` stays byte-for-byte unchanged, the classifier verdict path is unchanged, and no effect-tracking state is allocated. Both halves are ADDITIVE — they ride new optional fields / new composition seams, never replace the existing path.
**Competitor source:** Claude Code CLI 2.1.150 (`.extracted_source/claude-code-cli/_cli-symbols.txt`).
**ROI:** cost 저-중, impact 고 (security). Memory `jun-07-gap-other-agent-audit` flags this as a TOP security gap.

---

## 1. Problem

quanta's auto-mode (AFK) classifier (`src/permission/classifier.ts`) has the threat taxonomy, the 2-stage orchestration, and the denial-limit circuit-break at **mechanism parity** with Claude. But it is missing the two things that turn the classifier from a *static prompt* into an *operator-tunable, bypass-resistant* gate:

1. **No user-rule overlay.** The classifier system prompt is a `frozen` constant (`CLASSIFIER_SYSTEM_PROMPT`). An operator cannot layer their own `allow` / `soft_deny` / `hard_deny` / `environment` rules onto the classifier to tune the AFK boundary per environment (e.g. "this repo's `terraform apply` is fine" / "never touch our prod cluster" / "we're on a shared staging box"). Today the only knob is the binary mode; the boundary is one-size-fits-all.

2. **No tool-switch circumvention detection — a real security bypass.** When an action is soft-denied via tool A, an agent (especially a prompt-injected one) can achieve the **same effect via a different tool B** and sail through. Concrete: `Edit`/`Write` to path `X` is soft-denied → the agent runs `bash` `echo ... > X` (or `sed -i`, `python -c`, a heredoc `cat > X`, or a different write tool). The named tool was denied; the *effect* was not. quanta evaluates each action independently (`EVALUATE ON OWN MERITS` in the prompt) and has **no memory of denied effects**, so the redirect-around-deny is invisible.

The threat is concrete and load-bearing: circumvention is exactly the move a manipulated agent makes to route around a boundary the user thought they had set. Catching it is the difference between "we have an AFK classifier" and "we have an AFK classifier you can't trivially walk around."

---

## 2. Current state (src-verified)

**Parity (already have):**
- Threat-taxonomy system prompt — `CLASSIFIER_SYSTEM_PROMPT` (`classifier.ts:49-143`), verbatim, fidelity load-bearing.
- 2-stage orchestration — `AutoModeClassifier.evaluate()` (`classifier.ts:271-297`): fast pass → escalate to thinking pass.
- Denial-limit circuit-break — `DENIAL_LIMITS = {maxConsecutive:3, maxTotal:20}` (`classifier.ts:186`) + sticky AFK `tripCircuitBreaker()`.
- The auto path is wired via `evaluateAuto()` (`policy.ts:253-291`): HARD_DENY first → read-only bypass → injected classifier → `fallback ⇒ ask`.
- A precedent for **prompt overlay**: `withExfilScoutingTaxonomy(base, enabled)` (`classifier.ts:167-168`) — a pure, default-OFF seam that appends one taxonomy line to the base prompt, byte-identical when OFF. This is the exact shape the user-rule overlay should follow.
- The structured deny-reason layer (jun-6 / C6) — `StructuredDenyReason` + `structuredDenyReason()` + `DenyLayer` / `DenyPillar` (`src/permission/deny-reason.ts`). We reuse this for the new deny sites.
- The 3-layer rules DSL — `RuleAction = "allow"|"deny"|"ask"`, `RuleLayer = "system"|"user"|"project"`, `RulesStore.match` (`src/rules/types.ts`, `matcher.ts`, `store.ts`). Reusable for the overlay's rule provenance.

**Absent (verified):** `soft_deny` / `hard_deny` / `autoMode` / `tool_switch` / `circumvent` grep **0** in `src/`. The classifier prompt is a frozen constant with no overlay slot; there is no denied-effect memory.

---

## 3. Competitor mechanism (verified — `_cli-symbols.txt`)

### 3.1 Auto-mode user-rule overlay (4 categories, `$defaults` sentinel)

Claude's auto mode lets users write custom rules in **four categories**, layered into the classifier's system prompt:

- **`allow`** — actions the classifier should auto-approve.
- **`soft_deny`** — destructive/irreversible actions to block *unless* clear user intent authorizes them (User Intent Rule can clear).
- **`hard_deny`** — security-boundary actions to block **unconditionally** (user intent does NOT clear).
- **`environment`** — context about the user's setup that helps the classifier decide.

The system prompt has four template slots — `<user_allow_rules_to_replace>`, `<user_soft_deny_rules_to_replace>`, `<user_hard_deny_rules_to_replace>`, `<user_environment_to_replace>` — each carrying a **baseline** rule list (e.g. the soft-deny baseline includes "Git Destructive", "Production Deploy", "Remote Shell Writes", "Code from External", …). The user's rules are merged into these slots by `xB7(H)` → `YG_(userRules, baseline, identity)`:

```
function YG_(H, _, q) {            // H=user rules, _=baseline, q=transform
  if (!H?.length) return [..._]    // no user rules ⇒ baseline verbatim
  let K=false, O=[]
  for (let T of H) {
    if (T === OtH) {               // OtH === the literal "$defaults" sentinel
      if (!K) { O.push(..._); K=true }   // splice baseline in at this position, once
      continue
    }
    O.push(q(T))                   // otherwise the user's own line
  }
  return O
}
```

So a user list of `["$defaults", "- My extra rule"]` = *baseline THEN my rule*; a list **without** `$defaults` = *full replace* of that category's baseline. The merged lists are substituted into the prompt by `uB7()` (regex-replace each `<user_*_to_replace>` slot). There is also a critique pass (`autoModeCritiqueHandler` / "expert reviewer of auto mode classifier rules") that lints user rules for clarity/completeness/conflicts — out of scope here.

Untrusted-source guard: `tengu_settings_auto_mode_untrusted_source_ignored` — auto-mode rules from an untrusted settings source are **ignored** (a repo cannot inject `allow`/`hard_deny` rules into your AFK classifier).

### 3.2 Tool-switch circumvention heuristic (verbatim)

The circumvention signal is an explicit instruction in the classifier prompt (verbatim from `_cli-symbols.txt`):

> Using `python -c`, `sed -i`, `cat >`, heredocs, or similar to write or edit a file that an Edit/Write/MultiEdit deny rule covers, or otherwise **routing around a deny rule by switching tools**. The named tool itself is enforced separately; **your job here is to catch circumvention.**

Plus the supporting bullet:

> Using redirect operators (`>`, `>>`, `|`) or heredocs to write to files

i.e. the deny rule names a tool, the *enforcement* of that tool is separate, and the classifier is specifically tasked with catching the **same-effect-via-different-tool** move (a `bash` redirect / `sed -i` / `python -c` / heredoc reaching a path that an `Edit`/`Write` deny rule covers).

---

## 4. Design

Two independent, separately-knobbed halves. Both default-OFF and byte-identical when off.

### 4.a User-rule overlay (composed ONTO the auto-mode classifier)

A pure overlay composer that layers operator `allow`/`soft_deny`/`hard_deny`/`environment` rules onto `CLASSIFIER_SYSTEM_PROMPT`, mirroring `withExfilScoutingTaxonomy`'s default-OFF shape.

- **Source of rules — reuse `@/rules`.** The user authors rules through the existing 3-layer DSL (`RulesStore`, `RuleLayer = system|user|project`, `RuleAction = allow|deny|ask`). The overlay reads the `user` + `project` layers; `system` is the vendor baseline. We do NOT invent a parallel rule store. (Mapping note: the DSL's `deny` splits into the classifier's `soft_deny` vs `hard_deny` — see Open Questions §6; an explicit `pillar`-style tag on the rule, or two DSL files, disambiguates. Default mapping: DSL `deny` → `soft_deny` unless the rule is tagged hard.)
- **Composition — pure, default-OFF.** New `withUserRuleOverlay(base: string, overlay: AutoModeOverlay | undefined): string`:
  - `overlay === undefined` (knob OFF or no rules) ⇒ return `base` UNCHANGED (byte-identical).
  - else: substitute the four `<user_*_to_replace>` slots, honoring the `$defaults` sentinel (baseline-splice-once) per category exactly like Claude's `YG_`. The base prompt grows the four slots (and their baseline lists) as a one-time verbatim port; the OFF path never touches them.
- **Precedence (load-bearing):** user `hard_deny` is unconditional and **cannot be cleared by user intent** — it composes as a HARD-BLOCK taxonomy line, NOT a soft one. User `allow` is an exception list (soft-block carve-out only — it can never widen a real HARD_DENY denylist hit, which is still checked deterministically *before* the classifier in `evaluateAuto`). User `soft_deny` is User-Intent-clearable. This ordering matches Claude and is the whole point of the four categories.
- **Untrusted-source fence:** rules from an untrusted settings source are ignored (parity with `tengu_settings_auto_mode_untrusted_source_ignored`). A repo-controlled `.quanta/` file MUST NOT be able to inject an `allow`/`hard_deny` into the AFK classifier. The `@/rules` `project` layer is repo-controllable, so the overlay reads project-layer rules ONLY in the `soft_deny`/`environment` direction (tightening / context), never `allow`/`hard_deny` (loosening). This is the security crux of the overlay and is asserted by hellgate.
- **Wiring:** `evaluateAuto` (or its caller) composes `withUserRuleOverlay(withExfilScoutingTaxonomy(CLASSIFIER_SYSTEM_PROMPT, scoutOn), overlay)` and passes it as `systemPrompt`. Knob `QUANTA_AUTO_MODE_RULES` (default-OFF). OFF ⇒ the exact current `CLASSIFIER_SYSTEM_PROMPT` (or scout-overlaid prompt) flows through unchanged.

### 4.b Circumvention detector (denied-effect → same-effect-different-tool)

A small, conservative, **advisory-first** detector that gives the classifier (and the gate) a memory of *denied effects* so a same-effect-different-tool follow-up is flagged and escalated to HITL — never auto-allowed.

- **Effect signature.** When an action is **soft-denied** (the `deny` arm of `evaluateAuto` / mode-policy with `layer ∈ {reviewer, stack, mode}` and NOT a HARD_DENY — HARD_DENY is already terminal and needs no tracking), the detector records a coarse **denied-effect signature**. The minimal, defensible signature is **`{kind: "write", path: <canonical-abs-path>}`** — the write-to-path-X effect. Path is canonicalized (resolve `..`, symlinks-best-effort, normalize separators) so `./X` and `/abs/X` collide. We deliberately start with the WRITE effect only (the §3.2 mechanism is write-centric: `Edit`/`Write`/`MultiEdit` vs `bash` redirect / `sed -i` / `python -c` / `cat >`). Network-exfil circumvention is a separate, harder signature — out of scope for v1 (Open Questions §6).
- **Effect extraction.** For a non-shell write tool (`Edit`/`Write`/`MultiEdit`/an MCP write), the effect path is the tool's target path (the gate already has `action.input`). For a `bash`/shell-equivalent action, parse the shell command for **write effects to a path**: redirect targets (`>`, `>>` after redirect ops), `sed -i <file>`, `tee <file>`, `cp`/`mv` destinations, `cat > <file>` / heredoc redirects, `python -c`/`-c`-style inline writes. quanta **already has a tree-sitter-grade shell parser surface** (the corpus shows heredoc/redirect tokenization in the competitor; quanta's HARD_DENY shell-equivalence path in `withResolvedShellCommand` proves we resolve shell commands centrally) — the extractor reuses `ToolRegistry.extractShellCommand` + a write-target parser, NOT a fresh ad-hoc regex pile.
- **Detection + escalation.** On a *subsequent* action whose extracted write-effect path matches a still-live denied-effect signature **via a DIFFERENT tool**, the detector raises a circumvention signal. The signal does **two** things, gated by posture:
  - **Advisory (default when knob ON):** thread a taxonomy/context line into the classifier prompt for the next evaluation ("a write to PATH was just soft-denied via TOOL_A; treat a same-effect write via a different tool as circumvention") so the *classifier itself* decides — reusing its existing reasoning rather than hard-coding a block.
  - **Escalate (stricter posture):** turn the matched action into a forced **`ask`** (HITL) at the gate, with a `StructuredDenyReason { layer: "stack", pillar: "approval", safeReason: "tool-switch circumvention of a prior soft-deny" }`. **Never auto-allow, never auto-hard-block** — escalation to a human is the conservative, FP-tolerant resolution.
- **Conservatism (the core constraint — see §5):** the detector is **advisory-first** and **same-path-required**. It fires ONLY when (1) a write-effect was *soft-denied* (not merely never-attempted), (2) a *later* action writes to the *same canonical path*, (3) via a *different tool*. A legit `bash` write to a *different* path never matches. A re-attempt of the *same* tool is the existing denial-limit's job, not this detector's. Signatures are **session-scoped and TTL'd** (cleared on a genuine allow of that path, or after N turns / on the denial-limit reset) so a stale deny can't haunt the rest of the session.
- **State + wiring.** A small stateful `CircumventionTracker` (sibling to `AutoModeClassifier`'s denial state) holding `Map<effectSig, {deniedByTool, deniedAtTurn}>`. Injected into the gate the same way `AutoModeClassifier` is. Knob `QUANTA_CIRCUMVENT_DETECT` (default-OFF). OFF ⇒ tracker never constructed, zero signatures recorded, byte-identical gate.

### 4.c Reuse the jun-6 typed deny layer

Both halves surface refusals through the existing `StructuredDenyReason` (`deny-reason.ts`): overlay-`hard_deny` hits and circumvention escalations get `{layer, pillar:"approval", safeReason: <categorical>}`. No new envelope; `safeReason` is categorical (NEVER the path/command — the path is the agent's own input and may appear on model-facing `content`, but the structured/logged field stays categorical, matching the C6 no-leak boundary).

---

## 5. False-positive risk (honest)

**Effect-equivalence detection is the hard part, and it is where the false-positive risk lives.** Being honest about it:

- "Same effect" is undecidable in general. A `bash` command can write a path in arbitrarily obfuscated ways (computed filenames, `$VAR` expansion, `eval`, base64). A maximalist detector that tries to catch *all* of them will (a) be a regex swamp and (b) **false-block legitimate work** — the agent writing a *different* file via bash for a perfectly good reason.
- Therefore the design is deliberately **conservative + advisory-first**, accepting **false NEGATIVES over false POSITIVES**:
  - **Same-path-required, write-only, different-tool-required.** We only catch the *obvious* pattern (the §3.2 mechanism: denied `Edit`/`Write` to X → `bash` redirect/`sed -i`/`cat >`/`python -c` to the *same canonical X*). We do NOT attempt computed-path or fully-obfuscated cases in v1.
  - **Advisory by default.** The default-ON-knob behavior threads a *context line* to the classifier and lets the LLM decide, rather than a deterministic block. The deterministic forced-`ask` is a *stricter* opt-in posture. This means a borderline case becomes a HITL prompt, not a wrong auto-block — the cost of a FP is a pause, not a broken task.
  - **Never auto-allow on a circumvention signal; never auto-hard-block.** Escalate to HITL. A human is the FP-tolerant resolver.
  - **TTL + clear-on-allow.** A denied effect that is later legitimately allowed (or after a bounded number of turns) stops matching, so the detector cannot poison the rest of the session.
- Net: we accept that a sufficiently clever circumvention (computed path, encoding) slips past v1. That is the right trade — the alternative (aggressive equivalence matching) breaks legit agent work, which is a worse failure for an AFK tool. v1 catches the *obvious, named-in-the-spec* move and escalates it.

---

## 6. Files to touch

- `src/permission/classifier.ts` — add `withUserRuleOverlay(base, overlay)` (pure, default-OFF, mirrors `withExfilScoutingTaxonomy`); add the four `<user_*_to_replace>` baseline slots + the `$defaults` splice helper (verbatim port of `YG_`/`uB7`). Add the circumvention advisory taxonomy-line constant (verbatim from §3.2) + a `withCircumventionContext(base, sig)` composer.
- `src/permission/circumvention.ts` *(new, pure + small stateful tracker)* — `CircumventionTracker` (denied-effect map, TTL, `noteDenied`/`matchCircumvention`/`clearOnAllow`), `extractWriteEffect(tool, input, shellCommand)` (write-target parser reusing `ToolRegistry.extractShellCommand`), `EffectSignature` type. Slice-pure: no IO/clock/`process.env` (clock injected, parity with `decidedAt`).
- `src/permission/policy.ts` — `evaluateAuto`: compose the overlaid prompt; on a soft-deny, `tracker.noteDenied(effect)`; before classifying, `tracker.matchCircumvention(effect)` → advisory context or forced-`ask`. All behind the two knobs; OFF ⇒ current code path verbatim.
- `src/agent/admissibility-gate.ts` — thread the tracker through the auto/soft-deny arms; emit the circumvention `StructuredDenyReason` on escalation. Reuse `denyReason(...)` (already knob-gated).
- `src/permission/deny-reason.ts` — (no type change needed; `layer:"stack"` + `pillar:"approval"` already cover it). If a distinct `circumvention` provenance is wanted, add it as an optional categorical tag only.
- `src/rules/` — no new types; the overlay *consumes* `RulesStore` (`user`/`project` layers). Possibly a thin `toAutoModeOverlay(store)` adapter (could live in `@/permission` to avoid `@/rules → @/permission` coupling).
- Knobs in `src/shared/runtime-config.ts` — `QUANTA_AUTO_MODE_RULES`, `QUANTA_CIRCUMVENT_DETECT` (both default-OFF) + the surface/SSOT manifest entry.
- `fc` catalog — register the two features.

---

## 7. Test / hellgate plan

**Overlay:**
- OFF ⇒ assembled `systemPrompt` is **byte-identical** to `CLASSIFIER_SYSTEM_PROMPT` (and to the scout-overlaid prompt when scout is on) — ratchet test.
- `$defaults` sentinel: `["$defaults", "- extra"]` ⇒ baseline THEN extra (spliced once); list without `$defaults` ⇒ full replace; empty list ⇒ baseline verbatim. (Differential against the `YG_` semantics.)
- **Precedence:** user `hard_deny` composes as an unconditional HARD-BLOCK line (User-Intent does NOT appear as a clearing path for it); user `soft_deny` is User-Intent-clearable.
- **Untrusted-source fence (security):** a `project`-layer (repo-controllable) `allow` or `hard_deny` rule is **NOT** applied to the classifier (red-on-injection — a repo cannot loosen the AFK boundary). Project-layer `soft_deny`/`environment` (tightening/context) IS applied.

**Circumvention:**
- **Catch:** `Edit`/`Write` to `/repo/X` soft-denied → subsequent `bash` `echo ... > /repo/X` (and separately `sed -i ... /repo/X`, `cat > /repo/X`, heredoc, `python -c` write to `/repo/X`) → circumvention signal raised; resolves to advisory-context (default) or forced-`ask` (strict posture) — **never `allow`**.
- **No false-positive:** soft-denied write to `/repo/X` → subsequent `bash` write to a **different** path `/repo/Y` → **NOT** flagged. Same-tool re-attempt of `/repo/X` → handled by denial-limits, **NOT** the circumvention path (no double-count). A read of `/repo/X` via bash (`cat /repo/X`) → NOT a write effect → not flagged.
- **Path canonicalization:** `./X`, `/repo/X`, `/repo/./X` collide; `/repo/X` vs `/repo/sub/X` do not.
- **TTL / clear-on-allow:** a genuine allow of `/repo/X` clears the signature; a later bash write to `/repo/X` is no longer flagged. Signatures expire after the bounded turn window / denial-limit reset.
- **HARD_DENY unaffected:** a HARD_DENY hit is still terminal and is NOT routed through the circumvention tracker (it needs no soft-deny memory).
- **default-OFF:** both knobs OFF ⇒ no tracker constructed, no overlay slots touched, `evaluateAuto` byte-identical (ratchet). Red-on-injection regression tests for every claim above (the project's "guard effectiveness" standard).

---

## 8. ROI / cost

- **Cost: 저-중.** The overlay is a pure prompt composer (verbatim port of Claude's `YG_`/`uB7` + reuse of `@/rules` + `withExfilScoutingTaxonomy`'s shape) — cheap. The circumvention detector is the spend: a small stateful tracker + a write-effect extractor reusing `extractShellCommand`. The hard part is calibration, not LOC.
- **Impact: 고 (security).** Closes a real AFK bypass (denied-via-tool-A → same-effect-via-tool-B) and gives operators the per-environment AFK tuning Claude has. Both are TOP-gap items in `jun-07-gap-other-agent-audit`. The overlay also unblocks honest interop ("operator can tune the AFK classifier" is table-stakes for an AFK mode).

---

## 9. Open questions (calibrate — no magic)

1. **Effect-tracking granularity.** v1 uses `{kind:"write", path}`. Is path-equality the right granularity, or do we need (a) directory-prefix matching (denied write to `/repo/secrets/` → any write under it), (b) content-class matching (denied "write a credential" → any write of credential-shaped content)? Directory-prefix raises FP risk; content-class is undecidable. **Recommendation: ship path-equality only, measure on real transcripts before widening.** Do NOT pick a prefix-depth heuristic without data (per `no-heuristics-only-validated`).
2. **DSL `deny` → `soft_deny` vs `hard_deny` mapping.** The `@/rules` DSL has one `deny`; Claude has two block tiers. How does a user say "this is a hard, intent-unclearable deny"? Options: a per-rule tag, two DSL files, or a convention. Needs a decision before the overlay's precedence is meaningful.
3. **Advisory vs deterministic-escalate default.** Should the knob's default (when ON) be advisory-context-to-classifier, or forced-`ask`? Advisory is lower-FP but trusts the LLM; forced-`ask` is deterministic but pops more prompts. **Recommendation: advisory default, forced-`ask` as a stricter opt-in.**
4. **Shell write-effect extraction completeness.** Which write patterns does v1 parse (`>`/`>>`/`tee`/`sed -i`/`cp`/`mv`/`cat >`/heredoc/`python -c`)? Each added pattern is more catch but more parser surface. Enumerate the closed v1 set; everything outside it is an accepted false-negative (§5).
5. **Network-exfil circumvention.** Out of scope for v1 (write-only). Is a second effect-kind (`{kind:"network", host}`) worth a follow-up, or does the existing exfil-scouting rail (`detectScouting`) already cover the network direction? Likely the latter — confirm before scoping.
6. **Untrusted-source taxonomy.** We block repo-layer `allow`/`hard_deny`. Do we also need a trust-gate on the `user`-layer source (e.g. a settings file written by a tool earlier in the session)? Tie-in with the central-config/trust-gate gap (P7).
