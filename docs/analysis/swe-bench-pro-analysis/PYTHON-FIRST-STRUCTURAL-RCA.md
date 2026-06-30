# Python-Pro Structural RCA (2026-06-30)

Scope: the current 8-case Python-Pro smoke evidence plus current-head bench code. This is the narrow answer to "what must change first if we want Python-Pro to move?"

## Verdict

- The main bottleneck is **not** "support more languages first".
- For Python-Pro, the first two blockers are:
  - **Python repro oracle parity is still too weak**.
  - **The first successful path still under-executes coordinated multi-file repair**.

Everything else is secondary until those two move.

## Objective Audit

### 1. What the smoke artifacts actually prove

From the two smoke closure artifacts:

- `owner_recall@1 = 1.0`
- `synth_repro_base_red_rate = 0.25`
- `repro_red_but_unresolved_rate = 1.0`

Interpretation:

- File localization is **not** the dominant failure on this set.
- Only **1 of 4** unresolved cases got a live base-red repro signal.
- Even that one red-on-base case still did not resolve.

So the failure split is:

- **oracle activation failure** on most misses
- **synthesis failure** on the remaining miss

### 2. Python-Pro is already the intended first lane

The repo docs already say Python-Pro should go first:

- `docs/analysis/swe-bench-pro-analysis/README.md`
- first live 5-pick: Python `2/3` pass, JS `0/2`

This is not a new strategy. It is current repo direction.

### 3. Python env support is no longer the naive bottleneck

Current head already hardens the host Python env significantly:

- `src/runner/batch/corpus/project-env.ts`
  - official era pins
  - install extra extraction from `-e .[test]`
  - repo-specific env/build overrides
- `src/runner/batch/corpus/dataset.ts`
  - repro runs under that same project env

So for Python-Pro the next issue is **not** "just add more `uv --with` deps on host".

### 4. The remaining Python oracle gap is image parity

Current docs and code agree on the real remaining blocker:

- `docs/plans/jun-29-repro-adapter-polyglot/README.md`
  - qutebrowser-class misses came from missing pytest plugins in the host env
  - intended fix is running repro inside the instance image
- `src/runner/batch/eval/repro-adapter.ts`
  - image backend exists
  - it is default-OFF because mounted-sandbox import parity is still unproven

That is the right bottleneck to attack first.

### 5. Multi-file machinery exists, but it is not yet the default winning path

Current head already has real multi-file machinery:

- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/knobs/presets.ts` (`agentless-v7-oracle-multifile`)

So the problem is not "multi-file support is absent".

The problem is:

- the smoke misses still collapse to partial single-file or under-coordinated fixes
- the stronger family/breadth path is not yet proven as the default Python-Pro winner

## Adversarial Audit

### 1. `owner_recall@1 = 1.0` is real but flattering

For these smoke artifacts, it means the first patch file overlapped gold.

It does **not** mean:

- full gold coverage
- correct co-change family coverage
- successful multi-file synthesis

On this set, every unresolved case still had `ownerHit=true`.

### 2. `cross_file_rate = null` is not the right proof

The smoke artifacts show `cross_file_rate = null`, but that is a **run-artifact measurement gap**, not current-head truth.

Current head already backfills offline cross-file facts in:

- `src/runner/batch/eval/closure-diagnostics-io.ts`

and already computes:

- `gold_coverage_rate`
- `exact_file_set_match_rate`
- `multi_file_full_coverage_rate`
- `multi_file_partial_overlap_rate`
- `multi_file_disjoint_rate`

So the multi-file bottleneck is real, but the null metric itself is stale evidence.

### 3. The real multi-file evidence comes from the instance set

The unresolved Python-Pro smoke misses are structurally multi-file:

- `ansible-a26c`: 5 gold files; the core fix site is `urls.py`, but the issue requires parameter threading across modules.
- `openlibrary-4a5d`: 3 gold files; core helper plus template/i18n-facing completion, while the F2P oracle only pins the helper.
- `openlibrary-dbbd`: 2 gold files; `lists.py` plus `upstream/utils.py`, with the second file mostly unverified by the thin oracle.
- `qutebrowser-c580`: 3 gold files; util extraction plus hostblock consumer rewrite.
- `qutebrowser-f631`: 5 gold files; the causal code surface is really `configfiles.py + app.py + configdata.yml`, with docs mostly noise.
- `ansible-395e`: 4 gold files; enum/state refactor plus cross-module strategy consumers.

This is the actual proof that Python-Pro is blocked on co-change synthesis, not on first-file localization.

## Language Differences That Actually Matter

The right extensibility question is not "support every language the same way".

It is:

- which parts are genuinely language-specific
- which parts must stay language-agnostic
- where current head already has the seam
- where it still has duplicated language switches

### 1. Repro generation/execution is language-specific

This is the clearest language split.

Different languages need different:

- scaffold file extensions
- execution commands
- structured evidence sidecars
- stdout/stderr outcome parsers

Current head already models this correctly in:

- `src/runner/batch/eval/repro-adapter.ts`

That is the right architectural shape:

- `language adapter`
- plus `exec backend`
- as separate axes

### 2. Execution backend is orthogonal to language

`host` vs `image` is not a Python-only concern.

It is a runtime axis:

- `host`
- `image`
- potentially later other controlled backends

Current head already models this separation in:

- `ReproExecBackend`
- `preferredReproExecRuntime`

This should remain orthogonal. Do not bake backend policy into each language adapter.

### 3. Public verifier shape is language-specific

There are two verifier worlds:

- hidden dataset grading rails
- public repo-local verifiers from `selected_test_files_to_run`

The public verifier is already language-sensitive today:

- Go: selector-style `go test -run`
- JS/TS: file-path-style `npm test -- <paths>`
- Python: no selected-test public adapter path here

Current head already has a narrow seam:

- `src/runner/batch/corpus/selected-test-files-verifier.ts`
- `src/runner/batch/eval/repo-local-verifier-command.ts`

Directionally this is correct. Architecturally it is still parallel to, not unified with, the repro adapter path.

### 4. Repo environment materialization is partly language-specific, partly spec-driven

The environment problem is not only "Python vs non-Python".

It splits into:

- repo/version-specific official install/test recipe
- language runtime/toolchain
- backend location (`host` vs `image`)

Current head already has the spec-driven source of truth:

- `src/runner/batch/corpus/repo-version-specs.ts`

That must stay authoritative. Language adapters should consume it, not replace it with inline repo heuristics.

### 5. Static analysis helpers are unevenly language-scoped

Supporting rails are not equally mature by language:

- `static-witness-adapter.ts` is Python-only by design
- `diff-touched-symbols.ts` is Python + JS/TS best-effort
- Go is weaker here

This is acceptable, but it means "language support" is not one boolean. Repro, verifier, static witness, and symbol extraction mature at different speeds.

## Current Architecture: What Is Already Good

### 1. `repoLanguage` is carried as metadata, not re-guessed ad hoc

The ingest layer already carries:

- `repoLanguage`
- `dockerhubTag`
- `selectedTestFilesToRun`

through `SwebenchMeta`.

That prevents later surfaces from re-inferring language from repo names or file extensions.

Current head also now centralizes repo-language normalization in:

- `src/runner/batch/repo-language.ts`

That is the correct small seam: spelling/default policy should be shared even if higher-level language capabilities still differ by rail.

### 2. Unsupported languages fail closed

This is correct and should stay.

Examples:

- non-Python repro helper => `unsupported_language`
- non-Python Pro rows do not synthesize fake pytest grading

This prevents "generic" architecture from silently doing the wrong thing.

### 3. Artifact recognition is already centralized

Generated repro artifact naming is already being pushed into a leaf SSOT:

- `src/agent/repro-test/scaffold-patterns.ts`
- `src/runner/batch/eval/repro-artifacts.ts`

This is exactly the right pattern for polyglot growth. Adding a new language should update one leaf, not five duplicated regex sites.

### 4. Public verifier exposure is boundary-aware

`repo-local-verifier-command.ts` already distinguishes:

- hidden dataset-derived verifier
- public verifier safe to expose

That authority split must survive any polyglot expansion.

## Current Architecture: Where It Is Still Fragmented

### 1. Repro and public verifier are split into separate adapter systems

Today:

- repro language split lives in `repro-adapter.ts`
- public selected-test verifier split lives in `selected-test-files-verifier.ts`
- spelling/default normalization lives in `repo-language.ts`

This is better than full duplication, but language support status is still duplicated across two higher-level systems.

Consequence:

- a language can be "supported" in one rail and not the other
- rollout status becomes harder to reason about

### 2. Language capability is not surfaced as one typed matrix

Current head has several implicit capability dimensions:

- repro generation
- repro execution
- public verifier
- static witness
- symbol extraction
- LSP/nav quality

But these are not exposed through one typed capability model, so operator reasoning is still code- and doc-reading heavy.

### 3. JS/TS runner heterogeneity is still under-modeled

For JS/TS, `npm test -- <paths>` is only a narrow public verifier approximation.

Real repo diversity includes:

- jest
- vitest
- mocha
- karma
- project-specific wrappers

So JS/TS needs a stricter runner-adapter posture than Python or Go.

## Recommended Extensible Target Architecture

Do not replace the current seams. Tighten them into a more explicit structure.

### 1. Keep three orthogonal axes

The architecture should keep these as separate axes:

- `LanguageAdapter`
- `ExecBackend`
- `OracleSource`

Meaning:

- language chooses script/verifier semantics
- backend chooses where and how it runs
- oracle source chooses whether the signal is public, hidden, advisory, or grading-only

If these collapse into one switch, extensibility degrades quickly.

### 2. Treat repro and public verifier as sibling ports under one language capability

The useful target is not a monolith. It is one per-language capability owner with separate sibling ports, conceptually:

- repro port
- public verifier port
- artifact recognition port
- optional static witness port

That keeps one per-language authority without forcing one giant interface.

### 3. Keep official repo/version recipes in a separate spec authority

Do not let language adapters absorb:

- repo-version install commands
- framework runner specifics already present in the official spec

Those belong in:

- `repo-version-specs.ts`

Language adapters should compose with spec data, not shadow it.

### 4. Keep fail-closed defaults on every new language port

For any new language support:

- unsupported => explicit typed outcome
- unavailable runner => explicit typed outcome
- missing backend parity => stay off by default

This is more scalable operationally than broad best-effort auto-detection.

### 5. Add a typed language capability matrix

What is missing most is a simple typed capability summary, per language, for example conceptually:

- repro: `none | partial | full`
- publicVerifier: `none | selected-tests | full`
- staticWitness: `none | best_effort | full`
- issueSmoke: `none | full`

This should be derived from code later, not live only in docs.

## Per-Language Readout

### Python

Current status:

- strongest current lane
- repro adapter exists
- host env is materially hardened
- image backend seam exists but parity is not yet proven

Main next step:

- prove image parity and default to image for Python-Pro

### Go

Current status:

- public selected-test verifier path already exists
- repro adapter does not yet exist
- static witness and semantic support are weaker

Main next step:

- add a Go repro adapter around `go test -json`

Why Go is cleaner than JS/TS architecturally:

- execution surface is more uniform
- structured output is stronger
- selector semantics are already present in current head

### JS/TS

Current status:

- selected-test public verifier path exists, but is intentionally narrow
- repro adapter does not yet exist
- runner heterogeneity is the dominant complexity

Main next step:

- do not generalize with broad auto-detect
- use explicit allowlisted runners
- keep unsupported projects fail-closed

This is where extensibility discipline matters most. A fake "generic Node adapter" will rot quickly.

## Structural Fix Order

The current 8-case smoke is enough to rank likely blockers, but not enough to
freeze a strict sequential order.

Treat P0 and P1 as a **coupled first gate** to remeasure together:

- P0 raises the chance of getting a real base-red signal at all.
- P1 determines whether that signal actually improves repair convergence.

This matters because the repo-level Pro prior is still:

- `fail_to_pass median 1`
- thin public oracle
- best-of-N overfit risk if the signal is used as selection only

So for Python-Pro, "better breadth" is not the goal by itself. The goal is:

- get image-parity base-red when available
- feed that failure evidence back through the existing repair loop
- measure whether multi-file repair actually converges more often

### P0. Finish Python image repro parity

Goal:

- prove that image-backend repro executes against the **mounted patched sandbox**, not the image's stale checkout

Then:

- default Python-Pro repro to image backend when `dockerhubTag` exists

Primary code surfaces:

- `src/runner/batch/eval/repro-adapter.ts`
- `src/runner/batch/eval/repro-adapter.test.ts`
- `src/runner/batch/eval/driver.ts`

Required telemetry:

- backend used: `host | image`
- parity outcome: `proven | fallback`
- fallback reason

Why this remains one half of the first gate:

- without base-red, repair breadth and selection are mostly blind
- current smoke shows that blind rate is still too high

### P1. Promote validator-fed coordinated family coverage in the first path

Do not invent a new multi-file system.

Current head already has:

- fanout over widened owner surfaces
- family coverage derivation
- family coverage repair
- a bundled preset: `agentless-v7-oracle-multifile`

What is missing is proof that this path actually becomes the **default effective Python-Pro path**, rather than an optional side arm.

The critical point is not just wider location choice.

Current head already runs a real repair loop:

- `closure-repair`
- `repro-vote`
- `repair-strong-oracle`
- `repair-breadth`

and `repair-breadth` is not only outer best-of-N reranking. It fans out
multiple candidates **inside a repair round**, validates them, adopts the best
candidate, and continues the next round from that adopted state.

So for thin-oracle Python-Pro cases, P1 should be read as:

- improve multi-file repair convergence under validator feedback
- not merely "select more files" or "rerank more candidates"

Primary code surfaces:

- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/knobs/presets.ts`

