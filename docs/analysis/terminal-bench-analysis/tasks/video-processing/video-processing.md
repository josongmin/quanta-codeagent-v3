---
task: video-processing
category: video-processing
difficulty: hard
tags: [video-processing]
expert_min: 400
junior_min: 1000
skill_class: NUMERIC-SCI
terminal_native: low
docker_image: alexgshaw/video-processing:20251031
---

# video-processing

**Goal** — Write `/app/jump_analyzer.py` that analyzes an MP4 of a hurdle jumper (fixed camera/background/hurdle) and emits `/app/output.toml` with `jump_takeoff_frame_number` and `jump_land_frame_number`. Only `cv2`, `numpy`, `toml` allowed.

**Solution shape** — Pure CV code authoring (deps pre-installed). `solve.sh` writes `jump_analyzer.py`: opens the video with `cv2.VideoCapture`, runs a MOG background subtractor per frame (grayscale + Gaussian blur + open/close morphology), extracts the moving foreground's bottom slice to track the athlete's feet (left/right/bottom bounding positions), records per-step "movement events" with step distances, then picks the jump as the event with the largest horizontal step (`argmax` of step distance), reading takeoff/landing frame numbers off that event. Writes the two required frame fields (plus an unused velocity field) to TOML. One ~180-line file.

**Verifier** — pytest: example + hidden `test_video.mp4` exist; runs the analyzer on each; `output.toml` parses; asserts takeoff/landing frame numbers fall in tight inclusive ranges (example takeoff 50–54, land 62–64; test video 219–223 / 231–234). An AST check confirms only cv2/numpy/toml third-party imports. Binary 0/1.

**Difficulty drivers** — Classic-CV inference with no ML libraries: must design a robust foot-tracking / event-detection heuristic that generalizes to a *hidden* video and lands within ±2 frames on both takeoff and landing. Background subtraction tuning, morphology, and the "largest step = jump" insight are non-obvious; overfitting to the example video fails the held-out one. Long expert estimate (400 min).

**quanta attack points** — Code-authoring; `container_exec` to run the analyzer on the visible `example_video.mp4` and read the printed frames. No TUI. Main risk: a heuristic that nails the example but misses the hidden video's frame windows. The exit-code loop only exercises the visible video, so robustness/generalization matters more than iterate-until-green; the tight ±2-frame ranges give little slack.
