"""Hellgate RED → GREEN for line-level localization scoring in localize_score.py.

The file-level scorer can't tell "right file, wrong function" (intra-file miss) from
"right file, right place". django-11951 / sympy-17655 are exactly that class: gold
edits one method, our patch edits a different method 300-740 lines away — file EXACT,
line MISS. These tests pin the line-level behavior so the claim is measurable, not
hand-asserted on 3 instances.

Run: python3 -m pytest _scaffold-summary/bench/test_localize_score.py -q
(or: python3 _scaffold-summary/bench/test_localize_score.py)
"""
import localize_score as ls


def _patch(file: str, old_start: int, old_count: int) -> str:
    """Minimal unified diff touching `file` at old-side line range."""
    return (
        f"diff --git a/{file} b/{file}\n"
        f"--- a/{file}\n+++ b/{file}\n"
        f"@@ -{old_start},{old_count} +{old_start},{old_count} @@\n"
        f"-old line\n+new line\n"
    )


def test_hunks_from_patch_parses_old_ranges():
    h = ls.hunks_from_patch(_patch("a/b.py", 1209, 7))
    assert h == {"a/b.py": [(1209, 1215)]}, h


def test_intra_file_miss_when_same_file_disjoint_lines():
    # gold edits lines 1209-1215; ours edits 470-475 in the SAME file → MISS_INTRA
    gold = _patch("django/db/models/query.py", 1209, 7)
    ours = _patch("django/db/models/query.py", 470, 6)
    v = ls.verdict_line(ours, gold)
    assert v == "MISS_INTRA", v


def test_hit_line_when_ranges_overlap():
    gold = _patch("x.py", 100, 10)   # 100-110
    ours = _patch("x.py", 105, 4)    # 105-109 ⊂ → overlap
    assert ls.verdict_line(ours, gold) == "HIT_LINE", ls.verdict_line(ours, gold)


def test_miss_file_when_wrong_file():
    gold = _patch("right.py", 10, 2)
    ours = _patch("wrong.py", 10, 2)
    assert ls.verdict_line(ours, gold) == "MISS", ls.verdict_line(ours, gold)


def test_empty_when_no_patch():
    gold = _patch("x.py", 10, 2)
    assert ls.verdict_line("", gold) == "EMPTY"


def test_overlap_pad_tolerates_adjacent():
    # adjacent within pad (gold 100-110, ours 112-114, pad=10) → still HIT_LINE
    gold = _patch("x.py", 100, 10)
    ours = _patch("x.py", 112, 2)
    assert ls.verdict_line(ours, gold, pad=10) == "HIT_LINE"


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
    print(f"\n{passed}/{len(fns)} passed")
