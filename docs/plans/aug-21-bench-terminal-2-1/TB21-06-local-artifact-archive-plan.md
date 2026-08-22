# TB21-06 — local TB2.0 artifact archive plan (GATED, nothing executed)

**Ticket:** [TB21-06](./tickets/TB21-06-retire-2-0-and-refresh-smoke.md) — "Local artifact retirement"
**Manifest rows:** [TB21-00](./TB21-00-retirement-manifest.md) LA-1 … LA-6, governed by its §8
**Status:** **NOT EXECUTED.** Zero `rm`, zero `mv`, zero `mkdir` has run against any path below.
Every line here was produced by a **read-only** `os.stat` / `os.walk` resolution on
2026-08-22, and the gate that would authorise the move is **not met**.

## Why nothing moved

§8 step 1 is binding: *no archive/delete of any local artifact until the TB21-03 three-task
canary is green, and — for LA-1/LA-2 — until TB21-05 renders a 2.1 report in the dashboard.*

**There has been no paid 2.1 run.** No canary receipt exists, so the gate fails at step 1 and
every row stays where it is. Executing the move now would also destroy LA-3/LA-4 before they
have served their remaining purpose (see "What still depends on these" below).

## The independent fence, which IS in place

The ticket is explicit that archival is not the only defence: *"The new report parser
independently rejects them."* That guarantee is code, and it holds whether or not the files
ever move — proven against the **real bytes on disk**, not a fixture, in
`tests/unit/apps/bench/terminal/tb-2-0-retirement.test.ts`:

- `decodeCanonicalReport` refuses both artifacts at the canonical identity boundary
  (`canonical report identity: unknown datasetFamily "terminal-bench" (expected verified|live|pro|promax)`);
- `projectReport` refuses them too, so they create no dashboard run, no campaign and no score —
  they surface only as a **quarantine line naming the file**;
- a paired control proves a real 2.1 report is still accepted, so the refusals are specific
  rather than a projector that refuses everything.

## Exact targets, resolved read-only

| # | Path (literal, no glob) | Measured |
|---|---|---|
| LA-1 | `~/.quanta/bench/results/report-terminal-bench-baseline.report.json` | 10 292 B · mtime 2026-07-03T01:55:45 |
| LA-2 | `~/.quanta/bench/results/report-terminal-bench-levers.report.json` | 5 057 B · mtime 2026-07-03T02:29:04 |
| LA-3 | `~/.quanta/bench/tb-raw/full89/` — 5 job dirs: `2026-07-01__11-46-00`, `__14-08-06`, `__14-09-28`, `__15-10-16`, `__16-11-01` | part of 268 files / 813 534 B |
| LA-4 | `~/.quanta/bench/tb-raw/failset-levers/2026-07-02__16-18-06` | 1 job dir, same total |
| LA-5 | `~/tb-results/full89/` — 9 job dirs: `2026-07-01__17-22-33`, `__17-43-51`, `__17-45-15`, `__17-49-09`, `__17-49-53`, `__17-54-34`, `__19-07-33`, `__19-21-19`, `__19-25-28` | part of 198 files / 1 469 222 B |
| LA-6 | `~/tb-results/full89-brain-logs/` — 52 `brain-quanta-tb-*.stderr.log` | part of the same 198 / 1 469 222 B |

**Totals to move:** 2 report files (15 349 B) + `~/.quanta/bench/tb-raw` (268 files, 813 534 B)
+ `~/tb-results` (198 files, 1 469 222 B).

⚠️ **LA-7 is deliberately excluded.** `~/.quanta/bench/results/tmp__*` is ~3 680 files of SWE
test scratch that a case-insensitive `*tb*` glob matches by accident (`…-8RTBah`, `…-lp84Tb`).
It is **not** TB2.0 and must never be swept by this plan — which is exactly why every row above
is a literal path and the plan forbids globbing.

## What still depends on these (do not move early)

- **LA-3 / LA-4** are the only ground truth for the scorer-parity check against the numbers in
  LA-1/LA-2. Keep until TB21-04's writer has been shown to reproduce them, or until the 2.1
  canary makes that comparison moot.
- **LA-6** is brain stderr and **may contain prompt/response text**. Scan for credentials before
  it is copied anywhere off this machine. No secret may enter reports, logs, trajectories, docs
  or archives.

## The move, when the gate opens

Destination: `~/.quanta/bench/archive/tb-2-0/<UTC-YYYYMMDD-HHMMSS>/`, preserving the relative
path underneath, e.g.

```
~/.quanta/bench/archive/tb-2-0/20260822-000000/results/report-terminal-bench-baseline.report.json
~/.quanta/bench/archive/tb-2-0/20260822-000000/tb-raw/full89/2026-07-01__11-46-00/…
~/.quanta/bench/archive/tb-2-0/20260822-000000/tb-results/full89-brain-logs/…
```

**The destination sits outside every dashboard report root.** Verified against
`tools/leaderboard-dashboard/server.ts` `REPORT_ROOTS`, which scans
`$QUANTA_BENCH_RESULTS_DIR` (default `~/.quanta/bench/results`), `~/reprovote-ab`,
`~/easy-more`, `~/Library/quanta-codeagent-v3/bench`, `~/Library/quanta-codeagent-v3/bench-slices`
and any `--reports` argument. `~/.quanta/bench/archive/` is under none of them, so an archived
report cannot be re-scanned. (`~/.quanta/bench/tb-raw` and `~/tb-results` are not report roots
at all — they are raw job trees, moved for tidiness rather than for exclusion.)

Order of operations, all four steps required:

1. **Gate.** Green 2.1 canary; for LA-1/LA-2 also a 2.1 report rendered in the dashboard. A
   dirty-overlay canary does not count.
2. **Re-resolve read-only immediately before moving.** `ls -la <literal path>` /
   `find <root> -maxdepth 1`, printed and reviewed. Never a glob, never `-iname '*tb*'`, never
   `rm -rf` on a variable that could be empty.
3. **Move — never delete.** Write `MANIFEST.txt` in the timestamp directory recording source
   path, byte size and mtime for every moved file, then verify it against the sizes above.
4. **Permanent deletion is a separate, later, explicitly authorised act** — only after the
   archive exists and its manifest verifies, with targets named literally, one path per line,
   no wildcard. Nothing is deleted in the command that archives it.

## Recoverability

Everything above is a **move**, so recovery is a move back: the archive keeps the original
relative path under the timestamp directory, and `MANIFEST.txt` records the exact source path
plus size and mtime for each file. Nothing in this campaign deletes a local artifact.
