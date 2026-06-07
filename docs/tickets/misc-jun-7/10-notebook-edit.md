# Ticket 10 — cell-aware NotebookEdit (`notebook_edit`)

**Date:** 2026-06-07
**Status:** 📐 Design (no impl).
**Gap:** §16.5 (P17) — verified jun-07: `notebook_edit` appears in `src/agent/tool-matchers.ts` (a KNOWN tool name) but **no implementation exists**; the read half (`src/tool/read/ipynb.ts` `renderNotebook`, ADR-0481) is done.
**Slice:** `@/tool` (new `src/tool/notebook-edit/`), reuses the `FileSystemPort` write chokepoint + the ipynb parse helpers.
**Candidate ADR:** next free (≥ 0510).
**Competitor:** Claude Code `NotebookEdit` (cell_id / edit_mode insert|replace|delete on `.ipynb`).
**ROI:** **user-base dependent** — high value IFF data-science/notebook users; otherwise Claude-parity-for-parity. Cost 중 (new write tool). Purely additive (no existing path changes) ⇒ low blast radius. **Do only if a notebook user-base is confirmed.**

## 1. Problem
The LLM cannot edit `.ipynb` incrementally. `Edit`/`Write` operate on raw text, but a notebook is JSON-escaped (`source` = array of strings, surrounded by `outputs`/`execution_count`/`id`/`metadata`), and the model only ever SEES the lossy `renderNotebook` view (base64 stripped, cell-numbered) — not the raw JSON — so a string-`Edit` against text it never saw fails/corrupts. The only path today is read-raw (token explosion) → reconstruct JSON → Write whole file. A cell-addressed write tool is the fix.

## 2. Current state (src-verified)
- `src/tool/read/ipynb.ts`: `isNotebook`, `renderNotebook(text, opts)` (cell-numbered, base64-stripped, no-throw, MAX cells cap). Pure parse helpers exist to reuse.
- `src/tool/read/index.ts`: routes `.ipynb` through `maybeRenderNotebook` on read.
- `@/storage` `FileSystemPort`: `readFile`/`writeFile`(+`writeFileAtomic`) — the jailed write chokepoint to commit through.
- No `notebook_edit` tool factory; `tool-matchers.ts:26` references the name only.

## 3. Design
- New tool `notebook_edit({ path, cell_index | cell_id, mode: "replace"|"insert"|"delete", source? })`:
  - parse the `.ipynb` JSON (reuse/extract the ipynb parse from `ipynb.ts`),
  - `replace` → set `cells[i].source` (split into the nbformat string-array form, trailing `\n` per line) + **clear stale `outputs` + `execution_count`** (the edited cell's prior run is invalid),
  - `insert` → splice a fresh code/markdown cell at index (mint an `id`, empty `outputs`),
  - `delete` → splice out the cell,
  - serialize back (preserve top-level `nbformat`/`metadata`/other cells byte-for-byte) and commit via `FileSystemPort.writeFileAtomic` (jailed).
  - addressing: `cell_index` (0-based) primary; optionally `cell_id` (nbformat 4.5 cell ids) for stability across inserts.
  - typed failures: not-found path / not-a-notebook (invalid JSON or no `cells`) / index OOB / unsupported mode → `ToolResult` failures, never throw.
- Gated GATED tool (manifest entry, e.g. `QUANTA_NOTEBOOK_EDIT`) — default-OFF; the zero-unwired ratchet requires a real manifest row + composition wire (mirror the `run_workflow` landing pattern).

## 4. Files to touch
- NEW `src/tool/notebook-edit/{index,edit,parse}.ts` (extract the shared parse from `ipynb.ts` into a `parse` module both read+edit use).
- `src/tool/surface/manifest.ts` — GATED entry.
- composition (DefaultToolPorts or buildDefaultTools) — register when gated.
- tests under `tests/unit/` (pure edit logic) — no `@/apps/cli` import so top-level is fine.

## 5. TDD / hellgate plan (red-first)
- replace: a 3-cell notebook, replace cell 1 source → cell 1 `source` updated, `outputs`/`execution_count` cleared, cells 0+2 byte-identical, valid JSON round-trips.
- insert: insert at index 1 → 4 cells, new cell has empty outputs + an id; neighbors intact.
- delete: delete cell 0 → 2 cells; rest intact.
- adversarial: non-`.ipynb` / invalid JSON / no `cells` → typed `not_found`/`rejected`, NEVER throws + NEVER writes a corrupt file (atomic temp+rename; on parse fail the file is untouched).
- index OOB (negative / ≥ len) → typed failure, no write.
- surrogate / unicode in source preserved (the read tool's surrogate-safety standard).
- huge notebook (cell cap) → bounded, no DoS.
- manifest drift-guard: `notebook_edit` catalogued + wired (not unwired).

## 6. Risk
- Corrupting a user's notebook is the headline risk → atomic write + parse-before-write + "on any parse/serialize failure, leave the file untouched" invariant, pinned by a hellgate. Additive (no existing read/edit path changes) ⇒ otherwise low blast radius.

## 7. Open questions
- `cell_index` vs `cell_id` as the primary address — id is insert-stable but the read view shows indices; likely expose index (matches what the model sees) + accept id as an alternative. Calibrate against how the model references cells in practice.
