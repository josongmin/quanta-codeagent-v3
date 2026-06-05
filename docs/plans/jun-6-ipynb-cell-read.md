# RFC: jun-6 — cell-aware `.ipynb` read

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0481 (ipynb cell render).

---

## 1. 요약 (Summary)

`read` today treats `.ipynb` as an opaque UTF-8 text file: it streams the **raw
notebook JSON** line-by-line through `renderReadOk`
(`src/tool/read/index.ts:50-62`). A Jupyter notebook's JSON is dominated by
machinery the model never wants — `"metadata"`, `"execution_count"`,
`"outputs"` carrying **base64-encoded PNG/JPEG image payloads**, `"id"` UUIDs,
per-cell `"cell_type"` wrappers, and source stored as a `["line\n","line\n"]`
**array of strings** (so even the code the model DOES want is hard to read).
A modestly-sized notebook with a few plots can be tens of thousands of tokens of
base64 noise.

This RFC designs a **cell-aware ipynb render**: when `read` targets a `.ipynb`,
parse `cells[]` and emit only each cell's **source** (joined, line-numbered),
tagged with a stable **cell index + type** (`[cell 3 · code]`), optionally
appending **text outputs** with **base64 image blobs stripped** to a
`«image output: image/png, 48 KB elided»` placeholder. Preserving cell
boundaries/numbers lets a follow-up `NotebookEdit`/edit target a specific cell.
The transform is a **closed-port** pure function over the already-read text; it
**auto-applies for `.ipynb` only** and is byte-identical for every other
extension (justified in §4.3).

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Claude Code** ships a dedicated notebook read/edit path: its `Read`
  surfaces notebooks **cell-by-cell** (source + outputs), and `NotebookEdit`
  edits/inserts/deletes a cell by **index** — i.e. the read render and the edit
  tool share a cell-index addressing model. The on-disk env here already exposes
  a deferred `NotebookEdit` tool (system-reminder tool list), so a cell-indexed
  read render is the natural read-side counterpart.
- **Cursor / Codex** both special-case `.ipynb` in their file readers:
  notebooks are rendered as a sequence of cells with the source extracted and
  large binary outputs (image/png data URIs) elided, precisely to stop base64
  from blowing the context window. The shared cue we absorb: **strip base64
  image outputs; keep source + textual outputs; preserve cell identity.**

The nbformat v4 schema is stable and simple: a top-level `{ "cells": [...],
"nbformat": 4, "metadata": {...} }`; each cell is `{ "cell_type":
"code"|"markdown"|"raw", "source": string|string[], "outputs"?: [...],
"execution_count"?: number }`; an output is one of `stream`
(`{output_type:"stream", text:string|string[]}`), `execute_result` /
`display_data` (`{data: {"text/plain":…, "image/png":"<base64>", …}}`), or
`error` (`{ename, evalue, traceback:string[]}`). This is all we parse.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 `read` dumps raw ipynb JSON — no notebook awareness anywhere

`grep -rn "ipynb\|notebook\|cell" src/tool/read/` → **0 hits**. The read
pipeline (`src/tool/read/index.ts`) is extension-agnostic text:
- `resolveReadOutcome` (`index.ts:163-201`) does stat → directory-check →
  device/binary guard → `fs.readFile()` → returns the raw text. No branch on
  file type beyond binary-vs-text.
- `renderReadOk` (`index.ts:50-62`) splits on `\n`, line-numbers, slices by
  `offset`/`limit`. For a `.ipynb` this line-numbers the **JSON**, base64 and
  all.
- The binary guard (`classifyDeviceFile` `:65-87`, the 8 KiB binary sniff
  `:91-99`) does NOT trip on `.ipynb` — notebook JSON is valid UTF-8 text, so it
  passes straight through to the raw render. Confirmed: a `.ipynb` is read as
  text today, base64 image outputs included.
- `execute` (`index.ts:279-324`) relays the single `ReadOutcome` and applies the
  H9 dedup + line-range record — none of which is notebook-aware.

### 3.2 Closed-port FS already in place (reuse, don't add)

`makeReadTool(fs: FileSystemPort = defaultFileSystemPort)` (`index.ts:257`)
already injects the filesystem — the ipynb transform needs **no new port**, it
operates on the `string` `fs.readFile` already returns (`index.ts:198`).

**Verdict: NOT superseded.** No ipynb handling exists. (There IS a deferred
`NotebookEdit` *edit* tool in the env tool list, but no notebook-aware *read*.)

---

## 4. 설계 (Design, closed-port DI)

### 4.1 New pure module `src/tool/read/ipynb.ts` (imports only its types)

