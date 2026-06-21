# jun-22 scaffold — execution plan (incl. jun-21 close-out)

## STATUS (2026-06-22) — all 8 tickets LANDED on main

| Ticket | What | State |
| --- | --- | --- |
| SCAFF-01 | static-witness IR | ✅ `static-witness.ts` (10 teeth) |
| SCAFF-02 | AST witness adapter | ✅ `static-witness-adapter.ts` (11) |
| SCAFF-03 | owner-evidence lattice (witness → authoritative owner) | ✅ `witnessAuthoritativeOwners` + `fault-evidence` `witnessOwners`/`static-witness` source + `prepareAttemptContext` digest (both drivers); 14 teeth |
| SCAFF-04 | candidate-family expansion (witness → generated co-change) | ✅ `staticWitnessesToFamilies`/`withStaticWitnessFamilies`, both drivers; 5 teeth |
| SCAFF-05 | static-witness → required public contracts | ✅ `static-witness-contracts.ts`, both drivers (8) + e2e (3) |
| SCAFF-06 | executable public MWE proof-state rail | ✅ `mwe-proof.ts` (20) — module landed; selection wiring is a follow-up lever |
| SCAFF-07 | astropy repro env (`setuptools<60`/extension_helpers) | ✅ `project-env.ts` + test |
| SCAFF-08 | contamination ratchet (no answer-key in clean authority) | ✅ `static-witness-contamination-ratchet.test.ts` |

Adversarial audit (≥3R) on the integrated wiring caught + fixed: research-mode
perturbation (witnessOwners now gated to the clean path, legacy byte-identical)
and a vacuous theater tooth (now a real family→verify / single→commit-now paired
control). Full SCAFF + fault/owner/closure + parity suite: 245 pass / 0 fail, tsc
unchanged at 116. The django-RCA co-change fix is proven LIVE via the SCAFF-04
(generation) + SCAFF-05 (selection contract) chain (`static-witness-selection-e2e`).


How to actually build SCAFF-01..08 without rebuilding what jun-21 already shipped,
with the proven parallel pattern (pure new modules in parallel → chokepoint wiring
sequential + parity-locked → adversarial hellgate per ticket).

## North-star (the only success metric)

Under `agentless-v3-thin-strict-closure-select-clean`, the 3 RCA cases resolve with
NO instance-id / gold / path-regex / issue-family steer:
- `django-14315`, `django-11138`: an AUTHORITATIVE multi-site obligation exists, so a
  complete co-change candidate beats the single-site one when executable proof is tied
  (today `requiredContractsSatisfied=0` → minimality wins the wrong patch).
- `astropy-13033`: repro env runs far enough that executable selection is meaningful
  (today: `No module named 'setuptools.dep_util'`).
Plus: unresolved cases emit telemetry splitting witness / contract / candidate-gen /
executable-proof / grading failure modes.

## What jun-21 ALREADY gives us — EXTEND, do not rebuild

| Need | Already there (evidence) |
| --- | --- |
| contracts outrank minimality | `select-lexicographic.ts` (T-SEL-06) ✓ |
| `multi-site-family` contract type + builder | `public-contract-bundle.ts` ✓ |
| multi-site family from shared issue-symbol | `candidate-families.ts` + `driver.ts:2740/2755` ✓ |
| clean owner admission rule-based + ACTIVATED | T-OWN-12 + `ownerClean` wired this session ✓ |
| diff→touched-symbols, api-surface contract | `diff-touched-symbols.ts` ✓ |
| clean-preset research-knob allowlist ratchet | `clean-preset-research-knob-allowlist-ratchet.test.ts` ✓ |
| family genuineness ratchet | `family-genuineness-ratchet.test.ts` ✓ |
| 3-label score taxonomy | `score-label.ts` (plumbing pending) |

So SCAFF mostly = (a) a TYPED witness IR generalizing the ad-hoc symbol witness,
(b) a richer AST adapter (override-family / producer-consumer / registration-callback),
(c) bridging those to the EXISTING required-contract + family tiers.

## Dependency waves

```
A  SCAFF-01  StaticWitness IR (new types + pure ctors)        [foundation]
B  SCAFF-02  AST static-engine adapter (Python AST → witness) ─┐ parallel
   SCAFF-07  astropy env parity (uv argv flags)               ─┘ (independent)
C  SCAFF-03  owner-evidence lattice  (witness → authoritative) ─┐ coupled chokepoint
   SCAFF-04  candidate-family expansion (witness → families)   │ (sequential wiring,
   SCAFF-05  public-contract bridge   (witness → required)     ─┘  parity-locked)
D  SCAFF-06  executable public MWE rail (proof states)
E  SCAFF-08  contamination ratchet (extends jun-21 ratchets + source-literal guards)
```

