# Jun 22 - Oracle Proof Clean v4 Final Plan

## Verdict

`agentless-v4-proof-clean` must become a proof-required selector, not a stricter
static selector. Static witnesses, owner families, patch budget, and contracts may
rank or seed repair. They must not make a candidate submittable without an
executed public proof.

This is the structural path. Do not add instance IDs, file-path regexes, issue
keyword gates, magic case tables, or hidden SWE-bench oracle data to runtime
authority.

## Current evidence

Latest checked 3-case run:

- Preset: `agentless-v4-proof-clean`
- Model: `gpt-5.4`
- Report: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-08a6d85afaefeadb5.json`
- Result: `0/3`

Failure shapes:

- `astropy__astropy-13033`: `harness_error:empty_patch`; repro install failed with `No module named 'extension_helpers'`; all candidates were rejected as `mwe=candidate_red`. This is first an environment parity failure, then a proof classification failure.
- `django__django-11138`: `timeout:multi_file_drift`; selected candidate had `voterQuorum=0`, no MWE proof, and static contract coverage only; hidden grading later found `F2P=1`, `P2P=4/73`.
- `django__django-14315`: `timeout`; selected candidate had `voterQuorum=0`, no executable proof, and static owner coverage only; hidden grading found `F2P=2`, `P2P=0/0`.

Inference:

- Previous green variation is not reliable proof by itself.
- The current v4 selector still lets contract-only candidates reach submission.
- Public MWE execution exists, but `execution_failed`/env failure is not cleanly separated from candidate correctness.
- The right fix is proof-authority wiring, not another targeted case heuristic.

## Authority model

Allowed as submit authority:

- Public MWE proof: base repo executes issue-derived public MWE and reproduces the failure; patched candidate executes the same MWE and passes.
- Repro consensus proof: generated repros have base-red and patched-green evidence across bounded independent samples, with false-negative handling that prevents sabotage but does not create positive authority.
- Public regression proof can be submit authority only when it encodes an
  issue-specific behavioral assertion and has an executable base-fail or
  equivalent issue-violating baseline. A generic base-green/candidate-green
  discovered test is safety evidence only; it cannot prove the bug was fixed.

Allowed as non-authority:

- Static witness contracts.
- Owner localization and owner-family coverage.
- Patch budget and minimality.
- LSP/static call graph references.
- Generic public regression keep-green results.
- Issue text extraction before base-red execution is proven.

Forbidden in clean runtime authority:

- `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, official harness results, gold patches, or contaminated-case IDs.
- File-path or issue-keyword matches that correspond to known benchmark instances.
- Static contract-only admission.
- Base-green or execution-failed public MWE used as candidate veto.
- Generic public regression keep-green used as proof of bug fix.
- Magic numeric scoring thresholds with veto power.

## Ticket map

Implement in this order:

1. `OPC-00-no-hidden-oracle-ratchet.md`
2. `OPC-01-astropy-env-production-parity.md`
3. `OPC-02-proof-authority-lattice.md`
4. `OPC-03-v4-proof-required-selector.md`
5. `OPC-04-public-regression-discovery.md`
6. `OPC-05-repro-consensus-submit-guard.md`
7. `OPC-06-reporting-and-bench-protocol.md`
8. `OPC-07-llm-evidence-orchestration.md`

## Rollout profile

Keep the existing preset name if the code already exposes it:

- `agentless-v4-proof-clean`

Required behavior for that preset:

- `selector-mode=clean`
- public MWE proof enabled
- discovered public regression safety proof enabled
- repro consensus proof enabled
- proof-required submit gate enabled
- hidden oracle disabled
- targeted gates disabled
- contract-only submit disabled
- any LLM packetization or review path must remain advisory-only and must not
  change admissibility

`agentless-v3-thin-strict-closure-select-clean` remains the control arm. Do not
silently backport v4 behavior into v3 while measuring.

## Implementation decisions

These decisions close the remaining gap between audit findings and an
implementable spec.

- Do not add a new live post-exec LLM gate in the v4 minimum. The current
  `llm-risk-gate` path remains research/shadow only. If the enum name
  `candidate_review` stays temporarily for compatibility, treat it as a legacy
  name for a pre-proof risk screen, not as proof review authority.
