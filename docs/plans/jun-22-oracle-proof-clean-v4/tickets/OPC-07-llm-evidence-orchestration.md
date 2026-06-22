# OPC-07 - LLM Evidence Orchestration

## Goal

Give the LLM the right evidence at the right time so it can make useful local
judgments, while keeping final authority in executed proof rails.

The LLM may request evidence, generate candidates, explain proof failures, and
propose bounded repairs. It may not admit a candidate, override a failed proof,
or use hidden benchmark data.

## Problem

The current scaffold has the right ingredients:

- `FaultEvidencePacket`
- `VerificationPlan`
- issue hint extraction
- public contracts
- MWE proof receipts
- public regression witness receipts
- repro consensus receipts
- static sanity and patch-budget facts

But those ingredients are not yet delivered as stage-specific decision packets.
This causes two bad modes:

- under-informed patching: the LLM patches from issue text plus broad context and
  misses the actual owner/proof surface;
- over-powered selection: static contracts and owner coverage leak into submit
  authority instead of serving as repair/generation evidence.

## Design

Add a typed `LlmEvidencePacket` with one explicit `stage`.

This ticket is downstream of proof-authority work. It does not define proof
authority, retry count, report schema, or clean submit behavior. It consumes the
typed outputs of the proof rails and packages them for LLM use.

In clean v4, any LLM-guided runtime action must remain advisory-only with
respect to submit authority. Deterministic proof rails still decide admission.

## Minimum-scope decision

The v4 minimum does not add a new live post-exec LLM review gate.

Implement only these live/runtime uses:

- `candidate_generation`: yes
- `repair_seed`: yes
- `selection_explanation`: optional report-only

Do not implement these as live v4 clean behavior:

- `intake`: no
- post-exec `candidate_review`: no

The current `llm-risk-gate` path is a pre-proof expansion screen. It may stay in
research/shadow mode, but it is not part of the v4 proof-clean minimum. If the
runtime enum/string `candidate_review` remains temporarily for compatibility, it
must be documented and treated as a legacy name for a risk-screen stage, not as
proof review authority.

This decision is deliberate:

- it keeps v4 authority deterministic;
- it avoids introducing a second live selector gate whose effect would need a
  separate bench readout;
- it uses the evidence that already exists at generation time and after proof
  execution, instead of inventing a new collection stage.

## Packet schema decision

Keep the outer packet envelope stable:

- `stage`
- `instanceIdHash`
- `evidenceRevision`
- `candidatePatchHash` when candidate-local
- `question`
- `allowedActions`
- `forbiddenSources`

Replace the inner free-text bags with typed objects. The packet should move
toward a discriminated union, not remain only parallel string arrays:

- `publicIssueFacts`: actual normalized public issue facts, not a placeholder
  sentence that points back to ambient prompt text
- `ownerEvidence`: `{ file, symbols, provenance, sourceSlice? }`
- `proofReceipts`: `{ source, command?, state, baseValidatedRed?, stdoutTail?, stderrTail?, candidatePatchHash? }`
- `contractFacts`: `{ contractId, authority, satisfied }`
- `staticFacts`: `{ kind, value }`
- `missingEvidence`: `{ kind, reason }`

The JSON renderer can stay generic; the key change is the typed packet builder
and stage-specific population rules.

## Evidence-availability decision

Only attach evidence that already exists at that stage. This ticket is wiring
and schema expansion, not new infra.

Evidence already available before generation:

- normalized public issue text
- issue-derived symbols/files
- closure owner admission / owner-resolved files
- `closureSession.bundle.plan`
- installed public repro command and `baseValidatedRed`
- public contract bundle / static witness contracts
- source text from `readSandboxSource(...)`

Evidence already available after proof execution:

- public MWE receipts
- repro consensus receipts
- discovered public regression receipts
- static sanity findings
- bounded stdout/stderr failure tails

Do not design a packet field that requires hidden harness state or a new
collection pass that the stage does not already own.

## Blind-selection and answer-key safety

Packet construction must be benchmark-blind. Evidence selection may depend only
on:

- public issue text
- repo source state in the candidate sandbox
- deterministic static witness / owner / contract outputs
- already-executed public proof receipts

It must not depend on:

- `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`
- hidden failing test names
- leaderboard or comparison tables
- contaminated-case labels
- benchmark instance ids or case-specific file regexes

This is a hard guard, not a soft preference. Packet enrichment is the easiest
place to accidentally reintroduce answer-key leakage.

## Bounding decision

Do not inject raw file bodies and do not use broad sliding windows.

Source-slice rule:

- only files already admitted into owner/proof evidence may contribute slices
- each slice is the exact definition or symbol block resolved from public
  issue/static provenance
- if no exact slice can be resolved, attach the file path and emit
  `missingEvidence`; do not fall back to a broad excerpt

Execution-log rule:

- reuse the existing bounded stdout/stderr tail helper already used by selector
  repair
- do not create a new family of unrelated runtime regex/length heuristics for
  packetization

Verification breadth rule:

- use the existing `VerificationPlan.required` cap
- show required steps first; optional steps are advisory only

Every LLM response must be parsed as structured JSON and validated. Invalid,
missing, or overbroad output falls back to deterministic safe behavior:

- generation stage: continue with next deterministic seed;
- review stage: mark as `needs_more_evidence`;
- repair stage: no repair or generic bounded repair seed;
- selection stage: no authority change.

