# jun-23 — Evidence-Packet Implementation-Completeness Audit & Remediation Plan

**Scope:** the bench LLM-evidence pipeline (`src/runner/batch/eval/**`, `src/agent/closure/**`,
`src/agent/verification-plan/**`). Audits whether each evidence-producing **tool / methodology is
correctly implemented** — independent of which preset/posture turns it on. Wiring + measurement
come later; this is the "build it right, then connect" prep.

**Method:** two adversarial parallel audit rounds (5 agents each), every claim grounded to
`file:line` and split into **WIRING** (rendered into packet) vs **ENGAGE** (reaches model / not
withheld/degraded). Earlier delivery-audit notes live in memory
(`jun-22-evidence-signal-audit-and-v5-seam`, `jun-22-scaff-northstar-3-measured`).

> **Guardrails.**
> - Implementation-complete ≠ resolved-rate improvement. Do NOT claim any of these lifts the score
>   until measured under a fixed preset (`no-heuristics-only-validated`).
> - Group C is design / public-test-targeting territory, NOT implementation — keep it out of the
>   impl sprint.
> - C3 (public owner-test cmd) is an **intentional target-leakage / reward-hacking fence**. Do not
>   expose the command path. If owner-test/module-smoke results are surfaced later, they must be
>   source-tagged receipts with `cmdWithheld:true`, not executable command text.

---

## Two axes (why "preset-independent" holds)

- **Axis A — does the stage run?** preset/posture decides (`verifySelectN` defined ⇒ clean
  verify-select rich path; undefined ⇒ thin/main prose path; `faultEvidence`, `verificationPlan`,
  `verifySelectRiskGate`, `QUANTA_BENCH_V5_ADAPTIVE` each gate their stage).
- **Axis B — given it runs, is the evidence complete/correct?** **structural** — same code for every
  preset that turns the flag on. This plan targets Axis B only.

---

## Live stage / consumer map (current-code truth)

| Stage | Current runtime consumer | Authority | Current risk |
|---|---|---|---|
| `intake` | report artifact / adaptive prep evidence only; no direct solver LLM call | none | low payoff to enrich unless a future LLM intake stage is added |
| `candidate_generation` | live clean selector prompt when proof-clean generation is enabled | advisory patch generation only | needs complete owner/proof/source packet; never submit authority |
| `candidate_review` | legacy pre-proof risk screen (`llm-risk-gate`) | shadow/research expansion advice only | name is misleading; not a post-exec correctness review |
| `candidate_post_review` | selector repair prompt and adaptive-router evidence input | advisory diagnosis / routing evidence | currently inherits path-only repair owner evidence in selector repair |
| `repair_seed` | live repair prompt in selector repair and classic repair | advisory bounded repair instruction | classic repair still has weaker proof taxonomy / verification target |
| `selection_explanation` | report RCA **and** adaptive-router input when selection telemetry exists | report/routing evidence only | "report-only" wording is false for adaptive routing; stage semantics must be explicit |

This map matters because WIRING-only checks can pass while the model sees a misleading stage contract
or a downgraded packet. `candidate_post_review` and `selection_explanation` are the main examples.

---

## Group A — pure implementation bugs (fix now, no design debate)

