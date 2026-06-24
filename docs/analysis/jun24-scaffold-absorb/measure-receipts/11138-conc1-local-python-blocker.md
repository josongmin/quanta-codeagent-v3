# 11138 local control arm (`concurrency=1`) — Python runtime blocker

Date: 2026-06-24

Command:

```sh
QUANTA_PREFS_HOME=/tmp/quanta-auth \
QUANTA_BENCH_HOME=/tmp/quanta-bench \
QUANTA_SWEBENCH_REPO_CACHE=/tmp/quanta-swebench-repo-cache \
QUANTA_BENCH_PRESET=agentless-v4-proof-clean \
QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY=1 \
QUANTA_SWEBENCH_PYTHON=1 \
  bun run src/apps/bench/index.ts \
  --swebench /tmp/frozen3.jsonl \
  --instance django__django-11138 \
  --predictions /tmp/11138-conc1-predictions.jsonl \
  --report /tmp/11138-conc1-report.json
```

Authoritative receipt:

- observe:
  `/tmp/quanta-bench/runs/run-1782307202886/observe/run-1782307202886/django__django-11138.0.jsonl`

Non-authoritative / stale-attempt artifact:

- `/tmp/11138-conc1-report.json`
  - this is from the earlier sandboxed clone-fail attempt, not the later live control run

Verified facts from the observe trace:

1. The control arm reached a real source edit.
   - line 84: `django/db/backends/mysql/operations.py: Replaced 1 occurrence(s)`
2. The first repro command failed in the local Python runtime.
   - line 91: `uv run ... python -s reproduce_issue.py`
   - error: `failed to allocate a guard page: Invalid argument (os error 22)`
3. The narrower repo-local Python test also failed at the environment boundary.
   - line 559: `python tests/runtests.py --settings=test_sqlite ...`
   - error: `PermissionError: [Errno 1] Operation not permitted`
   - stack reaches `ctypes` -> `_os.uname()`
4. Therefore this run is not a clean `concurrency=1` control receipt for the
   capture-desync hypothesis. It is a local Python execution blocker.

Implication:

- The old claim "`concurrency=1` proves lost-edits=0" is still unpinned in the repo.
- The next local blocker to clear is Python execution/runtime behavior, not fork capture.
