# `tools/bench-promax` — the ProMax operator chain

Four steps, in order, each refusing rather than guessing. Nothing here launches a
run, resolves model/preset knobs, or writes a bench report — these are offline
provenance/preparation tools.

```
  fetch  ──▶  assemble  ──▶  verify  ──▶  prepare-corpus
 (manual)   assemble-bundle  verify-bundle   prepare-corpus
```

| step | tool | in | out |
|---|---|---|---|
| 1 fetch | *manual, see below* | upstream at a pinned commit | `~/.quanta/bench/promax-upstream/<commit>/` |
| 2 assemble | `assemble-bundle.ts` | fetched tree + in-repo manifest | a bundle dir in the validator's shape |
| 3 verify | `verify-bundle.ts` | bundle dir | `VERIFIED` + the manifest digest |
| 4 prepare | `prepare-corpus.ts` | verified bundle dir | public tasks, grader bundle, sample manifests |

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

---

## Related tools

- `freeze-images.ts` — PMX-04 image provenance receipts.
- `campaign-gates.ts` — PMX-06 campaign promotion gates.

## Where the logic lives

Every tool here is a thin shell. The manifest schema, the hashing, the bundle
layout, the assembly plan, and the verdict all live in one owner —
`src/apps/bench/promax/provenance/**` — so the operator tools and the bench
runtime cannot produce different verdicts for the same bytes.
