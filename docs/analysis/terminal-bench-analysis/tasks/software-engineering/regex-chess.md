---
task: regex-chess
category: software-engineering
difficulty: hard
tags: [software-engineering]
expert_min: 1440
junior_min: 4800
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/regex-chess:20251031
---

# regex-chess

**Goal** — Produce `/app/re.json`: a list of `[regex, replacement]` pairs that, applied in order via `re.sub` to an input FEN (white to move), transforms it into a newline-separated list of the FEN of EVERY legal next position. Must correctly handle castling (+rights), en-passant, and promotion-to-queen-only. `re.json` must be <100k pairs and <10MB.

**Solution shape** — `solve.sh` is 4 lines: it embeds a giant gzip+base64 blob, base64-decodes it to `a.gz`, and `gzip -d`s it into `re.json`. So the reference solution ships a precomputed ~machine-generated rule table (72KB source blob) rather than authoring rules by hand — the actual move generator is compiled into thousands of substitution pairs. No program runs at test time beyond `re.sub`.

**Verifier** — pytest (with `python-chess`): applies the pairs to positions drawn from three full annotated games (Immortal, Game of the Century, Ivanchuk–Naroditsky) plus initial positions, and for each asserts the generated FEN set exactly equals python-chess's legal-move set (queen-promotions only, move/halfmove counters ignored). Also asserts `re.json` <10MB and <100k pairs. reward 0/1.

**Difficulty drivers** — One of the hardest: implementing a fully correct chess move generator (all piece rules, checks/pins, castling rights, en-passant, promotion) expressed ENTIRELY as ordered regex substitutions on the FEN string — a Turing-tarpit style computation with no variables or loops except substitution passes. Must generalize to unseen positions and stay under size limits. 24h expert / 80h junior estimate.

**quanta attack points** — Not really a terminal task — it's extreme code generation; `container_exec` to write `re.json` and run the provided `check.py`. No interactivity. The exit-code loop helps modestly since `check.py` gives correctness feedback on sample games, but the space is enormous and a plain LLM cannot hand-author the regex machine — a realistic solve requires the agent to WRITE a program that COMPILES a move generator into the regex table (as the reference clearly did), then run it. Main risk: illegal-move handling (pins/checks/en-passant) and blowing the 100k-pair / 10MB budget.
