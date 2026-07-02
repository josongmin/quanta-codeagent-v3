---
task: regex-log
category: data-processing
difficulty: medium
tags: [regex, string-parsing, log-analysis]
expert_min: 45
junior_min: 180
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/regex-log:20251031
---

# regex-log

**Goal** — Author a single Python regex (saved to `/app/regex.txt`) that, via `re.findall(..., re.MULTILINE)`, captures the LAST `YYYY-MM-DD` date on every log line that also contains a valid IPv4 address, rejecting look-alikes (bad octets >255, month/day out of range, alphanumeric-adjacent tokens).

**Solution shape** — `solve.sh` just `cat`s one long regex into `/app/regex.txt`. No program is run. The pattern combines a lookahead asserting a boundary-delimited valid dotted-quad IPv4 with a capture group encoding per-month day ranges (30/31/29-Feb) plus `(?=$|[^0-9A-Za-z])` / `(?:^|[^0-9A-Za-z])` boundary guards. One file, ~1 line, pure regex craft.

**Verifier** — pytest: file exists, regex compiles, and `re.findall` over 26 hand-crafted log lines must return EXACTLY the 9 expected dates (order-sensitive, `matches == expected`). reward binary 0/1.

**Difficulty drivers** — Deep regex domain knowledge: IPv4 octet validation, calendar day-range encoding, MULTILINE anchoring, "last date on line" via greedy `.*`, and false-positive rejection with non-word boundaries. Exact-output matching against an adversarial test set — one wrong edge case fails all.

**quanta attack points** — Essentially a one-file authoring task; `container_exec` to write the file and run a quick `python -c` findall check. No interactivity, no `pty_*` needed. The scaffold's exit-code "iterate until tests pass" loop helps IF the agent reconstructs the test's edge cases locally; otherwise it's blind. Main risk: subtle regex bug on one of the 26 adversarial cases.
