---
task: extract-moves-from-video
category: file-operations
difficulty: hard
tags: [file-operations, web, video-processing]
expert_min: 120
junior_min: 480
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/extract-moves-from-video:20251031
---

# extract-moves-from-video

**Goal** — Download a specific YouTube video of someone playing Zork, transcribe the on-screen text, and write `/app/solution.txt` listing every command the player typed, one per line (e.g. `n`, `get bag`).

**Solution shape** — The reference `solve.sh` is a cheat: it does NOT download or OCR anything — it just `echo >> solution.txt` for ~290 hard-coded move lines (the known answer). A real agent would have to `yt-dlp` the video, sample frames, and OCR the terminal text to reconstruct the input commands. So the solve script is effectively an answer key, not a demonstrated pipeline.

**Verifier** — pytest: `/app/solution.txt` exists, and its content has >=90% similarity to the embedded ~290-line reference (Levenshtein distance over the whole file, `100*(1-dist/maxlen) >= 90`). reward binary 0/1. The fuzzy threshold tolerates minor transcription slips but demands near-complete, correctly-ordered extraction.

**Difficulty drivers** — Real multi-stage media pipeline: fetch a video, decode frames, OCR game text, and disentangle the player's *inputs* from the game's *output* — over a long playthrough (~290 moves). Exact ordering and near-verbatim command text are required at 90% similarity, so systematic OCR/parse errors compound and fail the gate. (The provided solution sidesteps all of this, so it gives an agent no real scaffold.)

**quanta attack points** — `container_exec` for yt-dlp/ffmpeg/OCR steps; no interactive TUI, so no `pty_*`. Main failure risk: video download blocked/unavailable, OCR noise on the retro terminal font, or failing to separate typed commands from game responses — any of which pushes similarity below 90%. The exit-code loop is weak leverage: the test yields only a single similarity pass/fail with no line-level diagnostics, so convergence depends on the agent building a reliable transcription up front.
