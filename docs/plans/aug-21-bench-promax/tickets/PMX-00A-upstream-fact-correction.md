# PMX-00A — upstream fact correction (evidence-backed)

**Status:** VERIFIED against the pinned bundle on 2026-08-22

**Supersedes:** two claims in [README.md](./README.md) §"Upstream evaluator facts
that shape this plan"

**Evidence root:** `~/.quanta/bench/promax-upstream/77041028bc4e2135644b63b504aa961a68aafbb6/`
(fetched by PMX-00; all three file SHA-256s independently re-computed and matching
the frozen snapshot).

## What the README claims

> - can promote equal model/golden stdout, stderr, and reason to `SUCCESS` when no
>   timeout or model apply error was recorded;
> - exposes `SUCCESS`, `APPLY_FAILED`, `TEST_PATCH_APPLY_FAILED`, `TIMEOUT_APPLY`,
>   `TIMEOUT_EVAL`, `NON_ZERO_EXIT`, and `NEED_HUMAN_REVIEW`;

## What the pinned code actually does

Both promotions are **dead code at this pin** with respect to the emitted
`pass_rate.json`.

`_process_one_instance` assigns the promotion into the **local** `m_reason` /
`g_reason` variables:

```python
308    if not timeout_at and not apply_fail:
309        if is_match:
310            m_passed = True
311            g_passed = True
312            m_reason = "SUCCESS"
313            g_reason = "SUCCESS"
314        elif g_reason != "SUCCESS" and m_reason == g_reason:
315            m_reason = "NEED_HUMAN_REVIEW"
316            g_reason = "NEED_HUMAN_REVIEW"
```

It then builds the emitted payload from the **unmutated** `m_res` / `g_res`
dictionaries, and `_to_result_info` reads `info.get("reason")` — the original
value, not the promoted local:

```python
319    model_info = (m_res if m_res else {...})
324    golden_info = (g_res if g_res else {...})
329    model_parsed  = _to_result_info(model_info,  m_err or "")
330    golden_parsed = _to_result_info(golden_info, g_err or "")
331    passed = model_parsed["final_result"] == "success" and golden_parsed["final_result"] == "success"
```

Static confirmation: across all 24 occurrences of `m_res` / `g_res` in the file
there is **no subscript assignment and no `.update()`** — every occurrence is a
read.

## Consequences

1. **`need_human_review` is unreachable in `final_result` at this pin.**
   `analyze_test_output` returns only `SUCCESS`, `APPLY_FAILED`,
   `TEST_PATCH_APPLY_FAILED`, `NON_ZERO_EXIT`; `_execution_info` adds only
   `TIMEOUT_APPLY` and `TIMEOUT_EVAL`. `NEED_HUMAN_REVIEW` exists *only* inside
   the dead block.
2. **`passed` carries zero independent information** — line 331 recomputes it
   from the two parsed `final_result` values. The README is still right that it
   must never be trusted alone, but for a different reason: it is redundant, not
   merely lossy.
3. **The equal-output hazard to the gold sentinel is doubly guarded at this pin.**

## Decision — keep the defensive design anyway

PMX-03 implements the full `ambiguous` path and the gold-sentinel gate **as if
the promotion were live**. Rationale: upstream advertises a v2, and a *fixed*
upstream must not silently turn our gold preflight vacuous. The sentinel gate
fires `model_not_apply_failed` if a future pin ever promotes the sentinel to
success. This is a deliberate cost paid for pin-drift safety, not dead code on
our side.

Do **not** "simplify" by deleting the ambiguous path because it is unreachable
today. That reachability is a property of the pinned commit, and PMX-00's
manifest is what makes the pin auditable.

## Additional upstream facts discovered (all pinned by PMX-03 tests)

- The 7-state list is incomplete as an **output** schema. `_to_result_info` has an
  unlisted fallback: an unmapped reason becomes `reason.lower().replace(" ", "_")`,
  and an absent reason becomes the literal `"not run"`. Both must fall through to
  `infra_invalid / schema_invalid` (fail closed).
- `"non zero exit"` really contains **spaces** while the other six states use
  underscores. It is a load-bearing literal; normalizing it stops matching upstream.
- A prediction whose `instance_id` is absent from the golden file is silently
  `continue`d — **no row is emitted**. This lands as coverage-derived `missing`,
  which validates the derivation rule (`assigned - keys(dispositions)`) rather
  than contradicting it.
- An **empty** `model_patch` applies cleanly under `git apply` (rc 0), so upstream
  reports `NON_ZERO_EXIT`, not `apply_failed`. This is precisely why the gold
  sentinel must be a non-empty, guaranteed-non-applying hunk rather than an empty
  patch.
- `run_single_patch` runs the eval phase even after a failed apply, so an
  apply-failed row's stdout/stderr belong to the *eval* script. Relevant to PMX-04
  sentinel proofing; no effect on classification.

## Rail

If a future re-freeze changes `test_run.py`, this correction must be re-derived,
not assumed. The PMX-00 stop rule applies: produce a reviewable manifest diff
instead of refreshing hashes in place.
