# RFC — C6: deny-reason surfacing (structured "why was this denied" to model + user)

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/permission` (the decision producers + a new structured reason record) + `@/agent/admissibility-gate` (the deny surface) + the `ToolFailure.permission_denied` envelope. No new slice.
**Candidate ADR:** 0487 (next free after 0486; if C5 lands first, 0488).
**Default posture:** OFF, byte-identical. Absent the knob, the model-facing deny `content` string and the `failure` envelope are byte-for-byte unchanged. The structured reason is ADDITIVE — it rides a new optional field, never replaces the existing prose.
**ROI:** LOW for end-user value, **HIGH for debugging UX**. When a tool is denied, the model today gets `"Permission denied: <prose>"` — sometimes rich (per-thread sandbox type + workdir), sometimes a bare `"denied"`. The model cannot reliably reason about *which policy layer* and *which pillar* refused it, so it cannot self-correct ("ah, network is off by policy — I'll stop trying web_fetch"). C6 threads a structured `{layer, pillar, verdict, why}` reason into the denial surface so the model self-corrects and a human debugging a deny can see the provenance — WITHOUT leaking sensitive policy internals (the regex source, the raw command, env values).

---

## 1. 요약 (Summary)

C6 surfaces the **structured reason** a permission denial occurred — not just
"denied," but *which layer of the policy stack* refused it, *which security
pillar* (filesystem / network / sandbox / control / approval), and a short
human-safe *why* — to BOTH the model (as enriched tool-result content + a typed
failure field) and the user (debug log / status surface).

The crux up front (and the honest finding): quanta is **already most of the way
there on the model-facing side** — the deny `content` often carries a useful
prose reason (`"Per-thread policy (workspace-write) refuses bash on /repo"`,
`policy.ts:397-398`). What is MISSING is **structure**: the reason is a free-form
string the model must parse, the `ToolFailure.permission_denied` envelope carries
only `{mode, isReadonly}` (`admissibility-gate.ts:774`) with NO layer/pillar tag,
and the bare-"denied" cases (`"Permission denied: <tool> requires explicit
confirmation … no confirm handler is wired"`, `admissibility-gate.ts:792`) give
the model nothing actionable.

The design:

- A new **`StructuredDenyReason`** value record produced alongside the existing
  prose at each deny site: `{ layer, pillar?, stackSource?, verdict:"deny",
  safeReason }`. `layer` = which subsystem refused (`hard-deny | stack |
  reviewer | hook | tool-profile | mode`); `pillar` = the 4-pillar axis
  (`fileSystem | network | sandbox | control | approval`) when derivable;
  `safeReason` = the SAME sanitized one-liner already emitted to the recorder
  (which is contractually scrubbed of regex sources + command text,
  `policy.ts:84-98`, `recorder.ts:98-125`).
- It rides the existing **`ToolFailure.permission_denied`** envelope as a new
  optional field (`admissibility-gate.ts:769-775`), and is folded into the deny
  `content` as a one-line `[layer/pillar]` prefix — both gated by a knob, so the
  default path is byte-identical.
- A hard **no-leak boundary**: the structured reason reuses the SAME sanitization
  contract the OTel/recorder path already enforces (NEVER the HARD_DENY regex
  source, NEVER raw `action.input`, NEVER the matched command — `policy.ts:95-98`
  is explicit: "A dashboard sees 'HARD_DENY hit on tool=bash' — never 'rm -rf /'").
  C6 surfaces the SAME categorical fields that are already deemed safe to log; it
  does not widen what is exposed.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

### 2.1 Codex — typed permission decision + sandbox-policy provenance

From the Codex corpus (`codex-seatbelt-sandbox-profile`, `codex-collaboration-mode-pattern`,
`codex-otel-attribute-vocabulary`): Codex's denial carries the **profile name**
(`read-only` / `workspace-write` / `danger-full-access`) and the **mode** that
refused (Plan mode "dispatch-seam mutating blocked"). Its OTel vocabulary has a
`codex.*` permission-decision span with the deciding layer as a categorical
attribute. The cue: **the deciding LAYER + PROFILE are first-class, structured,
loggable fields** — exactly the structure C6 adds (quanta already mirrors Codex's
attribute vocabulary in `recorder.ts`, see §3.3).

### 2.2 Claude Code — permission "reason" surfaced to the model