Success criterion:

- higher `multi_file_full_coverage_rate`
- lower `multi_file_partial_overlap_rate`
- lower `repro_red_but_unresolved_rate`
- better resolved count on the same Python-Pro miss set

### P2. Harden measurement, not just rhetoric

For this lane, the operator summary should always surface:

- `owner_recall@1`
- `gold_coverage_rate`
- `multi_file_full_coverage_rate`
- `multi_file_partial_overlap_rate`
- `synth_repro_base_red_rate`
- `repro_red_but_unresolved_rate`

If those are not visible, flattering single-file narratives come back.

### P3. Keep selector/critic work secondary

Acceptance/regression plumbing already exists and is not the first Python-Pro blocker.

Do not spend the next cycle on:

- broader language generalization
- new critic layers
- selector-first redesign

until the coupled P0/P1 remeasurement has been run on Python-Pro.

### P4. Build outward from Python without changing the axis model

Once Python image parity is proven:

1. keep the same adapter/backend/artifact structure
2. add Go repro support on that structure
3. add JS/TS only through explicit runner contracts

The rollout should reuse the same architecture, not fork a second one.

## Recommended Next Experiment

Run Python-Pro only, in this order:

1. Enable and prove Python image repro parity.
2. Re-run the same 8-case smoke on current head with refreshed closure diagnostics.
3. Compare:
   - current baseline
   - `agentless-v6-oracle-hardened`
   - `agentless-v7-oracle-multifile`

Interpretation rule:

- do not treat `P0 -> P1` as settled doctrine from the current smoke alone
- use the refreshed 8-case results to decide whether image parity, validator-fed
  repair breadth, or only their combination actually moves Python-Pro

Pass condition:

- `synth_repro_base_red_rate` moves up materially
- `multi_file_partial_overlap_rate` moves down
- `repro_red_but_unresolved_rate` moves down
- resolved count improves without new hygiene regressions

## Bottom Line

- Python-Pro should stay first.
- The first real unlock is **image-backed Python repro parity**.
- The second real unlock is **making existing multi-file family coverage win in practice**.
- The extensible architecture is **not** "one generic polyglot runner".
- The extensible architecture is:
  - language-specific adapters
  - backend/runtime as a separate axis
  - spec/env authority kept separate
  - public-vs-hidden oracle boundaries kept explicit
- `owner_recall@1` is not the north-star.
- `cross_file_rate=null` in the smoke artifacts is stale instrumentation, not the core proof.
