# OPC-07 Completion Plan — audited final

Draft → 3-lens adversarial audit (completeness / priority+feasibility / answer-key+measurement) → this final.

## STATUS (updated) — all CODE landed; only the ops measurement (A2) remains
- ✅ **A1** VerificationPlan → live apps generation packet (active proof target).
- ✅ **A1-SAFETY** answer-key fence in `verificationTargetFromPlan` — only `repro`
  step cmds surfaced; `owner-test`/`module-smoke` cmds withheld (`cmdWithheld`),
  successPredicate reduced to `.type`. Defends leak-by-path that `assertPacketBlind`
  can't see. Red-on-injection test pins it. **Land before OPC-04.**
- ✅ **A1b** verificationTarget → repair packet.
- ✅ **B1** `PacketBlindnessViolation` → `degraded` verdict (excluded from resolved/total).
- ✅ **A4** golden snapshots for the 3 cases (full-shape fence) + behavioral intent tests.
- ⊘ **A1c** envCaveats — deferred: no real caveat source at generation time
  (fabricating one is noise). Revisit if a genuine env signal appears.
- ⊘ **A1-parity** (dead runner twin) — skipped: verificationTarget is optional and
  the twin is runtime-inert.
- ⊘ **A3** packet-coverage-by-stage — no code: derivable from the transcript
  (`"stage": "candidate_generation"` markers) + `result.llmEvidence`.
- Verification: OPC-07 surface `tsc` 0; OPC-07 tests green; final adversarial
  audit 4/4 PASS (fence airtight, threading positional-correct, B1 accounting
  correct, no twin contamination).
- ⛔ **A2 measurement** — NOT run. Hard-gated on: (1) target box idle (a concurrent
  run throttle-confounds both — forbidden), (2) spend authorization (EC2 spot +
  tokens), (3) isolation — the working tree currently also carries an unrelated
  in-flight `localize-budget` change, so a clean OPC-07 A/B needs an OPC-07-only
  base. Protocol below is ready to fire once those clear.

## Landed already (this session)
Typed `LlmEvidencePacket` (objects, not string bags); hard blindness guard
(`assertPacketBlind`, FAIL_TO_PASS/PASS_TO_PASS, throw); shared
`buildSelectionGenerationPacket`/`buildRepairSeedPacket` (both drivers de-duped,
self-contained — real issue facts, no ambient-prompt placeholder); bounded owner
`extractSymbolSlice`; repair `instanceIdHash` unified to the opaque
problem-statement hash (candidate id moved to `candidatePatchHash`);
`candidate_review` typed + legacy/shadow doc. **src typecheck 0; 42 OPC-07 tests
green; full unit 28974 pass, 0 new regressions** (5 pre-existing/concurrent-WIP
fails, none ours).

Audit correction worth recording: the pre-impl "dead-path P0" (intake/explanation
inert on live path) was a **false positive** — the live apps driver attaches
`result.llmEvidence` via the SHARED `prepareAttemptContext` +
`verifyAndFinalizeResult → buildSuccessfulResultExtra → attachLlmEvidenceArtifacts`.
File-level grep missed the shared-helper delegation. Verified, not trusted.

Remaining = finish the acceptance bullet "active proof targets" + the gating
measurement + the answer-key fence the richer packet now requires.

---

## Critical path (4 work-items; only A2 needs an EC2 box)

### Phase 1 — land DARK (cheap, code-only, no box). Measure once, after.

**A1 — thread the typed VerificationPlan into the generation packet (live apps driver).**
- `prepared.verificationPlan` is already at the `runSelectionPhase` call site
  (apps driver passes `prepared.verificationPlan?.baseValidatedRed` today). Pass
  the whole plan in; in `mergeHint` set
  `verificationTarget: verificationTargetFromPlan(plan)`. Blast radius: +1 param
  on apps `runSelectionPhase` (no other live caller) + 1 line in `mergeHint`. The
  packet branch is already gated `verifySelectProofRequired && selectorMode==="clean"`,
  so the non-clean string-concat path cannot change.
- **A1-SAFETY (HIGH — mandatory, lands with A1):** the plan is blind *today* only
  because `ownerNearTests`/`touchedModuleSmoke` are unpopulated on the bench path;
  it is NOT blind by construction, and `assertPacketBlind` is structurally blind to
  leak-by-PATH (a step `cmd` that runs a hidden test by path passes the content
  scan). So restrict `verificationTargetFromPlan` at construction time to a blind
  allowlist: surface only `repro` steps + the `issueDeclaredExpected`
  successPredicate; drop `owner-test`/`module-smoke` step `cmd`s (emit
  `missingEvidence` instead). Add a red-on-injection unit test: a plan containing a
  `pytest <path>::<node>` step must NOT render into `verificationTarget`. This fence
  must exist BEFORE OPC-04 (public-regression discovery) wires test-file-derived
  steps.
- Add a `verificationTarget`-present gate to `tests/unit/opc07-evidence-hellgate.test.ts`.

**A1b — thread `verificationTarget` into the repair packet** (`selection-executor.ts`
`repairPacketText` → `buildRepairSeedPacket`; `runSelection` already threads
`problemStatement`). Acceptance "active proof target" applies to repair too. Same
A1-SAFETY allowlist.

