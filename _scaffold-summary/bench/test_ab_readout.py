"""Hellgate RED→GREEN for the repro-vote A/B readout.

The trap (user memory jun-19-repro-vote-and-theater-class): `*_false_red_rate` is NOT
arm-comparable — the vote arm doesn't EMIT the observation, so it reads ~0 not because
the oracle improved but because it isn't measured. So the readout must be:
  (1) resolved flips (baseline FAIL → arm PASS), the only ground-truth signal, and
  (2) per-instance oracle-decision change (was a patch rejected by the oracle in
      baseline now accepted in the arm — i.e. did vote actually flip a verdict),
NEVER a cross-arm false_red_rate diff.

These tests pin that logic so we read the running A/B correctly instead of by vibe.
"""
import ab_readout as ab


def _inst(id, passed, resolved_oracle, turns=40):
    return {"id": id, "passed": passed,
            "selection": {"resolvedOracle": resolved_oracle}, "turns": turns}


def test_resolved_flips_counts_fail_to_pass_only():
    base = [_inst("a", False, False), _inst("b", True, True), _inst("c", False, False)]
    arm = [_inst("a", True, True), _inst("b", True, True), _inst("c", False, False)]
    r = ab.compare(base, arm)
    assert r["flips_to_pass"] == ["a"], r
    assert r["flips_to_fail"] == [], r
    assert r["net_resolved_delta"] == 1, r


def test_regression_flip_to_fail_is_flagged():
    base = [_inst("a", True, True)]
    arm = [_inst("a", False, False)]
    r = ab.compare(base, arm)
    assert r["flips_to_fail"] == ["a"], r
    assert r["net_resolved_delta"] == -1


def test_oracle_decision_change_when_reject_becomes_accept():
    # baseline oracle rejected a's patch (resolvedOracle False) though instance failed;
    # arm oracle accepts it (True). That's the vote flipping a verdict — the real signal.
    base = [_inst("a", False, False)]
    arm = [_inst("a", True, True)]
    r = ab.compare(base, arm)
    assert "a" in r["oracle_now_accepts"], r


def test_false_red_rate_is_never_in_output():
    base = [_inst("a", False, False)]
    arm = [_inst("a", False, False)]
    r = ab.compare(base, arm)
    assert not any("false_red" in k or "red_but_unresolved" in k for k in r), \
        f"false-red metric must not be arm-compared: {list(r)}"


def test_missing_instance_in_one_arm_is_skipped_not_crash():
    base = [_inst("a", False, False), _inst("b", False, False)]
    arm = [_inst("a", True, True)]   # b missing
    r = ab.compare(base, arm)
    assert r["compared"] == ["a"], r
    assert "b" in r["only_in_baseline"], r


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    p = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); p += 1
        except Exception as e:
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}"); traceback.print_exc()
    print(f"\n{p}/{len(fns)} passed")