| # | Bug | What's wrong | Location | Sev |
|---|---|---|---|---|
| A1 | router drops `model`/`maxTokens` | `llm-router.ts` resolves+passes `model` (opus pin) & `maxTokens`, but `makeAdaptiveToolModelCall` never reads them ⇒ stream omits `model`/`max_tokens`, silently runs on deps' default model. `DEFAULT_ROUTER_MODEL`/`DEFAULT_ROUTER_MAX_TOKENS` inert | `adaptive-escalation/live-model-call.ts:44` | **HIGH** (verify→fix) |
| A2 | router `localizationCertain` forced `false` in every repair phase | derived from `sourceSlice !== undefined`, but repair reconstruction is path-only (`symbols:[]`, no reader) ⇒ slice never present ⇒ router over-routes to `deeper_localize` regardless of reality | `adaptive-escalation/router-evidence.ts:53` ← `selection-repair-seed.ts:485` | **HIGH** |
| A3 | exit-code collapses 8-state proof enum to 2 | `proofStateOf` emits only `candidate_green`/`candidate_red`/`not_run`; never `execution_failed`/`env_prep_failed` ⇒ infra crash reported as `candidate_red` (a correctness verdict) = the exact infra-vs-correctness conflation the enum exists to prevent | `repair/llm-evidence.ts:23` | MED |
| A4 | `validatedReproScripts` silently drops scripts 3+ | `.slice(0,2)` with no omitted-count flag ⇒ indistinguishable from "only 2 existed". Sibling repair-seed path DOES flag "Omitted N" (`driver.ts:1416`) = own standard, not applied here | `llm-evidence-packet.ts:865` | MED |
| A5 | repro-vote outcome telemetry never recorded | `recordReproVoteOutcome` seam built but `buildReproVoteValidate` never passes it ⇒ vote_resolved/unresolved/inconclusive + tally never recorded ⇒ the exact A/B lever is structurally unobservable | `repair/repro-vote.ts:101` | MED |
| A6 | `StaticWitness.fromFile` orphan | producer→consumer directional edge is set (adapter:335,376) but no business consumer reads it (only folded into `witnessId` + tests) ⇒ direction computed and discarded | `static-witness-adapter.ts:335` | MED |
| A7 | `lifecycle-owner` witness kind DEAD | declared in kind union + `OWNER_FAMILY_KINDS` + family map, but NO producer emits it and no contract maps it. `buildLifecycleOwnerContracts` (public-contract-bundle.ts:173) expects such files = half-wired path | `static-witness.ts:25` | MED |
| A8 | 4 dead `build*Packet` string wrappers | zero production callers, kept alive only by tests; object-vs-string drift surface | `llm-evidence-packet.ts:882,977,1040,1104` | MED |
| A9 | dead doc / false comments | `ProofReceiptFact.source:"verification_plan"` has 0 producers; `apps/bench/eval/driver.ts:832` comment "full, bounded" is false (actually 2-cap) | `llm-evidence-packet.ts:71`, `apps/bench/eval/driver.ts:832` | LOW |
| A10 | `selection_explanation` is not always report-only | adaptive controller feeds `buildSelectionExplanationPacket(...)` into the router when selection telemetry exists, but the packet `question`/allowedActions still say "explain". Router instruction asks for a phase decision, so the packet's stage contract is semantically stale | `driver.ts:3876`, `driver.ts:4372`, `adaptive-escalation/router-prompt.ts:63` | MED |

**A1 & A2 are the headline catches** — both are preset-independent code (wrong under any bench) and
A2 reveals the concrete behavioral consequence of the path-only degrade (C2 from the delivery audit):
it corrupts router routing. A1 needs a quick verify (model could default elsewhere) before fixing.

---

## Group B — completeness / asymmetry gaps (fix safe, claim value only after measurement)

