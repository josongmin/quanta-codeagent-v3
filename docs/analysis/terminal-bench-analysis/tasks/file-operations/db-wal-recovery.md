---
task: db-wal-recovery
category: file-operations
difficulty: medium
tags: [database, encryption, recovery]
expert_min: 45
junior_min: 240
skill_class: DEBUG-FIX
terminal_native: med
docker_image: alexgshaw/db-wal-recovery:20251031
---

# db-wal-recovery

**Goal** — A SQLite DB in `/app/` is in WAL mode but the `main.db-wal` file is XOR-encrypted, so only the 5 base records are readable. Decrypt the WAL, let SQLite apply it, and dump all 11 records (5 base + 6 WAL) to `/app/recovered.json`, sorted by id.

**Solution shape** — `solve.sh` reads the DB read-only, hex-dumps the WAL header (`xxd`) to spot corruption, then writes a small `decrypt_wal.py` that XORs every byte with key `0x42` and validates the result against the known SQLite WAL magic (`0x377f0682/83`), overwriting the WAL in place. A second `extract_data.py` opens the DB normally (SQLite auto-applies the now-valid WAL) and json.dumps the rows. 2 helper scripts, ~60 lines.

**Verifier** — pytest: `recovered.json` exists, is a list of dicts with int id / str name / int value, sorted, no dup ids, exactly 11 records with ids 1–11, and specific expected values (id1=150, id2=250 from WAL updates; names fig/grape/…/mango from WAL inserts). Binary 0/1.

**Difficulty drivers** — Requires knowing the SQLite WAL binary format / magic number to recognize the file is XOR-obscured, and inferring the single-byte key (0x42, derivable from the known-plaintext magic vs. the observed header bytes). Small but demands file-format + known-plaintext-attack reasoning; low env setup.

**quanta attack points** — `container_exec` for `xxd`/`sqlite3`/python one-shots; the key insight (XOR-with-magic) is derivable by hex-diffing the WAL header against the known magic. No interactive TUI. Main risk: recognizing WAL magic and recovering the key. The exit-code loop helps once the JSON is producible, since the record-count/value assertions give crisp feedback.
