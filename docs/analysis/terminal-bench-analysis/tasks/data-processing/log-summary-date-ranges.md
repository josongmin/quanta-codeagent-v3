---
task: log-summary-date-ranges
category: data-processing
difficulty: medium
tags: [log-analysis, report-generation, data-processing]
expert_min: 75
junior_min: 150
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/log-summary-date-ranges:20251031
---

# log-summary-date-ranges

**Goal** — Parse all log files in `/app/logs` (named `YYYY-MM-DD_<source>.log`) and count ERROR/WARNING/INFO severities across five date windows (today, last 7d, last 30d, month-to-date, total) relative to a fixed reference date 2025-08-12. Emit `/app/summary.csv` with a 15-row `period,severity,count` table.

**Solution shape** — Pure bash. Installs grep/coreutils, then a `count_severity_in_range` helper converts filename dates and window bounds to Unix timestamps via `date -d`, iterates files with `find -print0`, and `grep -c "[$severity]"` accumulates counts per window. Computes window start dates with `date -d "$CURRENT_DATE -6 days"` etc.; total via `grep -r | wc -l`. Single script, no extra files produced beyond the CSV.

**Verifier** — pytest: file exists, header exactly `period,severity,count`, exactly 15 rows, and every row matches a hard-coded expected count (e.g. `today,ERROR,370` … `total,INFO,56621`). Exact-value match. reward binary 0/1.

**Difficulty drivers** — Date arithmetic edge cases (inclusive windows, month boundary), correct severity-token matching against the `[LEVEL]` log format, and exact count reproduction — a single off-by-one in a window boundary fails all dependent rows. Data volume (tens of thousands of lines) but no heavy compute.

**quanta attack points** — `container_exec` fits: each build-count-diff step is one-shot with a checkable CSV output. Main risk is silently wrong date-window math (grep succeeds but counts drift). The exit-code "iterate until tests pass" loop helps only weakly — the verifier's hard-coded totals aren't visible, so the agent must derive windows correctly rather than fit to the check.