From the Claude corpus (`claude-desktop-tier0-absorption-r2`, the permission
two-layer model): Claude surfaces a permission denial to the model with a reason
the model can act on (the "which rule blocked this" feedback that lets the agent
stop retrying a structurally-blocked action). The takeaway: a denial without a
*machine-classifiable* reason makes the model retry-thrash; a typed reason lets it
pivot.

### 2.3 Synthesis (what we absorb)

| Concept | Codex | Claude | quanta C6 |
|---|---|---|---|
| Deny carries WHICH layer | profile + mode | rule id | `layer` enum |
| Deny carries WHICH pillar | sandbox profile axes | permission domain | `pillar` enum (4-pillar) |
| Reason is machine-classifiable | OTel categorical attr | rule feedback | typed `failure` field |
| Sensitive internals hidden | regex/cmd not in attr | — | **reuse existing scrub contract** |

The novel quanta move is **not exposing more** — it is exposing the *already-safe*
categorical fields (which the recorder/OTel path already computes and deems
loggable) to the MODEL and the debug surface, instead of throwing them away after
the OTel emit.

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 The deny `content` already carries SOME reason — but unstructured

- `evaluateStack` denials surface `"Permission denied: ${decision.reason}"`
  where `reason` is the policy's own message, e.g.
  `"Per-thread policy (workspace-write) refuses bash on /repo"`
  (`policy.ts:397-398`), `"Per-host mode (custom) … fail-closed"`
  (`policy.ts:429-430`), routed via `deny(call.id, "Permission denied: …",
  "denied")` (`admissibility-gate.ts:1083-1091`).
- The `deny()` helper takes `(id, content, preview)`; `content` is model-facing,
  `preview` is a stable trajectory-test tag (`denied`/`declined`/`handoff`/…,
  `dispatch-helpers.ts:43-50`). So a reason DOES reach the model — as prose.

### 3.2 The bare-"denied" cases — model gets nothing actionable

- `"Permission denied: ${call.name} requires explicit confirmation
  (always-confirm tier) but no confirm handler is wired."`
  (`admissibility-gate.ts:790-793`, preview `"denied"`).
- `"Guardian denied: ${decision.rationale}"` (`admissibility-gate.ts:431-446`).
- `"Hook denied: ${result.deny.deny}"` (`admissibility-gate.ts:604`).
- HARD_DENY handoff: `"Action requires human handoff: ${denyReason}"`
  (`admissibility-gate.ts:836-838`) where `denyReason` is
  `"Blocked dangerous command: ${cmd}"` (`policy.ts:66`) — note this one DOES
  echo the command back to the model (it is the agent's own command, so
  acceptable to the model; but it must NOT reach the LOG/OTel path, §3.3).

The model cannot tell `hard-deny` from `stack` from `reviewer` from `hook`
WITHOUT string-matching the prose. It has no structured "this is a NETWORK pillar
deny" signal to pivot on.

### 3.3 The typed failure envelope exists but carries no reason structure

- `ToolFailure.permission_denied` is `{ mode: "permission_denied", isReadonly }`
  (`admissibility-gate.ts:769-775`) — NO layer, NO pillar, NO reason. It is the
  obvious carrier for the structured reason.

### 3.4 The sanitization contract is ALREADY defined (C6 must reuse it verbatim)

- `policy.ts:84-98` (the OTel emit doc) is explicit: emit ONLY categorical fields
  (`outcome`, `reviewerTier`, `riskLevel`, `decidedBy`, `stackSource`,
  `stackVerdict`); **"NEVER pass the matched HARD_DENY regex source through any
  attribute"**, **"The action's `shellCommand`, the matched HARD_DENY rule name,
  and the raw `action.input` are deliberately NOT plumbed through."**
- `recorder.ts:98-125` pins the same contract field-by-field: "every value MUST be
  a categorical primitive or a pre-hashed identifier — NEVER raw args / command
  text / regex sources."
- `emitGateDecision` (`admissibility-gate.ts:255-258`) repeats it: "`reason` is a
  short human-readable one-liner; callers MUST NOT include tool input, file
  contents, or env values. … `metadata` carries … ONLY safe enums."

