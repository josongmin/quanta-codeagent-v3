---
task: constraints-scheduling
category: personal-assistant
difficulty: medium
tags: [calendar, scheduling, constraint-satisfaction, ics-parsing, temporal-reasoning]
expert_min: 15
junior_min: 30
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/constraints-scheduling:20251031
---

# constraints-scheduling

**Goal** — Parse three read-only ICS calendars (Alice/Bob/Carol, Jan 15-19 2024) and find the **earliest** 1-hour slot satisfying each person's hard availability constraints (per-person time windows, Tue/Thu leave-by rules, Carol's lunch + late-meeting 15-min buffer) with no conflicts against existing events. Write `/app/meeting_scheduled.ics` with a valid VEVENT for all three attendees. Preference tie-breakers: avoid Carol's Monday, prefer Alice's morning; input files must stay byte-identical.

**Solution shape** — Bash wrapping a Python heredoc. Regex-extracts DTSTART/DTEND from VEVENT blocks, encodes each person's hard windows in `satisfies_preferences`, overlap check in `is_time_available`, scores tie-break prefs in `get_preference_score`, scans Jan 15-19 business hours in 30-min steps, sorts by (−score, time), emits an ICS with the winning slot. One script; produces one ICS file. (Note: the reference scans at 30-min granularity while the verifier evaluates earliest at *minute* granularity — a latent mismatch, though the dataset is constructed so a valid morning slot exists on a 30-min boundary.)

**Verifier** — pytest: input calendars unmodified; output is valid ICS (BEGIN/END VCALENDAR, VERSION, PRODID, a VEVENT); the scheduled slot satisfies all hard constraints and conflicts with none; is the earliest at minute granularity; obeys the Monday-avoidance tie-break when alternatives exist; falls in Alice's 9-12 morning; and respects Carol's late-buffer rule. reward binary 0/1.

**Difficulty drivers** — Pure constraint-satisfaction / temporal reasoning: many overlapping hard rules plus ordered soft preferences, edge cases around lunch breaks, buffers, and weekday-specific cutoffs. Getting *the earliest* valid slot (not just *a* valid slot) and the tie-break ordering right is the crux. Env is trivial (stdlib only) — this is a coding puzzle that happens to run in a terminal.

**quanta attack points** — `container_exec` one-shot write-and-run; ICS output is fully exit-code checkable, so the iterate-until-tests-pass loop drives it well. Main risk is subtle constraint misreads (buffer direction, minute vs 30-min granularity, tie-break precedence) yielding a valid-but-not-earliest slot. No interactive tooling; `terminal_native` is low — it's essentially a Python authoring task.