## Stage packets

### Candidate generation packet

Purpose:

- make one candidate with enough local context and a clear proof target.

Include:

- actual normalized public issue facts;
- issue-derived symbols / files;
- narrowed owner files with provenance;
- verification-plan primary required step;
- installed repro command and `baseValidatedRed` when present;
- public contract obligations;
- exact owner/proof source slices when resolvable from admitted files;
- env caveats that already exist at generation time.

Ask:

- "Produce one minimal patch against this bounded owner/proof surface."

Allowed actions:

- `edit_candidate_sandbox_only`
- `inspect_named_owner_files`
- `produce_minimal_patch`

Forbidden:

- broad multi-file drift without a listed cross-file proof reason
- adding tests as substitute for source fix
- hidden oracle assumptions

Implementation note:

- generation packet assembly must be shared between
  `src/runner/batch/eval/driver.ts` and `src/apps/bench/eval/driver.ts`
- do not keep duplicated inline packet builders

### Repair seed packet

Purpose:

- turn a deterministic proof/contract failure into one bounded next candidate.

Include:

- previous candidate hash;
- exact failed public proof receipts;
- failed or missing public contract facts;
- static-sanity findings when they blocked a structurally stronger candidate;
- family/owner side that was missed;
- patch-budget / structural drift facts;
- bounded stdout/stderr failure tails for public proof failures.

Ask:

- "Generate a bounded repair instruction for the next candidate."

Allowed output:

- JSON object with `repairFocus`, `mustTouch`, `mustAvoid`, `proofToSatisfy`,
  and `why`.

Forbidden:

- "try harder" style generic repair;
- benchmark-specific target files unless they are already in public owner evidence;
- hidden failing test names.

Implementation note:

- this is the only post-exec LLM action in the v4 minimum
- the repair packet is candidate-local and must carry `candidatePatchHash`
- the repair packet may guide the next generated candidate, but it does not
  modify admissibility logic

### Selection explanation packet

Purpose:

- produce RCA for humans after selection is complete.

Include:

- deterministic selected candidate id;
- proof authority state;
- candidates blocked and why;
- infra/proof/model split.

Ask:

- "Explain the decision and remaining missing evidence."

Authority rule:

- This packet is report-only. It cannot alter the selected patch.

## Evidence timing rules

- evidence must be attached after it is produced, not reused silently across
  incompatible candidate hashes
- candidate-local proof receipts must include the candidate patch hash
- base proof receipts must include repo/version/env identity
- public MWE `execution_failed` and `env_prep_failed` must be shown as infra,
  not candidate correctness
- static discovery evidence can be shown before execution, but must be labeled
  `static_only`
- executed proof receipts must say whether they are `base_red`, `base_green`,
  `candidate_green`, `candidate_red`, or `execution_failed`
- a packet used as a generation seed must be self-contained; it cannot point
  back to ambient prompt text as its only issue authority

## Files

- `src/runner/batch/eval/llm-evidence-packet.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/llm-risk-gate.ts` (`shadow` or separate measured arm only)
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/eval/fault-evidence.ts`
- `src/runner/batch/eval/repo-regression-discovery-adapter.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- `src/agent/verification-plan/*`
- `tests/unit/llm-evidence-packet.test.ts`
- `tests/unit/selection-executor.test.ts`
- `tests/unit/report-telemetry-wiring.test.ts`

## Measurement

Measure this as packet-orchestration wiring, not as a new proof authority path.

Required readout:

- same proof-required selector semantics before and after the packet change
- 3-case proof set first, then 11-case contaminated clean set
- same model, same preset family, same remote box class
- compare:
  - resolved count
  - `submittedWithProof`
  - `blockedProofMissing`
  - `blockedEnvFailed`
  - `repairOnlyCandidates`
  - packet coverage by stage

Do not claim success from packet changes alone unless authority telemetry shows
that admissibility semantics remained deterministic and `contractOnlySubmitted`
stayed zero.

## Acceptance

- Each LLM call declares exactly one stage and one question.
- Runtime clean v4 uses only `candidate_generation` and `repair_seed` packets.
- Any remaining `candidate_review` wiring is shadow/research only.
- Generation and repair packets are self-contained and include actual public
  issue facts plus active proof targets.
- Packet builders do not read hidden benchmark artifacts or contaminated-case
  metadata.
- Runner/app driver packet assembly is shared from one helper, not duplicated.
- Packet tests cover stage semantics, not only JSON rendering shape.
- Contract-only evidence can produce `repair_only`, never `proof_positive`.
- Env failures produce `infra_blocked`, never `candidate_red`.
- Hidden oracle fields are absent from every clean packet.
- Proof authority, proof-required failure, and retry count remain owned by
  `OPC-02`, `OPC-03`, and selector runtime code, not by packet-local LLM labels.
- Snapshot tests cover the three failed cases:
  - astropy env failure packet asks for env/proof recovery, not candidate blame;
  - django 11138 contract-only multi-file drift packet asks for public proof or
    bounded repair, not submit;
  - django 14315 shell/env packet asks for runshell/env proof, not static owner
    approval.

## Hellgate

The LLM can improve judgment only inside the allowed action menu. It cannot
become a hidden verifier, a score override, or a benchmark-case classifier.

This ticket must not become the critical path for v4 proof-clean qualification.