**A1c — wire `envCaveats` at generation** (builder field exists, no driver passes
it; ticket line 195 requires it). Cheap.

**A1-parity — dead runner-driver twin:** apply the same threading OR explicitly
mark parity-only in the same commit (the repo has a documented twin-drift hazard).
Runtime-inert; do it only to stop drift, label it so.

**A3 — packet-coverage-by-stage telemetry** (`report.ts`/`types.ts`). Re-scoped:
the other A2 readout fields (`submittedWithProof`, `blockedProofMissing`,
`blockedEnvFailed`, `contractOnlySubmitted/Blocked`, `repairOnlyCandidates`)
ALREADY exist in `report.ts`. The only genuine gap is a per-stage "packet
rendered?" count (generation/repair packets are inline prompt strings, never
recorded). Count it from the LIVE transcript, not branch-reachability ("wired ≠
engages"). Prereq for A2's coverage readout, so it lands before A2.

**B1 — `PacketBlindnessViolation` → `degraded` verdict** (reuse the existing
`latePhaseFailureResultOf({verdict:"degraded"})` path; today a guard throw falls
through to a generic miss and would be miscounted). Land BEFORE A2 so the
measurement is taken under final verdict accounting; verify it doesn't shift
instances between leaderboard miss-buckets.

### Phase 2 — ONE measurement pass (needs EC2 box). The acceptance gate.

**A2 — proof-required A/B** (before = HEAD baseline, after = A1+A1b+A1c+A3+B1).
HARDENED protocol (each control closes a confound the repo has been burned by):
- **Serial grading** enforced + verified (`max_workers=1` / grading lock) —
  concurrent grading produces false negatives.
- **Classify every non-resolve** via `perInstance.error` + `patchBytes` into
  {real_attempt, env/infra, throttle/429, empty_patch}; compare **real_attempt
  deltas only**. Throttle/empty-patch must not be counted as a miss.
- **n ≥ 3 runs per case**, report the failToPass distribution; no n=1 conclusion.
- **Box-liveness gate**: re-run on box death, never count as a miss; do NOT run
  while the user's box is live.
- **Env identity** (repo/version/python) pinned and parity-asserted across arms.
- **11-case contaminated set = RELATIVE delta only**, never reported as an
  absolute generalization score.
- **Control preset config-hash frozen** (no silent v4→v3 backport).
- **GATE before any success claim:** `contractOnlySubmitted == 0` AND admissibility
  semantics byte-identical before/after. Run order: 3-case proof smoke first, then
  11-case.

### Phase 3 — polish (only after A2 confirms not net-negative)

**A4 — golden snapshots for the 3 cases** (astropy env / django-11138 contract-only
/ django-14315 shell). Acceptance literally says "snapshot"; today they are
behavioral assertions. Defer until A1 has finalized the packet shape (don't
snapshot a shape you're about to change).

---

## Dropped / out of scope (audit-confirmed)
- **B2** (scan `verificationTarget.kind`/`authority` in the guard): low value —
  `cmd` + `successPredicate` are already scanned, and these are closed enums. Fold
  the 2-line addition into B1 or drop. The real leak surface is leak-by-path,
  handled by A1-SAFETY (construction-time), not content scan.
- **B3** (make the dup-builder source-grep gate non-brittle): internal test
  hygiene, no ticket value. Drop unless it flakes.
- **Dead runner-twin removal** (the `runInstance`/`runSelectionPhase`/`runAgentPhase`
  orchestration shell, self-documented "no production caller", only test-pinned):
  separate cleanup ticket — removal forces grep-gate edits, and the
  intake/explanation builders + `prepareAttemptContext` are SHARED/LIVE (keep
  those).
- **C1** (apps `regression-oracle-adapter` shared-import guard failing): concurrent
  WIP, different concern, not OPC-07.
- **C2** (pre-existing fails: architecture env guard / usage NaN / per-knob bundle):
  separate triage.

---

## Acceptance status after this plan
| Acceptance bullet | now | after A1(+b/c) | after A2 |
|---|---|---|---|
| one stage + one question per call | ✅ | ✅ | ✅ |
| clean v4 uses only generation + repair_seed | ✅ | ✅ | ✅ |
| candidate_review shadow/research only | ✅ | ✅ | ✅ |
| self-contained + real issue facts + **active proof targets** | ◐ (facts ✅, target ✗) | ✅ | ✅ |
| no hidden benchmark artifacts (+ leak-by-path fence) | ◐ (markers only) | ✅ (A1-SAFETY) | ✅ |
| shared builder, not duplicated | ✅ | ✅ | ✅ |
| stage-semantic tests | ✅ | ✅ | ✅ |
| contract-only ⇒ repair_only, never proof_positive | ✅ | ✅ | ✅ (gate) |
| env failure ⇒ infra_blocked, never candidate_red | ✅ | ✅ | ✅ |
| **snapshot** tests for 3 cases | ◐ (behavioral) | ◐ | ✅ (A4) |
| authority owned by OPC-02/03, not packet | ✅ | ✅ | ✅ |
| **Measurement** readout + don't-claim gate | ✗ | ✗ | ✅ |
