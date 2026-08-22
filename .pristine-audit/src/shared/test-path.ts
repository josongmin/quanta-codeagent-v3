/**
 * Single source of truth for "is this path a test file/dir?".
 *
 * Two independent consumers must agree on this classification, so it lives in
 * `@/shared` (importable by both slices without crossing a boundary):
 *   1. `@/runner` bench patch sanitizer (`sourceOnlyDiff`) — strips test-file
 *      sections from a SWE-bench prediction (the official harness supplies its
 *      own gold `test_patch`).
 *   2. `@/agent` dispatch guard (`consultTestScope`) — denies a mutating tool
 *      that targets a test path during a bench run, so the agent cannot edit
 *      tests, chase its own modified tests, and regress an already-correct
 *      minimal fix (observed RCA 2026-06-19, django-13417: the agent wrote the
 *      gold guard, then edited tests 8× and regressed to a broken over-built
 *      version — mini/Live/OpenHands, which forbid test edits, kept the fix).
 *
 * PURE path-pattern matcher, no I/O. Matches on segment boundaries so a real
 * `latest/` dir or a `contest.py` file is NOT misflagged.
 */

/** Any path segment that is exactly `test` or `tests` (e.g. `a/tests/b.py`). */
const TEST_DIR_RE = /(^|\/)tests?\//i
/** A test FILE by conventional naming: `test_*`, `*_test`, or `conftest`. */
const TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.(py|js|ts|tsx)$/i

/** True iff `path` is a test directory member or a conventionally-named test
 *  file. Used by both the bench patch sanitizer and the dispatch test-scope
 *  guard so the two can never drift. */
export const isTestFilePath = (path: string): boolean =>
  TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path)
