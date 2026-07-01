---
task: gcode-to-text
category: file-operations
difficulty: medium
tags: [file-operations]
expert_min: 60
junior_min: 300
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/gcode-to-text:20251031
---

# gcode-to-text

**Goal** — Given `text.gcode` (a Prusa MK4s G-code file that prints text onto an object), determine what text the print will show and write it to `/app/out.txt`. Expected: `flag{gc0d3_iz_ch4LLenGiNg}`.

**Solution shape** — Three heredoc Python scripts (~200 lines total) plus apt/pip installs (opencv, pytesseract, matplotlib, pillow). `makeseg.py` parses G0/G1 extrusion moves into 3D line segments (pickle). `render.py` applies a Z-Y-X Euler rotation (tuned angle `0 201 0`), filters Z<5mm, orthographically projects to 2D, and rasterizes to a PNG via matplotlib. `ocr.py` transposes, morphologically fills holes, rotates ~110.5° and runs Tesseract OCR to recover the glyphs, writing `out.txt`. Heavily tuned magic angles — this is essentially reverse-engineering a 3D print into a legible image.

**Verifier** — pytest: `out.txt` exists and `.strip()` exactly equals `flag{gc0d3_iz_ch4LLenGiNg}`.

**Difficulty drivers** — Exact-string flag with no partial credit, recovered through a fragile geometry+vision pipeline: correct G-code parsing, the right viewing rotation to make text readable, projection, image cleanup, and OCR robustness. Finding the exact rotation angles is trial-and-error over a rendered image. Domain knowledge of G-code extrusion semantics.

**quanta attack points** — `container_exec` for the parse→render→OCR loop; no interactive component. Main risk: wrong rotation/projection → garbled OCR → wrong flag; OCR can misread even a good render (case/leetspeak chars). The iterate-until-pass loop helps only weakly — the test is one exact string, so the agent must self-judge the intermediate PNG/OCR text (open-ended visual tuning) rather than lean on test feedback.
