---
task: sam-cell-seg
category: data-science
difficulty: hard
tags: [image-processing, machine-learning, histopathology]
expert_min: 600
junior_min: 1200
skill_class: ML-TRAIN
terminal_native: med
docker_image: alexgshaw/sam-cell-seg:20251031
---

# sam-cell-seg

**Goal** — Write `/app/convert_masks.py` (argparse: weights_path, output_path, rgb_path, csv_path) that uses the **distilled MobileSAM** model to refine all cell masks in a histopathology metadata CSV from rectangles/polylines into clean polylines — no overlaps, one contiguous mask per cell — writing an updated CSV. Must run CPU-only, unmodified MobileSAM.

**Solution shape** — `solve.sh` installs torch/torchvision(cpu), pandas, timm, opencv, and MobileSAM pinned to a git commit; then heredoc-writes a ~200-line `convert_masks.py`. Pipeline: load RGB + CSV, feed per-cell bounding boxes as box prompts to `SamPredictor.predict_torch` with 3 iterations of logit-refinement (`mask_input` feedback), then `max_suppression` (argmax across masks to remove overlap), `cv2.findContours` to keep the single largest filled contour per cell, extract new bbox + polyline coords, write CSV. One substantive file; heavy SAM/opencv domain knowledge.

**Verifier** — pytest runs the script on a hidden test image/CSV, then checks: output CSV exists, same shape/columns as reference; no mask is a rectangle (shapely `minimum_rotated_rectangle` area test); IoU ≥ 0.5 vs reference per cell; pairwise polygon overlap < 1e-3; each mask single connected component (cv2); coords are flat numeric lists. Binary 0/1.

**Difficulty drivers** — Very hard: deep segmentation-model expertise (MobileSAM prompt encoding, box-torch transforms, logit feedback), non-trivial post-processing to satisfy overlap-free + single-contiguous + non-rectangle constraints simultaneously, CPU-only performance, and a hidden test set forcing genuine generalization (no path hardcoding). Longest expert estimate in this batch (600 min).

**quanta attack points** — `container_exec` throughout (pip install, run script, inspect CSV). No interactive component. Main risk: the geometric correctness constraints (IoU≥0.5 AND no-overlap AND single-contiguous) are subtle and the agent can't see the hidden grader thresholds — an exit-code loop only helps if the agent builds its own IoU/overlap harness on the provided demo files. Long install + inference time also risks timeout mismanagement.