```ts
/** True iff the path's extension is `.ipynb` (case-insensitive). The ONLY
 *  gate that diverts a read away from the byte-identical raw path. */
export const isNotebook = (path: string): boolean => /\.ipynb$/i.test(path)

/** Render parsed notebook JSON into a cell-numbered, base64-stripped view.
 *  PURE: string in, string out. No I/O, no clock, no randomness. Returns
 *  `null` when the text is not parseable nbformat (caller falls back to the
 *  raw render — a corrupt/partial notebook is still readable as JSON). */
export const renderNotebook = (text: string, opts: NotebookRenderOpts): string | null
```

`NotebookRenderOpts = { includeOutputs: boolean; maxOutputChars: number }`.
Algorithm (all bounded, no unbounded loops):

1. `JSON.parse(text)`; on throw → return `null` (fall back to raw).
2. Validate shape: `Array.isArray(parsed.cells)`; else → `null`.
3. For each `cell`, index `i`:
   - Join `source` (array→`.join("")`, or string as-is); split into lines.
   - Emit a header `[cell {i} · {cell_type}]` then the line-numbered source
     (reuse the `<n>\t<line>` convention `renderReadOk` uses, `index.ts:57`).
   - If `includeOutputs` and `cell.outputs?.length`: for each output, render by
     `output_type`:
     - `stream` → `text` (joined, capped at `maxOutputChars`).
     - `execute_result`/`display_data` → emit `data["text/plain"]` (capped);
       for any `image/*` key emit `«image output: {mime}, {byteLen(base64)} B
       elided»` — **the base64 string is never emitted**.
     - `error` → `{ename}: {evalue}` + first N traceback lines (capped).
4. Join cells with a blank line; return.

`byteLen(base64)` is `Math.floor(b64.length * 3 / 4)` — a pure size estimate,
no decode (decoding would be wasted work and a DoS vector on a huge blob).

### 4.2 Wiring in `resolveReadOutcome` (one branch, after the text read)

After `fs.readFile` succeeds (`index.ts:198-200`), before returning the `ok`
outcome, add:

```ts
if (isNotebook(input.path)) {
  const rendered = renderNotebook(read.value, {
    includeOutputs: runtimeConfig().ipynbIncludeOutputs ?? true,
    maxOutputChars: 2000,
  })
  if (rendered !== null) return { kind: "ok", text: rendered, info, notebook: true }
  // unparseable → fall through to raw text (still useful)
}
return { kind: "ok", text: read.value, info }
```

`offset`/`limit` then slice the **rendered** text in `renderReadOk` exactly as
today — so paging a long notebook works on the cell-rendered view, and the H9
dedup/line-range record (`index.ts:288-324`) operates on the rendered text
unchanged (it keys on mtime, which is the same file).

### 4.3 Byte-identity justification (the crux)

- **Non-`.ipynb` reads are byte-identical.** The `isNotebook(input.path)` gate
  is a single regex on the path; it is `false` for every other extension, so
  `resolveReadOutcome` returns `read.value` unchanged — the existing code path,
  not a re-render. No default surface changes for any non-notebook file.
- **`.ipynb` is auto-rendered (not knob-gated for on/off), justified:** raw
  notebook JSON is **never** what a model wants — it is unreadable
  (array-of-strings source) and token-toxic (base64 images). There is no
  legitimate "I want the raw nbformat JSON" use case for an agent reading a
  notebook to understand/edit code; if one arises (debugging the notebook
  *format* itself), the escape hatch is reading via `bash` `cat`. Auto-render is
  the strictly-better default, matching Claude/Cursor/Codex.
- **One knob, narrow scope:** `QUANTA_IPYNB_OUTPUTS` / slot `ipynbIncludeOutputs`
  toggles only **whether textual outputs are appended** (default ON). Cell
  source is always rendered. Base64 image blobs are **always** stripped (never a
  knob — emitting base64 is never wanted). This keeps the knob surface minimal
  and the default safe.

### 4.4 Closed-port DI

No new port. The transform is a pure function of the `string` the injected
`FileSystemPort` already returns (`index.ts:198`). Unit tests pass notebook text
directly to `renderNotebook` (no FS); integration tests use the existing
in-memory `FileSystemPort` the read tests already inject (`index.ts:257` note).
No clock, no randomness, no exec.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF for the *behavior change that could surprise*, ON for the safe default)

- `ipynbIncludeOutputs` (env `QUANTA_IPYNB_OUTPUTS`) — default **ON**; toggles
  textual-output appending. Cell-source rendering + base64 stripping are
  unconditional (no knob — see §4.3).
- The cell-render itself is **auto for `.ipynb`** (justified §4.3). It does not
  touch the manifest: `read` is a BASE tool, always present; this changes only
  what `read` *returns* for one extension, not whether/where it registers. No
  new manifest row, no gate row.

### 5.2 Tool / manifest

`read` stays a single BASE tool (`name:"read"`, `index.ts:259`). No new tool, no
manifest change — so the tool-surface drift guard is untouched. fc gets one node
**"ipynb-cell-read"** on the feature axis (a behavior, not a new tool-access
edge), so it does not orphan against the manifest.

