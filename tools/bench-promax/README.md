# `tools/bench-promax` — the ProMax operator chain

Five steps, in order, each refusing rather than guessing. Steps 1–4 are offline
provenance/preparation tools: they launch no run and resolve no model/preset
knobs. Step 5 is the one that executes something — the pinned evaluator.

```
  fetch  ──▶  assemble  ──▶  verify  ──▶  prepare-corpus  ──▶  run-gate
 (manual)   assemble-bundle  verify-bundle   prepare-corpus     run-gate
```

| step | tool | in | out |
|---|---|---|---|
| 1 fetch | *manual, see below* | upstream at a pinned commit | `~/.quanta/bench/promax-upstream/<commit>/` |
| 2 assemble | `assemble-bundle.ts` | fetched tree + in-repo manifest | a bundle dir in the validator's shape |
| 3 verify | `verify-bundle.ts` | bundle dir | `VERIFIED` + the manifest digest |
| 4 prepare | `prepare-corpus.ts` | verified bundle dir | public tasks, grader bundle, sample manifests |
| 5 run a gate | `run-gate.ts` | pinned checkout + campaign golden | `~/.quanta/bench/promax-campaign/<campaign id>/` — `gate-receipt.json` + the gate verdict |

Steps 2 and 4 both re-run the step-3 validator internally, so a bundle can never
be consumed without being verified; step 3 is listed separately because it is
what an operator runs to *read* the provenance record.

The frozen v1 identity (commit, revision, hashes, counts) lives in
`src/apps/bench/promax/provenance/frozen-snapshot.ts`, and the manifest that
declares it lives in
`src/apps/bench/promax/provenance/manifests/promax-v1-170.manifest.json`.
No gold-bearing byte is in git — every file below step 1 is an operator artifact.

---

## 1 — fetch (still manual)

There is **no fetch tool in this repo**. The v1 tree was fetched by hand on
2026-08-22 and re-verified against the frozen snapshot. Its layout is:

```
~/.quanta/bench/promax-upstream/<40-hex-commit>/
  commit.json                  # GitHub commit object at the pinned sha
  tree.json                    # GitHub tree listing at that sha
  gh/swe-bench-promax.json     # blob at data/swe-bench-promax.json
  gh/eval.json                 # blob at data/eval.json
  gh/test_run.py               # blob at src/evaluation/test_run.py
  hf/rev.json                  # Hugging Face revision record
  hf/swe-bench-promax.json     # HF copy at the pinned revision
  hf/eval.json                 # HF copy at the pinned revision
```

Rules that make step 2 possible:

- fetch **only** at a pinned 40-hex commit / revision — never `main`, a tag, or
  an abbreviated sha (`requirePinnedCommit` refuses those everywhere else);
- keep **both** copies. The GitHub and Hugging Face data files must be
  byte-identical; that comparison is the check which refuses an untracked
  GitHub-commit / HF-revision hybrid. Dropping the `hf/` files does not weaken
  the verdict quietly — assembly refuses outright;
- the `gh/` and `hf/` file **names** are the basename of the upstream path the
  manifest declares (`data/eval.json` → `eval.json`). The assembler derives them
  from the manifest, so it never has to guess a layout.

## 2 — assemble

```sh
bun run tools/bench-promax/assemble-bundle.ts \
  --upstream-root ~/.quanta/bench/promax-upstream/<commit> \
  --bundle-root   ~/.quanta/bench/promax-bundle/<label>     # must be fresh
  # --manifest <path>   optional; defaults to the in-repo v1 manifest
```

Turns the fetched tree into the six-file shape the validator reads:

```
manifest.json  dataset.json  eval.json  evaluator.py  hf/dataset.json  hf/eval.json
```

It **refuses** — and writes nothing at all — when:

- a file the bundle is made of is missing from the fetched tree
  (`source_absent`, named);
- fetched bytes do not hash to the sha256 the manifest declares
  (`source_hash_mismatch`, both hashes printed). Every byte is hashed *before*
  anything lands, so an assembled bundle cannot be wrong-by-copy;
- the destination already holds bytes (`destination_not_empty`). Assemble into a
  fresh directory, or remove the old one deliberately — the tool will not merge
  two bundles into one that still looks `VERIFIED`;
- the manifest is not a manifest (`manifest_invalid`, field named).

Success prints every file with its sha256, the source it came from, and the
manifest field that declared the hash, then the exact `verify-bundle` command to
run next.

## 3 — verify

```sh
bun run tools/bench-promax/verify-bundle.ts \
  --bundle-root  ~/.quanta/bench/promax-bundle/<label> \
  --head-commit  <40-hex sha of the upstream checkout> \
  [--attached-ref <ref>]     # ONLY if the checkout is NOT detached
```

`--head-commit` is the sha the upstream tree was fetched at — it is the `sha`
field of `commit.json`, and the directory name of the fetched tree. Omitting
`--attached-ref` asserts a detached checkout; a campaign may not run from a
branch, because a branch can move mid-run.

