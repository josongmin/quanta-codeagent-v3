---
task: financial-document-processor
category: data-processing
difficulty: medium
tags: [ocr, image-processing, financial, file-operations]
expert_min: 30
junior_min: 60
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/financial-document-processor:20251031
---

# financial-document-processor

**Goal** — Classify mixed JPG/PDF docs in `/app/documents/` as `invoice` vs `other`, move each to `/app/invoices/` or `/app/other/`, extract `total_amount` (incl. tax) and `vat_amount` per invoice, and write `/app/invoices/summary.csv` with a trailing `total` row. `/app/documents/` must end empty.

**Solution shape** — One Python program (`document_processor.py`, ~300 lines) written via heredoc with a PEP-723 uv inline-deps header (pytesseract, PyMuPDF/fitz, pillow, opencv, pandas). `apt-get install tesseract-ocr`, then `uv run`. OCR extracts text from images (`--psm 6`) and PDFs; regex-heavy classifier + financial-field extractor handle European (`5 640,17`) and US number formats plus the Total-vs-Amount-Due special case; files are `rename()`-moved; CSV writer appends the summed `total` row.

**Verifier** — pytest: dirs exist; invoice/other sets match by SHA-512 file hash (exact 10 invoices / 7 others); `summary.csv` headers + 11 rows; per-file `total_amount`/`vat_amount` compared to expected within 0.01 (keyed by hash); `/app/documents/` empty.

**Difficulty drivers** — OCR is noisy so extraction regexes must survive real Tesseract output; exact per-invoice numeric matching (0.01 tol) across two number-format conventions; classification must be exactly right (hash-set equality — one misroute fails). Multi-step: install, OCR, classify, extract, move, aggregate.

**quanta attack points** — `container_exec` for the whole non-interactive pipeline (install → run → inspect CSV); no TUI so no `pty_*`. Main risk: brittle amount/VAT regexes producing wrong numbers under OCR noise — the binary hash-set + numeric asserts give no partial credit. The exit-code "iterate until tests pass" loop helps a lot: the agent can rerun, diff summary.csv against expectations, and tune patterns.