Critical path to the django fix: **SCAFF-01 → SCAFF-02(override-family) → SCAFF-05
(override-family → required multi-site) → SCAFF-04(complete-family rank)**. That chain
alone flips `requiredContractsSatisfied` for the django cases. astropy is the parallel
SCAFF-07 lane.

## Parallelization (proven pattern)

- PURE NEW MODULES → parallel agents, each with a hellgate + paired-negative test, NEW
  files only (no chokepoint edit):
  - `static-witness.ts` (SCAFF-01 IR), `static-witness-adapter.ts` (SCAFF-02),
    `buildStaticWitnessContracts` (SCAFF-05 pure builder), the astropy argv builder
    extension (SCAFF-07).
- CHOKEPOINT WIRING → sequential, single writer, parity-locked
  (`selection-executor.ts`, both drivers, `fault-evidence/build.ts`,
  `owner-admission/index.ts`, `closure-session.ts`): SCAFF-03/04/05 wiring + SCAFF-06.
  Thread every new scaffold input through BOTH drivers identically; re-run
  `tests/unit/runner/verify-select-driver-parity.test.ts` (note: path is under
  `tests/unit/runner/`, NOT `tests/unit/` — earlier runs silently skipped it).
- GUARDS → SCAFF-08 last, plus a forbidden-literal source test PER new builder
  (no `django__`/`astropy__`/gold-path/`FAIL_TO_PASS` literal) added with each module.

## Per-ticket gate (the teeth that must hold)

- SCAFF-01: forbidden provenance (`gold-patch`/`fail-to-pass`/`instance-id`/
  `known-file-regex`/`issue-family-regex`) cannot convert to clean authority; 1-file
  witness can't be `multi-site-family`; dup→one id; no raw source body.
- SCAFF-02: no witness from stage1-only; stable across runs; both drivers identical
  bundle; missing engine → empty/advisory (never fabricated authority).
- SCAFF-03: stage1-only / same-symbol-sibling can't be authoritative without typed
  relation provenance; 2 authoritative → family/cross-owner (not arbitrary single);
  authoritative-alone never early-accepts.
- SCAFF-04: single-site candidate can NOT get complete-family rank for a multi-site
  witness; family label alone = no authority (satisfaction from touched files).
- SCAFF-05: A(1 file) vs B(all witness files), proof tied → B wins; minimality can't
  overtake required-contract; advisory witness can't make a required contract.
- SCAFF-06: extracted fence alone can't hard-reject; base-green MWE can't be clean
  veto; `execution_failed` ≠ candidate-wrong; `patched_green` carries cmd/env/exit.
- SCAFF-07: astropy argv includes `--no-project --with setuptools<60 --with
  extension_helpers --with-editable . --no-build-isolation`; repro+smoke share the env
  builder; missing build dep reported as infra before selection.
- SCAFF-08: inject `rca-target-gates:1` into a clean preset → red; instance-id/target
  path literal in a clean witness/contract builder → red; research signal in telemetry
  can't change clean admissibility/contract counts.

## Dedup / collision hazards

1. SCAFF-01 `static-witness.ts` SUPERSEDES jun-21 `static-witness-bundle.ts` — delete
   the old one (+test) when SCAFF-01 lands. (jun-21 REMAINING #2.)
2. SCAFF-03 EXTENDS the already-activated T-OWN-12 admission — ADD witness kinds to the
   authoritative set; do NOT rebuild `decideOwnerAdmission`. `ownerClean` is already
   wired + hellgate'd.
3. SCAFF-04 EXTENDS `candidate-families.ts` multi-site — add the typed family ids to the
   existing precedence; keep the genuineness ratchet green.
4. SCAFF-05 wires the currently-no-consumer builders (`buildLifecycleOwnerContracts`
   etc.) — do NOT trim them (jun-21 REMAINING #4 reversed).
5. The teammate is co-editing `selection-executor.ts` / drivers / `public-contract-bundle.ts`
   / `candidate-families.ts` — re-read before every chokepoint edit; new modules avoid it.

## Language coupling (state it, don't fake around it)

AST extraction (SCAFF-02) is Python-specific (def/class/inheritance), same coupling as
`patch-budget`. Acceptable: SWE-bench Verified is all-Python. Mark it
source-language-best-effort; non-Python → empty/advisory witness, never fabricated.

## Order of execution

1. Close jun-21: nothing to code (#1/#3 done; #2/#4 absorbed here; #5 = bench).
2. SCAFF-01 (IR) — foundation, do first.
3. SCAFF-02 ‖ SCAFF-07 (parallel).
4. SCAFF-03 → SCAFF-04 → SCAFF-05 (sequential chokepoint, parity-locked).
5. SCAFF-06.
6. SCAFF-08 (ratchet) + delete old static-witness-bundle.
7. Remote rerun of the 3 cases under the clean preset → confirm
   `requiredContractsSatisfied>0` + complete-family wins (the actual proof). Bench = user.
```