**Grep verdict:** the SAFE categorical fields (`stackSource`, `decidedBy`,
`riskLevel`, the 4-pillar inference helpers at `policy.ts:454`) already exist and
are already computed at deny time — they are emitted to the recorder and then
DISCARDED. C6 is "stop discarding them; thread them to the model + debug surface,
under the SAME scrub contract." This is why C6 is low-risk: it exposes nothing the
recorder doesn't already expose.

### 3.5 The 4-pillar taxonomy already exists

- `permission-profile.ts:14, 124` — the 4 pillars (sandbox / network / control /
  approval) plus the filesystem-sandbox layer (`permission-profile.ts:2`). The
  `pillar` field of `StructuredDenyReason` draws from this closed set; the
  inference helpers at `policy.ts:454` ("ADR-0135 — 4-pillar inference helpers")
  already map a `(tool, action)` to its governing pillar.

---

## 4. 설계 (Design — closed-port DI)

### 4.1 The `StructuredDenyReason` value record (sanitized by construction)

A new value-only type in `src/permission/types.ts` (sibling to
`PermissionDecision`):

```ts
type DenyLayer =
  | "hard-deny" | "stack" | "reviewer" | "hook" | "tool-profile" | "mode" | "broker"
type DenyPillar =
  | "fileSystem" | "network" | "sandbox" | "control" | "approval"

interface StructuredDenyReason {
  readonly verdict: "deny"
  readonly layer: DenyLayer            // which subsystem refused
  readonly pillar?: DenyPillar         // 4-pillar axis when derivable (omitted else)
  readonly stackSource?: PermissionStackSource  // reuse recorder enum (policy.ts)
  readonly safeReason: string          // the SAME sanitized one-liner the recorder gets
}
```

- `layer` maps 1:1 from the deny SITE (each `deny(...)` call site knows its layer
  — `hard-deny` at `admissibility-gate.ts:836`, `stack` at `:1083`, `reviewer` at
  `:431/446`, `hook` at `:604`, `tool-profile` at `:879`, `broker` at `:1223`).
- `pillar` comes from the existing 4-pillar inference helper (`policy.ts:454`);
  OMITTED (exactOptional) when not derivable (e.g. a bare confirm-handler-missing
  deny has no pillar).
- `stackSource` reuses the recorder's closed enum (`recorder.ts:86-92`,
  `hard-deny | read-only-bypass | per-thread | per-host | global-default | …`).
- `safeReason` is the EXACT string already passed to `emitGateDecision`'s
  `reason` arg — which the contract (`admissibility-gate.ts:255-258`) already
  guarantees is scrubbed. **No new string is composed**; we surface the existing
  sanitized one.

### 4.2 Threading it onto the failure envelope (additive, default-OFF)

Extend `ToolFailure.permission_denied` with an optional field:

```ts
{ mode: "permission_denied", isReadonly, denyReason?: StructuredDenyReason }
```

`denyReason` is set ONLY when the knob is on; absent ⇒ the envelope is
byte-identical to today (`admissibility-gate.ts:774`). The `deny()` helper gains
an optional 4th arg `denyReason?` that, when present, both (a) attaches the
structured field to the result's `failure` envelope and (b) prefixes the
model-facing `content` with a compact tag.

### 4.3 The model-facing content prefix (knob-gated)

When on, the deny `content` is prefixed with a one-line structured tag derived
from `StructuredDenyReason`:

```
[denied · layer=stack · pillar=network] Permission denied: <existing prose>
```

This is purely additive to the existing prose (`content`), so the model gets BOTH
the human sentence AND the machine-classifiable tag. The model can now reason "the
network pillar is off → stop attempting web_fetch" instead of retry-thrashing.
Default-OFF ⇒ no prefix, byte-identical content.

### 4.4 The no-leak boundary (the security crux)

`StructuredDenyReason.safeReason` is NOT a new string — it is a REFERENCE to the
already-sanitized `reason` the recorder receives. The construction site is forced
to pass the SAME value to BOTH `emitGateDecision({reason})` AND
`StructuredDenyReason.safeReason`. A hellgate test (§6) asserts the two are
identical at every deny site, so the structured surface can NEVER carry MORE than
the OTel surface already does. Concretely forbidden, asserted by tests:

