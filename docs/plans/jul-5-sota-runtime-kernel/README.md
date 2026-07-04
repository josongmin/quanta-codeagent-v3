# SOTA++ Agent Runtime Kernel — implementation RFC (jul-5)

Turns the "evidence-driven runtime" review into hellgate-able phases. Grounded in the
code-vs-proposal audit (see the same session's decision-map). **Key finding:** quanta is
already >½ runtime-first — the only *new* layer is observation→evidence→reducer (P1); the
rest is **converging** already-present-but-scattered infra, not inventing.

Audit verdict per proposal (A=already / B=partial-scattered / C=new / D=different-philosophy-keep):
- A: normalizeModelAction (`resolveTurnAction` recovery.ts:365), capability axis (registry.has +
  `capability()` + LSP ok:false), decisiveGate (`StructuredDenyReason.layer`), typed WorkingState
  (working-state.ts — but scratchpad, not evidence-state).
- B: DecisionReceipt (DecisionEvent type exists, emit scattered + loop-decisions uncovered),
  FinishDecision (single executor, 7 call sites), anti-loop (5 separate: dedup/breaker/cap/repro-doubt/
  verify-guard), EvidenceCard (FaultCandidate/IssueHint exist, no Ledger), Localization (steer+tools,
  no typed pass).
- C: **observation→evidence→reducer layer** (only true gap), plan lifecycle receipt.
- D: dispatch policy-product — keep short-circuit (fail-closed security); add observability via
  receipts, do NOT compute all axes.

## Status

- **P1 pure layer LANDED** (origin/main 52583fa29): `src/agent/evidence/{types,ledger,ingest,reducer,index}.ts`
  — EvidenceCard/Ledger (deterministic ids), pure ingest adapters, bounded digest reducer. 25 tests
  green, slice-pure, DEFAULT-OFF (no consumer yet → byte-identical). Philosophy guard: extracts/
  organizes evidence, does NOT decide hypotheses.

## P1 — remaining: live wiring (default-OFF `QUANTA_EVIDENCE_LEDGER`)

1. **working-state.ts**: add `evidenceDigest?: string` (or an `EvidenceLedger` handle on the session)
   — extend `WorkingState`; check consumers (renderWorkingStateBlock). Keep hypothesis/blockers intact.
2. **turn-closeout.ts** `appendPendingToolResults`: behind the knob, before/after raw append, run the
   ingest adapter on the tool result (reuse `@/tool parseTestFailure` at THIS edge → `ParsedTestFrame` →
   `ingestTestFrames` → ledger.add). Knob OFF ⇒ untouched raw append (byte-identical).
3. **prompt/context-assembler**: inject `renderEvidenceDigest(ledger.snapshot())` as a bounded dynamic
   block (like memory/glob). Empty ledger ⇒ "" ⇒ byte-identical.
4. Hellgate: RED e2e (tool result → digest appears in next turn's context only when knob ON); byte-
   identical OFF (5-target hash unchanged); no-leak (reveal handles don't inline hidden-test content);
   knob-inventory register. Then measure-first A/B on SWE/TB.

## P2 — DecisionReceipt spine (converge)

`DecisionEvent` (stream/decision-emitter.ts:34) kind is `permission|rule|hook|cap|jail|budget` — tool/
permission only. **Extend the kind union with loop decisions** (`retry|finish|park|stop|plan`) and emit
from turn-outcome.ts (finish/park/continue), recovery.ts (retry actions), stop-conditions.ts (budget),
plan-*-wire (transitions). reasonCode ← stop-category SSOT. This makes the loop auditable through the
same bus dispatch/permission already use. Hellgate: each new decision path emits exactly one receipt
(RED-on-injection); default-OFF via existing `surfaceDenyReason`-style gate so emit is inert unless on.

## P3 — anti-loop registry (converge)

5 guards (dispatch-dedup / compaction-breaker / cap-enforcer / repro-doubt-guard / verify-guard sticky-
red) each detect a distinct "repeat". Introduce a common `antiLoopKey` (tool+normalized-input+regime)
+ a registry that the 5 report into, enabling cross-guard dedup (same failing test across guards) and
a single receipt (ties into P2). Refactor, not new behavior — keep each guard's threshold. Hellgate:
each guard's existing tests stay green; add cross-guard dedup test.

## P4 — FinishDecision funnel + plan receipt

`ctx.finish` has 7 call sites (turn-loop + entry). Route every terminal path through a `FinishDecision`
object returned to a single executor (extend `TurnLoopResolution`; entry's session-start abort too).
Add plan lifecycle receipt (queued/applied/dropped/reason) at applyQueuedPlanLifecycle (turn-outcome.ts:20)
+ plan-*-wire — currently only mode_changed/plan_snapshot side-effects, no transition audit.

## P5 — Localization typed pass

Lift scattered localization (agentless-localize / forward-localize / CHA-multisite / spec-steer) into a
typed `LocalizationPass` (candidates{files,symbols,tests,callPaths} / excluded{reason,evidenceRefs} /
selectedPatchTargets{rationale}). Consumes P1 EvidenceCards; connects to semantica-codegraph. The engine
narrows/links/finds-contradictions; the model still selects. Biggest of the converge phases; sequence last.

## Guards (apply to all phases)

- DEFAULT-OFF + byte-identical when off (5-target prompt hash for prompt-touching phases).
- Do NOT prompt-bomb: bounded digests, reveal handles for raw, receipts only on decision points
  (deny/retry/finish/stop/plan) — never on text emit.
- Keep LLM autonomy: typed EVIDENCE, model-decided HYPOTHESES.
- Each phase: hellgate (RED→TDD→adversarial ≥3R→self-audit), land on origin/main, measure-first A/B.
