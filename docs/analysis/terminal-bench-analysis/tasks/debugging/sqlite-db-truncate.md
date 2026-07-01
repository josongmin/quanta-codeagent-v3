---
task: sqlite-db-truncate
category: debugging
difficulty: medium
tags: [file-operations]
expert_min: 60
junior_min: 240
skill_class: DEBUG-FIX
terminal_native: med
docker_image: alexgshaw/sqlite-db-truncate:20251031
---

# sqlite-db-truncate

**Goal** — `/app/trunc.db` is a SQLite DB corrupted by binary truncation (won't open normally). Recover as many `{word, value}` rows as possible and write them to `/app/recover.json` as `[{"word": "...", "value": N}, ...]`.

**Solution shape** — `solve.sh` heredocs `solve.py` that bypasses the `sqlite3` engine entirely: opens the file as raw bytes, scans for every `b"testword"` occurrence, slices the 2-digit suffix for the word, then reads the following 8 bytes and heuristically decodes the value — treating a `0x0f` second byte as a small integer serial type, else `struct.unpack('>d')` as an IEEE-754 double (filtered to plausible magnitudes). Dedups, sorts by word, dumps JSON. One ~90-line Python file; no external deps.

**Verifier** — pytest loads `/app/recover.json`, builds `(word,value)` tuple sets against 8 reference rows, and requires `>6` matches (i.e. ≥7/8). reward 0/1.

**Difficulty drivers** — Requires understanding SQLite's on-disk B-tree record format (serial-type varints, cell payloads) well enough to carve records manually since the file is unparseable by the library. Distinguishing integer vs float storage from raw bytes and rejecting garbage. Partial-credit design (≥7/8) softens exact-match pressure but the byte-level forensics is the hard part.

**quanta attack points** — `container_exec` for hexdump/`xxd`/`sqlite3 .recover` attempts and iterative Python carving. No interactivity. The exit-code loop is weak here — the test threshold (>6) is hidden, so the agent iterates against its own recovered count, not the grader. Main risk: mis-decoding the value serialization (int vs double) so values don't tuple-match the reference; `.recover`/`.dump` may partially work and is a legitimate faster path than raw carving.