| # | Gap | Detail | Location | Note |
|---|---|---|---|---|
| B1 | repair owner-slice restoration | reconstruction is path-only ⇒ slice/symbol-local context lost; SAME object feeds both `post_review` (522) and `repair_seed` (511). Root cause of A2 | `selection-repair-seed.ts:485`, `repair/llm-evidence.ts:38` | fixing A2 == fixing B1 |
| B2 | `owner_slice` missingEvidence asymmetry | only `candidate_generation` flags "no slice for file X" (`LEP:814`); repair/post_review/intake drop it silently | 3 builders | silent→visible, safe |
| B3 | classic-repair missing `verificationTarget` | field structurally absent on input type, though selector-repair sibling forwards it | `repair/llm-evidence.ts` | answer-key-neutral, safe |
| B4 | slice precision (`extractSymbolSlice`) | excludes the `@decorator` line above `def`/`class` (often the fix site); same-name def → first match only; binary/non-source conflated with not-found (single `undefined` channel) | `llm-evidence-packet.ts:499` | robustness |
| B5 | no owner-test / module-smoke proof receipt | only repro/mwe/regression become receipts to the LLM; owner-test execution results live only as gate signals (`smokeGreen`/`regressionGreen`) | `llm-evidence-packet.ts:70` | distinct from C3 (result, not cmd) |
| B6 | non-Python silent no-op | static-witness is Python-only regex; docstring claims "non-Python ⇒ null" (false — file IS read, matches nothing, 0 facts, no diagnostic) | `static-witness-adapter.ts:11` | MED if non-Python repos in scope |
| B7 | candidate edit surface missing from candidate-local packets | `candidate_post_review` / `repair_seed` carry `candidatePatchHash`, but not touched files/symbols or a bounded patch summary. The LLM/router can see "candidate identity" but not whether the candidate actually touched the owner/proof surface | `llm-evidence-packet.ts:986`, `llm-evidence-packet.ts:1049`, `selection-repair-seed.ts:513` | add source-only touched-file/symbol facts |
| B8 | source-policy is implicit, not typed | `ProofReceiptFact.source` is a free string and command exposure policy lives in builders/comments. SOTA-grade packet review needs explicit source class: public issue / public repro / public discovered test / static / official-hidden-withheld / infra | `llm-evidence-packet.ts:70`, `llm-evidence-packet.ts:630` | source auditability |
| B9 | router facts are too coarse after packet projection | `localizationCertain = any owner sourceSlice`; `positiveProof = any candidate_green`. That loses candidate-local correlation unless receipts and edit surface are hash/file aligned | `adaptive-escalation/router-evidence.ts:53`, `adaptive-escalation/router-evidence.ts:58` | fix after B1/B7 |
| B10 | engage-proof coverage still incomplete | tests cover packet rendering and some driver parity, but the acceptance bar should require "exact model/router prompt contains the field" for every live consumer, not just builder shape | `tests/unit/llm-evidence-packet.test.ts`, `driver.ts:2814`, `driver.ts:4380` | closeout gate |

---

## Group C — design / measurement decisions (NOT implementation — keep out of the sprint)

| Item | Why deferred |
|---|---|
| add `verificationTarget`/`proofReceipts` to risk gate | designed as a pre-proof screen, self-discloses via `missingEvidence`. "should it judge correctness-adjacent?" is a design call |
| add slice to intake (`ownerEvidenceFromFaultEvidence`) | intake is NOT an LLM stage (packet → report only, no model call) ⇒ low real payoff despite the asymmetry |
| expose C3 public owner-test cmd | intentional target-leakage / reward-hacking fence (`buildProjectPytestArgv` path can encode test selection). **Do not touch.** If result receipts are added, keep `cmdWithheld:true` |
| re-inject selection-RCA into generation | currently report-only; re-injection needs answer-key review (RCA may carry gold-adjacent info) |

---

## Scenario audit matrix — does the LLM get enough evidence?

| Scenario | LLM needs | Current state | Required fix |
|---|---|---|---|
| first candidate generation | issue facts, owner files, exact owner slices, public proof target, base repro state, env caveats | mostly present on proof-clean path; 3+ validated repro scripts are silently truncated | A4 + B2; stage snapshot must prove all fields reach the generation prompt |
| pre-proof expansion risk | candidate files, owner slices, why expand, no proof verdict | `candidate_review` name is misleading but it is correctly pre-proof/shadow | document as risk-screen only; do not add proof authority here |
| post-exec repair | failed proof receipts, infra-vs-candidate taxonomy, candidate edit surface, owner slices, verification target | selector repair has verification target but path-only owner evidence; classic repair has weaker proof enum and no verification target | A2/B1/B3/A3/B7 |
| adaptive routing after thin attempt | candidate touched surface, localization certainty, base repro/proof/regression signal, infra state | router packet is blinded and bounded, but projection booleans are lossy and model call drops model/tokens | A1/A10/B7/B9 |
| infra failure | env/build/tool failure class, stderr/stdout tail, "do not blame candidate" state | some paths preserve `execution_failed`; classic repair collapses nonzero exit to `candidate_red` | A3 plus engage snapshot for failure tails |
| owner-test/module-smoke result | public result state, source class, withheld command marker | result not surfaced as proof receipt today; command withholding is correct | B5/B8; add result-only receipt, never command text |
| non-Python repo/source | language scope and static analyzer absence | Python regex no-op is silent | B6; emit explicit missingEvidence/staticFact instead of pretending static witness ran |

