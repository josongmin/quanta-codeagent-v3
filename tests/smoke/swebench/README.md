# SWE-bench Verified — smoke baseline

A **frozen set of 6 SWE-bench Verified instances** used as a regression
reference point. These are picked to be deterministic, cheap, and reliable —
this is a *smoke gate*, not a capability sweep. The pick is grounded in the real
`princeton-nlp/SWE-bench_Verified` dataset and audited reproducibly by
[`select.ts`](./select.ts).

## The 6 picks

| instance_id | repo | gold file | patch | F2P | subsystem |
|---|---|---|---|---|---|
| `psf__requests-5414` | psf/requests | `requests/models.py` | 13L | 1 | HTTP 라이브러리 |
| `pallets__flask-5014` | pallets/flask | `src/flask/blueprints.py` | 14L | 1 | 웹 프레임워크 |
| `pylint-dev__pylint-4970` | pylint-dev/pylint | `pylint/checkers/similar.py` | 13L | 1 | 린터 |
| `pytest-dev__pytest-7982` | pytest-dev/pytest | `src/_pytest/pathlib.py` | 13L | 1 | 테스트 프레임워크 |
| `sympy__sympy-16886` | sympy/sympy | `sympy/crypto/crypto.py` | 13L | 1 | 수학 (crypto) |
| `sympy__sympy-13480` | sympy/sympy | `.../elementary/hyperbolic.py` | 13L | 1 | 수학 (functions) |

Frozen as official-upstream-shape rows in [`picks.jsonl`](./picks.jsonl) — the
exact JSONL `bench`'s `parseSwebenchJsonl` ingests.

## Selection criteria (why these)

A smoke target must clone+set-up fast, have an unambiguous **single-file** fix,
and a tiny **verifiable** test surface, so a recorded→replayed run is stable
run-to-run and a human can eyeball the gold patch in seconds. Filters applied to
all 500 Verified rows (194 are `<15 min fix`):

- `difficulty == "<15 min fix"` (easiest tier)
- gold patch touches **exactly 1 source file**
- gold patch **≤ 22 lines**
- `FAIL_TO_PASS` **≤ 2 tests**
- **light repo only** — `requests / flask / pylint / pytest / sympy`

**Deliberately excluded:** `scikit-learn`, `matplotlib`, `astropy`, `xarray`
(C-extension / heavy-numeric deps → slow, flaky env setup); `django` (pure-python
but slow setup — kept out of the light 6-pick tier). 28 other instances pass the
same criteria (`select.ts --audit` lists them) — these 6 are pinned for repo
diversity + smallest/clearest statements.

## Determinism model — what "통과" means here

The official FAIL_TO_PASS/PASS_TO_PASS grade is **only valid inside the official
`swebench.harness.run_evaluation` Docker harness**, which is environment-blocked
in CI, and a live LLM run is non-deterministic. So the always-pass CI gate is a
**recorded tier-0 replay** (same philosophy as the rest of `tests/smoke/`):

1. **Record (once, live, gpt-5):** run the real agent against each instance,
   capture the trajectory + the produced patch.
2. **Certify (once, offline):** feed the produced `predictions.jsonl` to the
   official Docker harness on a machine that has it; confirm the recorded patch
   actually resolves the instance. This is the ground truth that the recorded
   baseline is *correct*, not just *stable*.
3. **Gate (every CI run, deterministic, $0):** replay the recorded trajectory
   and assert the agent loop + tools reproduce the same patch. This catches
   loop / tool / harness **regressions** — not model capability drift.

> Baseline model: **gpt-5** (the current `just cli` default). The recorded
> trajectory *is* the baseline; re-record only when intentionally re-pinning.

## Workflow

```sh
# Audit the pinned picks against the live dataset (CI-safe; no clone/LLM):
bun run tests/smoke/swebench/select.ts --audit

# Re-pin: re-extract the pinned rows verbatim into picks.jsonl
bun run tests/smoke/swebench/select.ts --write

# (1) RECORD + (2) emit predictions for offline Docker certification — live, costs $:
QUANTA_LLM_PROVIDER=openai QUANTA_MODEL=gpt-5 \
  bun run bench --swebench tests/smoke/swebench/picks.jsonl \
  --predictions tests/smoke/swebench/predictions.jsonl \
  --report tests/smoke/swebench/bench-report.json

# single instance while iterating:
... bun run bench --swebench tests/smoke/swebench/picks.jsonl --instance sympy__sympy-16886

# (2) CERTIFY offline on a Docker-capable host (official grade):
QUANTA_SWEBENCH_PYTHON=1 bun run bench --swebench tests/smoke/swebench/picks.jsonl
```

## Status / next step

`picks.jsonl` + `select.ts` (frozen baseline + reproducible auditor) are landed
and the manifest parses cleanly through `bench`'s own loader. **Not yet done**
(needs an `OPENAI_API_KEY` + a one-time Docker-harness host): record the 6 gpt-5
trajectories, certify the patches offline, and wire the recorded-replay assertion
into the smoke battery as a CI gate. Until recorded, these are pending like any
other smoke scenario with a missing trajectory.
