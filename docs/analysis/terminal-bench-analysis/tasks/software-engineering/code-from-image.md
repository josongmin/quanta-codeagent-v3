---
task: code-from-image
category: software-engineering
difficulty: medium
tags: [ocr]
expert_min: 30
junior_min: 120
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/code-from-image:20251031
---

# code-from-image

**Goal** — Given a PNG (`/app/code.png`) of a pseudocode snippet, reimplement its logic in any language and write the value it would print to `/app/output.txt`. Hint: correct answer starts with `bee26a`.

**Solution shape** — `solve.sh` writes `/app/code.py` (the actual pseudocode transcribed): read `code.png` bytes → `h0 = sha256(img_bytes)` → `H = sha256(h0 || h0[:10] || b"0000TBENCH-SALT")` → print `H.hex()`, then runs it to `/app/output.txt`. Trivial once the code is read; the difficulty is that `code.png` is deliberately crafted so tesseract/easyocr fail — the comment notes even SmolVLM-Instruct only "almost" extracts it. ~30-line Python.

**Verifier** — pytest. Asserts `/app/output.txt` exists, starts with `bee26a`, and equals the exact 64-hex-char digest `bee26a133f...ce3defe`. reward 0/1.

**Difficulty drivers** — Pure OCR/vision extraction of an adversarially-rendered image is the whole challenge; the logic itself is a trivial nested-sha256 over the image's own bytes. Getting a single byte of the transcribed code wrong (wrong salt string, wrong slice `h0[:10]`, wrong concat order) changes the digest completely — exact-output with a cryptographic amplifier. The `bee26a` prefix hint lets the agent verify a guess.

**quanta attack points** — `container_exec` to run OCR/VLM tools and execute candidate transcriptions, checking whether the output starts with `bee26a`. Main failure risk is misreading the adversarial image (a single-char error → totally wrong hash). The exit-code loop is unusually powerful here: the `bee26a` prefix acts as an oracle, so the agent can iterate transcriptions until the digest prefix matches. Terminal is only the runtime; essentially a vision+coding task, pty not needed.
