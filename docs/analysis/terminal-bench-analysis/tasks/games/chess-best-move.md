---
task: chess-best-move
category: games
difficulty: medium
tags: []
expert_min: 45
junior_min: 180
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/chess-best-move:20251031
---

# chess-best-move

**Goal** — Given `chess_board.png` (white to move), write the best move(s) to `/app/move.txt` as `[src][dst]` (e.g. e2e4), one per line, listing all winning moves.

**Solution shape** — `solve.sh` installs `stockfish` + `numpy`/`python-chess`, writes `solve.py`. The script does board-image→FEN by cropping the PNG into 8x8 squares and, per square, rendering each candidate Unicode piece glyph (via a Noto font) on the square's average bg color and picking the min-MSE match; assembles a FEN ("w KQkq"). Then enumerates legal moves collecting all checkmate-in-one moves (else falls back to a 2s Stockfish search) and writes them. One ~200-line Python file plus engine install.

**Verifier** — pytest (uvx). Reads `/app/move.txt`, splits on whitespace, asserts `sorted(moves) == sorted(["g2g4","e2e4"])` — i.e. the exact set of both mate-in-one moves for this specific position. reward 0/1.

**Difficulty drivers** — Multi-domain: computer-vision board recognition (template-matching pieces from a rendered image, no OCR) plus chess engine integration, plus the subtlety that BOTH mating moves must be found (not just one engine best-move). Env setup (stockfish, fonts, python-chess). Exact-output match on the move set.

**quanta attack points** — `container_exec` to install stockfish, run the vision+engine pipeline, and inspect move.txt. Main failure risk is the image→FEN step (wrong piece/empty classification yields a bogus position and wrong mates) and remembering to enumerate ALL mating moves rather than one engine pick. The exit-code loop only helps once the agent can self-check against a known position; the verifier answer is hidden, so it can't brute-force. No interactive component; pty not needed.