- NEVER the HARD_DENY regex source (`policy.ts:95`).
- NEVER `action.input` / file contents / env values (`admissibility-gate.ts:256`).
- NEVER the matched HARD_DENY rule NAME (`policy.ts:97`).
- The HARD_DENY case's `"Blocked dangerous command: ${cmd}"` echoes the AGENT's
  OWN command back to the AGENT (acceptable — it authored it), but `safeReason`
  for the structured/loggable field uses the categorical form
  (`"blocked dangerous command (pattern hit)"`) so the DEBUG LOG never persists
  the raw command. The model still sees its own command in the prose `content`;
  the *structured/logged* `safeReason` is the categorical form. This split is the
  one subtlety and is asserted by hellgate.

### 4.5 What the USER (debug surface) gets

The same `StructuredDenyReason` flows to the debug log / `DecisionEvent`
(`admissibility-gate.ts:278-289` already emits `{kind, outcome, reason, ...}`) —
C6 enriches that event with `{layer, pillar, stackSource}` so a human debugging a
deny sees provenance ("denied by the per-thread STACK layer on the NETWORK
pillar") without grepping prose. This is the HIGH-debugging-value half: a user who
can't figure out why a tool keeps failing gets a structured trail.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

- Config slot `permission.surfaceDenyReason` / env `QUANTA_DENY_REASON`
  (boolean). Default unset ⇒ false ⇒ the structured field is never attached and
  the content prefix is never added (byte-identical). Parsed at the gate-config
  composition site that builds `AdmissibilityGateConfig`.
- **Default-OFF byte-identical**: with the knob off, `deny(...)` ignores the 4th
  arg, `ToolFailure.permission_denied` omits `denyReason`, the `content` string is
  unchanged, and `DecisionEvent` carries only its current fields. The structured
  reason is computed lazily ONLY when the knob is on (zero allocation otherwise).

### 5.2 No new tool

C6 adds NO model-facing tool — it enriches an EXISTING surface (the deny result
the model already receives). It is a failure-envelope + content enrichment, not a
new capability. So there is NO manifest row to add and NO tool-surface drift-guard
interaction.

### 5.3 Feature catalog (fc)

Add a `deny_reason_surfacing` fc node on the permission/observability axis (sibling
to the permission-recorder / OTel-emit nodes) under `tools/feature-catalog/`, and
wire reachability so the lint sees the deny-site → `StructuredDenyReason` →
`failure.denyReason` path. Update `baseline.json`.

### 5.4 Slice / fence

- `StructuredDenyReason` + `DenyLayer`/`DenyPillar` types live in
  `src/permission/types.ts` (value-only, no functions — same posture as
  `ApprovalDecision`, `types.ts:114-130`). The pillar inference reuses the
  existing helper (`policy.ts:454`).
- The deny-site enrichment is in `src/agent/admissibility-gate.ts` (already the
  single owner of every `deny()` call) + the `deny()` helper in
  `src/agent/dispatch-helpers.ts`.
- The `ToolFailure` envelope change is in its declaring module (the
  `permission_denied` variant); a purely-additive optional field, so all existing
  consumers are byte-identical.

---

## 6. 테스트 계획 (Hellgate + e2e)

New `tests/unit/deny-reason-surfacing-hellgate.test.ts`, plus an e2e through the
admissibility gate with a fake registry/policy.

### 6.1 Hellgate (adversarial — the no-leak boundary is the headline)

1. **NO-LEAK: regex source never surfaces.** A HARD_DENY hit (`rm -rf /`):
   assert `StructuredDenyReason.safeReason` and the `DecisionEvent` carry NEITHER
   the matched regex source NOR the rule name; `layer:"hard-deny"`,
   `pillar` omitted-or-categorical. The model-facing `content` MAY echo the
   agent's own command (it authored it) but the LOGGED `safeReason` is the
   categorical form. Assert the structured/logged field !== the raw command.
2. **NO-LEAK: structured == OTel.** At EVERY deny site (stack / reviewer / hook /
   tool-profile / mode / broker), assert `StructuredDenyReason.safeReason` is the
   SAME value passed to `emitGateDecision({reason})` — the structured surface can
   never exceed the already-sanitized OTel surface.
3. **NO-LEAK: no `action.input`.** Deny a `bash` with a secret in args; assert the
   secret appears in NEITHER `safeReason`, `denyReason`, NOR `DecisionEvent`.
4. **Layer correctness.** Each deny site produces the right `layer`:
   per-thread→`stack`, guardian→`reviewer`, hook→`hook`, profile-resolve→
   `tool-profile`, HARD_DENY→`hard-deny`, mode-blocked→`mode`, broker SOFT-deny→
   `broker`.
5. **Pillar correctness.** A network deny → `pillar:"network"`; a filesystem-path
   deny → `pillar:"fileSystem"`; a confirm-handler-missing deny → `pillar` OMITTED
   (exactOptional, not `undefined`-set).
6. **Default-OFF byte-identity.** Knob off: the deny `content` string is
   byte-identical to the pre-feature baseline; `ToolFailure.permission_denied`
   has NO `denyReason` key (assert key absent, not `undefined`); `DecisionEvent`
   carries only its current fields. Snapshot/`toEqual` both branches.
7. **Content prefix shape.** Knob on: `content` starts with
   `[denied · layer=… · pillar=…]` AND still contains the full original prose
   (additive, never replacing).
8. **Bare-deny enrichment.** The confirm-handler-missing case
   (`admissibility-gate.ts:792`) that today gives the model nothing actionable
   now carries `layer:"reviewer"` (or the right layer) so the model can pivot —
   assert the structured field is present even when `pillar` is omitted.
9. **exactOptionalPropertyTypes.** `pillar`/`stackSource` are OMITTED when absent,
   never set to `undefined` (mirrors `snapshotResult` discipline elsewhere).

### 6.2 e2e

Through the real admissibility gate: a per-thread `workspace-write` policy denies
`bash` on a workdir (`policy.ts:397`). With the knob ON, assert the
`DispatchResult` the loop receives has `failure.denyReason = {verdict:"deny",
layer:"stack", pillar:"fileSystem", stackSource:"per-thread", safeReason:"Per-thread
policy (workspace-write) refuses bash on <workdir>"}` and the model-facing
`content` carries the prefix. Flip the knob OFF and assert the same path is
byte-identical to today (no prefix, no `denyReason`).

---

## 7. 단계 (Phases)

- **Phase 1 (core, this RFC's target):** `StructuredDenyReason` type +
  `deny()` 4th-arg + `ToolFailure.permission_denied.denyReason?` field +
  per-deny-site `layer` tagging + reuse-the-sanitized-`reason` wiring. Hellgate
  1–6, 9. Default-OFF.
- **Phase 2 (model content prefix + pillar inference):** the `[layer/pillar]`
  content prefix + wire the 4-pillar inference helper (`policy.ts:454`) into
  every deny site. Hellgate 5, 7, 8. e2e §6.2.
- **Phase 3 (debug surface, optional):** enrich `DecisionEvent` /
  `PermissionDecisionRecord` with `{layer, pillar}` and a `/why-denied` debug
  slash that prints the last N structured deny reasons for the session. Pure
  debug UX; backlog.

---

## 8. 리스크 / 대안 (Risks & Alternatives)

**R1 — leaking sensitive policy internals (the headline risk).** Surfacing "why"
could expose the HARD_DENY regex set (an attacker probing which patterns are
blocked), raw command text into a log, or env/file contents. *Mitigation,
fail-closed by construction:* `safeReason` is NOT a new string — it is the EXACT
value the recorder/OTel path already receives, which is contractually scrubbed
(`policy.ts:84-98`, `recorder.ts:98-125`, `admissibility-gate.ts:255-258`).
Hellgate 1–3 assert the structured surface carries NOTHING the OTel surface
doesn't. The HARD_DENY case splits: the model sees its OWN command in prose
`content` (it authored it), but the LOGGED `safeReason` is the categorical form
(no raw command persisted). The no-leak boundary is the central design constraint,
not an afterthought.

**R2 — the model over-reads the structured tag and gives up too early.** A
`pillar:"network"` deny might make the model abandon a task that had a
non-network path. *Mitigation:* the tag is ADDITIVE to the full prose (the model
still sees the human reason); the directive (if any) frames the tag as "this
specific action was refused," not "this whole goal is impossible." No behavioral
change to the deny itself — only richer feedback. ROI here is the model
retry-thrashing LESS, not the model giving up more (Claude/Codex evidence §2).

**R3 — pillar inference is wrong/ambiguous.** A deny might span pillars (a
network-via-bash command). *Mitigation:* `pillar` is OPTIONAL — when inference is
ambiguous, OMIT it (exactOptional, hellgate 5/9) rather than guess. A wrong pillar
is worse than no pillar (it could mislead the model). `layer` (which is always
unambiguous — it's the deny SITE) is the reliable signal; `pillar` is best-effort.
No heuristic threshold (`no-heuristics-only-validated`).

**R4 — default-OFF byte-identity must be perfect (the permission path is hot).**
A regression in the deny `content` or `failure` envelope would break trajectory
replay and every permission hellgate. *Mitigation:* the structured field is a NEW
optional key set ONLY when the knob is on; the `content` prefix is added ONLY when
the knob is on; both lazily computed. Hellgate 6 snapshots both branches against
the pre-feature baseline. Per the repo posture, this is a hot-path enrichment —
land it behind the knob, regression-verify each deny site one at a time
(`jun-04-partial-wiring-wave` lesson: hot-path wiring is surgery).

**R5 — duplicate prose vs. existing reason.** The `stack` path already has a rich
prose reason (`policy.ts:397`); prefixing it could read redundantly. *Mitigation:*
the prefix is a compact `[layer=… pillar=…]` MACHINE tag, not a restatement of the
prose; it adds the missing *structure*, not duplicate words.

**Alternative considered — surface the reason as prose ONLY (no typed field).**
Rejected: prose forces the model to string-match to classify, which is exactly the
retry-thrash failure mode (§2.2). The typed `failure.denyReason` is what lets the
model (and trajectory consumers) branch deterministically without parsing English.

**Alternative considered — do nothing (the prose is "good enough").** Defensible
for the rich `stack` denials, but the bare-"denied" cases (§3.2,
`admissibility-gate.ts:792`) genuinely give the model nothing, and a human
debugging "why does my tool keep getting denied" has no structured trail today.
C6's HIGH debugging value is in those gaps. Net: small, additive, default-OFF,
high debug ROI — worth shipping.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/permission/types.ts` — `PermissionDecision` (`deny`/`ask` carry a `reason`
  string, `:5-8`); `StructuredDenyReason` joins here as a value-only sibling of
  `ApprovalDecision` (`:114-130`).
- `src/permission/policy.ts` — the deny producers: `hardDenyReason`
  (`"Blocked dangerous command: ${cmd}"`, `:56-69`), per-thread/per-host deny
  reasons (`:397-432`); **the OTel sanitization contract** (`:84-98` — the no-leak
  boundary C6 reuses verbatim); the 4-pillar inference helpers (`:454`).
- `src/permission/recorder.ts` — `PermissionStackSource` closed enum (`:86-92`,
  reused as `StructuredDenyReason.stackSource`); the field-by-field scrub contract
  (`:98-125`).
- `src/permission/permission-profile.ts` — the 4-pillar taxonomy
  (`:2, 14, 124`) the `DenyPillar` enum draws from.
- `src/agent/admissibility-gate.ts` — every deny SITE (the `layer` source):
  stack (`:1083-1091`), guardian (`:431-446`), hook (`:604`), tool-profile
  (`:879`), confirm-missing bare-deny (`:790-793`), HARD_DENY handoff
  (`:830-838`), broker SOFT-deny (`:1213-1233`); the `ToolFailure.permission_denied`
  envelope `{mode, isReadonly}` (`:769-775`) C6 extends; `emitGateDecision`'s
  sanitization doc (`:255-258`).
- `src/agent/dispatch-helpers.ts` — the `deny(id, content, preview)` helper
  (`:43-50`) that gains the optional 4th `denyReason` arg.

**To add (implementation, NOT in this RFC):**
- `src/permission/types.ts` — `StructuredDenyReason`, `DenyLayer`, `DenyPillar`.
- `src/agent/dispatch-helpers.ts` — `deny()` optional 4th arg + content prefix.
- `src/agent/admissibility-gate.ts` — per-deny-site `StructuredDenyReason`
  construction (reusing the sanitized `reason`), `failure.denyReason` attach,
  `DecisionEvent` enrichment.
- the `ToolFailure.permission_denied` declaring module — optional `denyReason`
  field.
- knob registry + `QUANTA_DENY_REASON` / `permission.surfaceDenyReason`.
- `tools/feature-catalog/…` + `baseline.json` — `deny_reason_surfacing` fc node.
- `tests/unit/deny-reason-surfacing-hellgate.test.ts` — the §6 battery.