- Live LLM runtime usage in v4 minimum is limited to:
  - `candidate_generation`: bounded generation seed only
  - `repair_seed`: bounded post-proof repair seed only
  - `selection_explanation`: report-only RCA after deterministic selection
- `candidate_generation` and `repair_seed` packets must be self-contained. They
  must repeat the actual normalized public issue facts, active public proof
  target, owner evidence, and candidate hash when candidate-local. No packet may
  rely on "already attached in the main prompt" as its only authority.
- Packet payloads must stop being free-text string bags only. Keep the outer
  envelope (`stage`, hashes, `allowedActions`, `forbiddenSources`) but promote
  the inner evidence to typed objects:
  - owner evidence: file, symbols, provenance, optional exact source slice
  - proof receipts: source, command, state, base/candidate identity, bounded
    stdout/stderr tails
  - contract facts: contract id, authority kind, satisfied/missing
  - missing evidence: explicit kind and reason
- Evidence selection must be blind and deterministic. Allowed inputs are only:
  normalized public issue text, issue-derived symbols/files, closure owner
  admission, static witness outputs, public contract bundle, installed public
  repro command plus `baseValidatedRed`, deterministic public proof receipts,
  and source text read from the candidate sandbox. Hidden harness artifacts,
  scoreboards, contaminated-case labels, instance ids, and official SWE-bench
  tables are forbidden inputs.
- Source snippets must be exact owner/proof slices, not raw file bodies and not
  broad sliding windows. Selection rule:
  - only files already admitted into owner/proof evidence may contribute slices
  - each slice is the exact definition or symbol block resolved from public
    issue/static provenance
  - if no exact slice exists, attach the file path and emit `missingEvidence`
    rather than injecting a broad excerpt
- Reuse existing bounded execution-log behavior instead of inventing a new
  runtime threshold family. Proof stdout/stderr excerpts should go through the
  same bounded-tail helper already used by selector repair. Verification-plan
  breadth stays bounded by its existing required-step cap.
- The packet builder must be SSOT. Do not keep separate ad hoc builders in
  `src/runner/batch/eval/driver.ts` and `src/apps/bench/eval/driver.ts`; move
  stage-specific packet assembly behind a shared helper under
  `src/runner/batch/eval/llm-evidence-packet.ts` or a sibling module.
- Measure packetization as a wiring change, not as new authority. The selector's
  admissibility and proof-required gates remain deterministic. Any score claim
  from packet changes must be accompanied by unchanged authority semantics and
  explicit proof telemetry.

## Bench protocol

Local gates before remote:

- `bun run typecheck`
- `bun test tests/unit/selection-executor.test.ts tests/unit/mwe-proof-selection.test.ts`
- `bun test tests/unit/bench-preset-drives-config-hellgate.test.ts tests/unit/clean-preset-research-knob-allowlist-ratchet.test.ts`
- new OPC unit tests from the tickets below

Remote gates:

- 3-case proof set: `astropy__astropy-13033`, `django__django-11138`, `django__django-14315`
- 11-case contaminated set used by the clean rerun
- A/B against `agentless-v3-thin-strict-closure-select-clean`

Pass criteria:

- No candidate is submitted with `proofState=missing`.
- No candidate is submitted only because `requiredContractsSatisfied > 0`.
- No candidate is submitted only because generic public regression tests stayed
  green.
- Astropy environment failures are reported as infra/env, not candidate-red.
- If a case still fails, the report identifies which proof source was missing or failed.
- Score improvement is measured only after the proof gates are enforced.
- If LLM evidence packets are enabled, they include the current stage, evidence
  revision, candidate patch hash when candidate-local, allowed actions, and
  forbidden authority sources, and they do not alter admissibility.

## Non-goals

- Do not reintroduce `selection-declared-expected` or case-specific gates under a new name.
- Do not use hidden SWE-bench labels as runtime regression authority.
- Do not claim solved status from stale pre-final runs.
- Do not optimize raw score by accepting unverifiable multi-file drift.
- Do not ask the LLM to approve a candidate without executable proof.
