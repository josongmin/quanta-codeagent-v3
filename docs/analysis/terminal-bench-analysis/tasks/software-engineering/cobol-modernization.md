---
task: cobol-modernization
category: software-engineering
difficulty: easy
tags: [coding]
expert_min: 20
junior_min: 70
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/cobol-modernization:20251031
---

# cobol-modernization

**Goal** — Re-implement a COBOL program (`/app/src/program.cbl`, a book-sale ledger that reads `INPUT.DAT` and mutates fixed-width `ACCOUNTS.DAT`, `BOOKS.DAT`, `TRANSACTIONS.DAT`) as Python at `/app/program.py`. Output `.DAT` files must be **byte-content-identical** to those GnuCOBOL 3 produces from the same inputs.

**Solution shape** — Bash: compile the COBOL with `cobc -x` to observe ground-truth behavior, then hand-port to Python. `program.py` uses dataclasses (Account/Book/Transaction), parses fixed-width records (Account = 34 bytes: 4 id / 20 name / 10 balance; Book = 28 bytes; balances as `%010d`), validates buyer/seller/book existence and ownership, then on a valid transaction adjusts balances, transfers book ownership, and appends a fixed-width transaction record. Writes all three files with exact field widths. One authored file (~150 lines).

**Verifier** — pytest: `program.py` and the three data files exist; then a scripted 3-transaction sequence — resets the `.DAT` files to known initial content, runs `program.py` three times with different `INPUT.DAT`, and asserts the final `ACCOUNTS.DAT`/`BOOKS.DAT`/`TRANSACTIONS.DAT` byte-strings exactly equal hard-coded expected fixed-width content. reward binary 0/1.

**Difficulty drivers** — The logic is simple (a ledger update), so difficulty is *fidelity*: reproducing COBOL's fixed-width field layout, zero-padded numeric formatting, exact record concatenation (no delimiters/newlines), and validation gating precisely. A single wrong field width or padding breaks the byte-exact comparison. Being able to compile+run the COBOL for reference makes it "easy" if the agent uses that oracle.

**quanta attack points** — `container_exec`: install GnuCOBOL, run the reference, diff its output against the Python port — a clean iterate loop where the COBOL binary is a ground-truth oracle, so the exit-code "iterate until tests pass" loop works well. Main risk is guessing field widths instead of deriving them from the COBOL source / a reference run, yielding subtle byte mismatches. No interactivity.