### 5.3 Fence

New file `src/tool/read/ipynb.ts` stays inside the `@/tool/read` slice and
imports only its own types (+ optionally `runtimeConfig` is read in
`index.ts`, not in the pure module). No cross-slice import.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, pure — no FS)

`renderNotebook` over crafted JSON:
- **base64 strip:** a `display_data` cell with a 100 KB `image/png` base64 →
  output contains the `«image output: image/png, ~75000 B elided»` placeholder
  and **does NOT contain the base64 string** (assert the payload substring is
  absent). The token-waste bug this RFC kills.
- **source array join:** `source:["import os\n","x=1\n"]` → renders two
  line-numbered lines, not a JSON array literal.
- **cell identity:** 3 cells → headers `[cell 0 · code]`, `[cell 1 · markdown]`,
  `[cell 2 · code]` in order; indices stable.
- **corrupt notebook → fallback:** truncated JSON / `{cells: "nope"}` →
  `renderNotebook` returns `null`; `read` falls back to raw text (still
  readable), no throw.
- **outputs knob:** `includeOutputs:false` → no `outputs` section; source still
  present. `error` output renders `ename: evalue` + capped traceback.
- **output cap:** a 1 MB `stream` text → truncated to `maxOutputChars`, no
  unbounded emit (mirror `capToolOutput` discipline).
- **non-ipynb untouched (byte-identity):** read a `.py` / `.json` file → output
  is the exact raw-render bytes (assert `isNotebook` short-circuit; the JSON
  file is NOT cell-parsed even though it's valid JSON — gate is on extension).

### 6.2 Integration (in-memory FileSystemPort)

`read` on an in-memory `notebook.ipynb` → cell-rendered; `read` on
`config.json` containing `{"cells":[]}` → raw (extension gate, not content). H9
dedup on a re-read of the same notebook range still short-circuits (mtime
unchanged) — assert the rendered view is dedup'd, not the raw.

---

## 7. 단계 (Phasing)

- **Phase 1 (shippable).** `src/tool/read/ipynb.ts` (`isNotebook` +
  `renderNotebook`) + the single branch in `resolveReadOutcome` +
  `ipynbIncludeOutputs` knob + hellgate + integration. Base64 always stripped.
- **Phase 2 (optional).** A `cell:<n>` read selector (read one cell by index) to
  pair with the deferred `NotebookEdit` tool's cell addressing — deferred until
  `NotebookEdit` is wired; the index-tagged render already makes a cell
  addressable by eye.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **A model that genuinely wants raw nbformat JSON** (rare: debugging the
  notebook format). Mitigation: `bash` `cat notebook.ipynb` is the escape hatch;
  the agent-read path is optimized for the 99% case (read code to understand/
  edit). Documented in §4.3.
- **Non-v4 nbformat / unusual cell shapes.** `renderNotebook` validates
  `Array.isArray(cells)` and per-cell `cell_type`; anything it cannot map falls
  back to `null` → raw render. Fail-soft, never throw.
- **Truncated/streaming partial file** (TOCTOU). The render runs on the bytes
  `fs.readFile` returned; a parse failure → raw fallback. No new TOCTOU surface
  beyond the existing read.
- **Alternative — gate the whole thing behind a default-OFF knob.** Rejected:
  raw notebook JSON is never the better default for an agent, so an OFF-by-
  default render leaves the token-waste bug live for every user who doesn't know
  the knob exists. Auto-for-`.ipynb` with byte-identity for everything else is
  the correct SOTA posture (matches all three competitors).
- **Alternative — new `read_notebook` tool.** Rejected: forces the model to know
  to pick it and bloats the tool surface; transparently upgrading `read` for one
  extension is zero-friction and what Claude/Cursor/Codex do.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented):**
- `src/tool/read/ipynb.ts` — `isNotebook` + pure `renderNotebook` +
  `NotebookRenderOpts`.
- `docs/decisions/0481-ipynb-cell-read.md`.

**Touched:**
- `src/tool/read/index.ts:163-201` — one `isNotebook` branch in
  `resolveReadOutcome` after `fs.readFile`; thread `notebook:true` into the
  outcome (optional flag).
- `runtimeConfig` — add `ipynbIncludeOutputs` slot (default true) +
  `QUANTA_IPYNB_OUTPUTS` seed.
- fc node + new `tests/.../ipynb-cell-read.hellgate.test.ts`.

**Audited ground truth (cited, NOT modified):**
- `src/tool/read/index.ts:50-62` (`renderReadOk` raw line-number render),
  `:65-99` (device/binary guard — does NOT trip on ipynb text), `:163-201`
  (`resolveReadOutcome`), `:257` (injected `FileSystemPort`), `:279-324`
  (`execute` + H9 dedup).
- env tool list — deferred `NotebookEdit` (the edit-side counterpart).
