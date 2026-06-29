# RFC: Polyglot repro adapter + exec backend (jun-29)

**Status**: design + phased implementation. Narrow workstream (split out of
[jun-29-swe-benchmark-platform](../jun-29-swe-benchmark-platform/README.md) §"multi-language repro rail").

## Problem (evidence-grounded)

The repro-test rail is **Python/pytest-only from generation through execution to outcome
parsing**, so for a non-Python instance it produces ZERO self-verification signal, and the
agent submits with no execution feedback on its own patch.

Measured (Pro 5-run, gpt-5.5): every genuine miss had its repro `execFailure: "infra_unavailable"`:
- **NodeBB (JS)**: `reproRunArgv` → `uv run --with pytest … python -s <script>` → `× …does not
  appear to be a Python project` (uv has no pyproject/setup.py to resolve). No JS runner exists.
- **qutebrowser (Python)**: `ERROR: Missing required plugins: pytest-qt, pytest-mock, pytest-bdd…`
  — the `uv --with pytest` env lacks the repo's TEST extras → pytest collection aborts.

Root, in code:
- SSOT command is Python: `reproRunArgv` ([dataset.ts:326](../../../src/runner/batch/corpus/dataset.ts#L326)) = `uv … --with pytest … python -s <script>`.
- Executor is a `python <path>` → pytest bridge with a `.pytest-report.json` sidecar verdict
  ([execute.ts](../../../src/agent/repro-test/execute.ts), [repro-command.ts:15](../../../src/runner/batch/eval/repro-command.ts#L15)).
- Generation emits a pytest `.py` ([generate.ts](../../../src/agent/repro-test/generate.ts)).
- The `.py` basename/sidecar is **hard-coupled** across hint, snapshot-strip, artifact-filter,
  hygiene, anchor-synth (see Blast radius). `repoLanguage` is carried to `Instance.swebench`
  ([types.ts:39](../../../src/runner/batch/types.ts#L39)) but **never reaches the repro rail**.

`fail_to_pass` is NOT a fix: those tests are held-out (applied by `test_patch` at grade time);
running them = leaderboard-gaming. The legitimate lever is making the agent's OWN repro
**executable** on the instance's language/env.

## Contract: `ReproAdapter`

```ts
interface ReproAdapter {
  language: "python" | "go" | "js" | "ts"
  scriptExt: string                              // ".py" | "_repro_test.go" | ".test.mjs"
  scriptBasename(seq: number, uuid: string): string
  artifactPatterns: RegExp[]                      // script + sidecar basenames (hygiene/strip/filter SSOT)
  buildExecArgv(ctx: ReproExecCtx): readonly string[]      // replaces reproRunArgv per-language
  buildValidationCmd(ctx: ReproExecCtx): string            // replaces reproValidationCmd
  parseEvidence(r: { stdout; stderr; code; sidecarPath }): ReproTestOutcome // replaces classifyPytest
}
```
`ReproExecCtx = { repo, version, repoLanguage, scriptPath, sandboxDir, execBackend }`.

`resolveReproAdapter(instance)` picks by `instance.swebench.repoLanguage` (default `python`).
**Unsupported language ⇒ fail-closed** (explicit `unsupported_language` outcome, never a silent
pass and never a fake pytest attempt).

## Exec backend (orthogonal to language)

`buildExecArgv` targets a backend:
- `host` (today): uv venv on the box. Python-only-correct; deps gap is the qutebrowser class.
- `image` (new): exec inside the instance's prebuilt Docker image (swebench / jefzda Pro image)
  — the env already has the correct toolchain + all test deps + matches the GRADE env (kills
  the missing-plugin + wrong-base classes at once). `before_repo_set_cmd` is a Scale
  *in-image* step, NOT a host substitute, so image backend is how Pro repros get a real env.

## Blast radius (must thread together — NOT just execute.ts)

| touchpoint | file | what couples |
|---|---|---|
| repro exec wiring | [driver.ts:1813](../../../src/runner/batch/eval/driver.ts#L1813) | injects `reproRunArgv(repo,version,path)` |
| executor + verdict | [execute.ts:142](../../../src/agent/repro-test/execute.ts#L142) | `buildArgv` default + `classifyPytest` |
| repro vote | [repro-vote.ts:176](../../../src/runner/batch/eval/repair/repro-vote.ts#L176) | outcome consumption |
| resolved consensus | [resolved-consensus.ts:45](../../../src/runner/batch/eval/repair/resolved-consensus.ts#L45) | outcome consumption |
| artifact filter (SSOT) | [repro-artifacts.ts](../../../src/runner/batch/eval/repro-artifacts.ts) | `.py`/`.pytest-report.json` basename RE |
| snapshot strip | [snapshot.ts:88](../../../src/runner/batch/eval/snapshot.ts#L88) | `.pytest-report.json` sidecar strip |
| hint | [driver.ts:1651](../../../src/runner/batch/eval/driver.ts#L1651) | repro scaffold naming |
| patch hygiene | [patch-hygiene.ts:16](../../../src/agent/closure/patch-hygiene.ts#L16) | `.py` repro exclusion from submitted diff |
| anchor synth | [anchor-synth.ts:48](../../../src/agent/mention-injection/anchor-synth.ts#L48) | `.py` repro anchor |

`artifactPatterns` on the adapter becomes the SSOT these consume (no scattered `.py` regexes).
Fixing `execute.ts` alone breaks contamination/hygiene — the whole set threads in one change.

## Phasing (strict order)

1. **Python adapter, byte-identical** — extract today's pytest behavior behind `ReproAdapter`
   (default = python), thread `artifactPatterns` through all blast-radius sites. ZERO behavior
   change; guarded by existing repro tests + a byte-identical snapshot. *Freezes the seam.*
2. **`image` exec backend, Python parity** — run the Python adapter inside the instance Docker
   image; prove parity vs host on a Python instance; this alone fixes the qutebrowser
   missing-plugin class.
3. **Go adapter** — `go test -json` (cleanest authority surface: structured, single runner).
4. **JS/TS adapter** — explicit closed allowlist of runners (mocha/jest); anything else
   `unsupported_language` fail-closed (JS runner heterogeneity is too wide to auto-detect).

best-of-N + regression-set feed are a **multiplier AFTER** a live reproducing set
([oracle-first RFC](../jun-28-oracle-first-fail-closed-rfc.md) enforces this order: reranking an
empty oracle just re-scores nothing).

## Phase 2 RCA — image-ref must be DISCOVERED, not reconstructed

Running the repro `image` backend needs the instance's Docker image reference. RCA of the live
images shows two cases:
- **Pro** is CLEAN: `jefzda/sweap-images:<dockerhub_tag>` — `dockerhubTag` is carried verbatim
  on the instance + verified pullable. `proReproImageRef()` builds it directly + is unit-tested.
- **Verified/Live** swebench eval images are swebench-INTERNAL + mangled: e.g.
  `starryzhang/sweb.eval.x86_64.matplotlib_1776_matplotlib-27613:latest` — the `__`→`_1776_`
  encoding + arch token + namespace are the harness's own scheme. Reconstructing that here would
  duplicate + drift from `swebench`'s encoding. So those refs are **discovered** (the grading
  harness already pulls them; `docker images` / the harness's resolved name) and injected via
  `ReproExecCtx.imageRef` — NOT rebuilt. `proReproImageRef` returns `null` for them.

**Phase 2a (landed, static/punchcard-clean)**: the pure seam — `ReproExecBackend` on
`ReproExecCtx`, `dockerRunReproArgv` (`docker run --rm` of plain `python -s` IN the image, NO
`uv --with` — that env-bootstrap is the host-only failure), `proReproImageRef`, reuse of
`classifyDockerStderr` for infra outcomes. Default `host` ⇒ byte-identical. Unit-tested, no live
Docker. **Phase 2b (runtime-gated, deferred)**: wire backend selection + eval-image discovery
into the driver + prove Python parity inside the image on a box (the expensive step punchcard
defers until a box is in hand).

## Invariants
- DEFAULT (python) path byte-identical — every existing Pro/Live/Verified run unchanged.
- No-leak preserved: repro uses ONLY the agent-side validator, never gold / never `test_patch`.
- Unsupported language fail-closed (never silent pass, never fake pytest).