This is the core "LLM 판단 정보 전달" standard: every live stage must make its decision surface
self-contained, bounded, source-tagged, candidate-local where needed, and authority-limited.

---

## Sequencing

1. **A1 + A2** — preset-independent real bugs. Start each from a hellgate RED e2e, then TDD.
   A1: assert the stream request carries the resolved `model`/`max_tokens`. A2: assert a repair-phase
   packet with a resolvable owner surfaces `sourceSlice` and the router sees `localizationCertain:true`.
2. **A10 + B7 + B9** — stage/route semantic integrity. Either rename/retarget the live adaptive
   selection packet or change its question/allowedActions to route-evidence semantics; then add
   candidate touched files/symbols and make router facts candidate-local instead of "any slice/any proof".
3. **B1 + B2 + B3** — A2's root cause + safe symmetrization. Thread `readSource` + `issueSymbols`
   into the repair reconstruction (reuse `buildSelectionOwnerEvidence`), mirror the per-file
   `owner_slice` missingEvidence, forward `verificationTarget` into classic repair.
4. **A3–A9** — taxonomy/orphan/dead-code cleanup (proof-state enum, `fromFile`, `lifecycle-owner`,
   dead wrappers, false docs).
5. **B4–B6 + B8 + B10** — robustness and auditability (slice precision, owner-test result receipt,
   non-Python honesty, source-policy typing, engage-proof snapshots).
6. **C** — leave alone; revisit only as separate measured/design work.

**Verification posture:** each fix lands with a wiring-proof test (field present in rendered packet)
AND, where it changes model input, an engage-proof check (field appears in the stage's actual LLM
input in a cassette/trajectory) — the two-level split is mandatory because this audit found defects
that pass wiring but fail engage (intake = no model call; B1 = rendered-but-path-only).

## Acceptance checklist for "SOTA-aligned information transfer"

- Every live LLM/router call has one stage, one question, and an allowed-action menu matching the
  actual consumer. No "report-only" stage may be used for routing without explicitly saying so.
- Every candidate-local packet includes candidate identity **and** source-only edit surface
  (`touchedFiles`, `touchedSymbols`, optional bounded patch summary), never the whole diff.
- Every proof receipt has an explicit public/hidden/static/infra source policy. Hidden/official
  harness-derived commands never appear; public result receipts may appear with command withheld.
- Every infra/environment failure is represented as `execution_failed` or `env_prep_failed`, never
  coerced to `candidate_red`.
- Every bounded truncation emits an omitted-count fact, so the LLM can distinguish "only two existed"
  from "more existed but were withheld for budget".
- Every missing owner slice emits `missingEvidence` in the live stage that consumes it, not only in
  generation.
- Every adaptive router projection has a paired-control test: flipping one packet fact flips exactly
  the intended router fact/gap, and candidate-local facts must be tied to the current patch hash.
- Every implementation ticket includes an ENGAGE receipt: the final prompt/request seen by the model
  contains the intended evidence and does not contain hidden oracle strings or withheld commands.

---

## Provenance

Two adversarial parallel audit rounds, 2026-06-23, all findings grounded to `file:line`. Several
original delivery-table verdicts were corrected by the audit: intake is vacuous (no model call);
C2 path-only was real but mis-located (the post-exec builder is pass-through; degrade is at
`selection-repair-seed.ts:485` + `repair/llm-evidence.ts:38`, and the adaptive-path post-review at
`driver.ts:3885→3911` passes FULL slices); C3 withhold is correct anti-gaming, not a bug; RCA
"partial reuse in adaptive route" was overstated (route rebuilds a fresh packet).