Prints `VERIFIED` plus the manifest digest and instance count, or `REFUSED` with
every failure at once. The approved-snapshot set is **not** a CLI flag: a
self-consistent manifest for some other upstream commit is refused until a human
re-freezes and approves it.

## 4 — prepare corpus

```sh
bun run tools/bench-promax/prepare-corpus.ts \
  --bundle-root  ~/.quanta/bench/promax-bundle/<label> \
  --head-commit  <40-hex sha> \
  --agent-root   ~/.quanta/bench/promax-agent/<label> \
  --grader-root  ~/.quanta/bench/promax-grader/<label> \
  [--samples-out ~/.quanta/bench/promax-samples/<label>] [--seed <seed>]
```

Verifies the bundle again, then splits it into the two artifacts:
`--agent-root` receives **only** `public-tasks.json` (no gold), `--grader-root`
receives `grader-bundle/`. `--grader-root` must **not** be inside `--agent-root`;
the writer refuses an overlapping layout before writing anything.

## 5 — run a gate

```sh
bun run tools/bench-promax/run-gate.ts \
  --campaign     <campaign id> \
  --pinned-root  <verified upstream checkout> \
  --golden       <campaign-golden.json> \
  --work-dir     <output directory> \
  --python       <dedicated interpreter, Python ≥3.10> \
  [--ids a,b,c]                # default: every instance in the golden file
```

Runs **Gate 1, the gold sentinel**: it submits a deterministic, campaign-unique
patch that *cannot apply* and requires every instance to come back
`model = apply_failed, golden = success`. That proves the reference patch passes
in every selected image without the evaluator's model/golden promotion making the
preflight vacuous. It spends **no model tokens**.

The order is the contract — everything before the spawn can refuse, and refusing
there means no process ever started:

```
verify pinned hashes ─▶ build sentinel predictions ─▶ build argv
  ─▶ mint evaluator identity ─▶ SPAWN ─▶ read output ─▶ receipt ─▶ gate ─▶ persist
```

It **refuses** when:

- the staged `src/evaluation/test_run.py` or `data/eval.json` does not hash to the
  frozen pin (`evaluator_sha256_mismatch` / `eval_meta_sha256_mismatch`), or is
  absent (`*_file_absent`). A gate that runs an unverified evaluator is not
  evidence, so this happens **before** anything is spawned;
- a required flag is absent — no campaign path is ever guessed;
- the six-field evaluator identity cannot be built from real values
  (`identity_incomplete`). Placeholders are never substituted: the receipt layer
  refuses incomplete metadata (`evaluator_meta_invalid`) precisely so a receipt
  stays replayable.

A crashed evaluator, an absent output file, a non-zero exit, or a drifted schema
are **not** refusals — they are graded as infrastructure
(`evaluator_unavailable` / `evaluator_no_output` / `evaluator_nonzero_exit` /
`schema_invalid`), never as a model failure and never as `missing`.

Artifacts land in `--work-dir`: `preds.json`, `pass-rate.json`, and
`gate-receipt.json`. **The receipt is written even when the gate FAILS** — that is
the run an operator most needs the evidence for. Exit is `0` only on a passing
gate.

**Point `--work-dir` at `~/.quanta/bench/promax-campaign/<campaign id>/`.** Steps
1–4 each name a durable root; step 5 takes an operator-chosen directory, and that
asymmetry has already cost evidence once — the aug-23 Gate 1 receipt was written
to a session scratch directory and survived only by being copied out before the
directory was reaped. The gate receipt is the campaign's *authoritative* record:
PMX-06's gates are pure predicates over landed receipts, so a reaped receipt is a
gate that has to be re-run, images and all. A temp directory is not a work-dir
for this step.

`--python` must be a dedicated interpreter of **Python ≥3.10**: the pinned
evaluator uses PEP 604 (`int | None`) in an annotation, and on 3.9 it dies at
**import** with

```
TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
```

— a traceback pointing at the evaluator's own source, which reads like a broken
grader rather than a wrong interpreter.

It is a **TypeError, not a SyntaxError** (this page said otherwise until it was
measured on 3.9.6 against the pinned `test_run.py`, sha256 `af2ee720…`). The
module parses and compiles cleanly; the annotation is only evaluated at import.
So no syntax check can catch this — **only the version can**, which is why
`run-gate.ts` checks the interpreter before spawning anything.

Evaluator concurrency is deliberately **not** a flag — it stays at the pinned
`--workers 1` until a measured concurrency campaign changes it at the owner.

---

## Related tools

- `freeze-images.ts` — PMX-04 image provenance receipts.
- `campaign-gates.ts` — PMX-06 campaign promotion gates.

## Where the logic lives

Every tool here is a thin shell. The manifest schema, the hashing, the bundle
layout, the assembly plan, and the verdict all live in one owner —
`src/apps/bench/promax/provenance/**` — so the operator tools and the bench
runtime cannot produce different verdicts for the same bytes.
