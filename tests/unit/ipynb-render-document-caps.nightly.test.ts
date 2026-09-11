/**
 * NIGHTLY — the document-level DoS caps at their EXHAUSTIVE magnitude.
 *
 * The cap-boundary half of this property lives in
 * `tests/unit/ipynb-cell-read-render-hellgate.test.ts` and runs on every PR.
 * What is here is the magnitude, and the magnitude asserts a DIFFERENT thing:
 * not "is the cap applied" — cap + 1 settles that — but "is the cap applied
 * BEFORE the render materialises". A renderer that joined all 50,000 outputs
 * and then truncated would satisfy every boundary assertion in the canary and
 * still allocate 100 MB.
 *
 * WHY IT IS NOT ON THE PR LANE. MEASURED on this host:
 *
 *     bun interpreter baseline                        51 / 53 / 56 MiB
 *     ipynb-cell-read-render BEFORE the split      620 / 620 / 622 MiB
 *       …of which `50k capped outputs` alone                547 MiB
 *       …of which `200k cells` alone                        134 MiB
 *     ipynb-cell-read-render AFTER the split       115 / 107 / 107 MiB
 *     this file                                    599 / 596 / 605 MiB
 *
 * (three runs each; `/usr/bin/time -l` maximum resident set size)
 *
 * Half a gigabyte in one ordinary `pure` file is not a wall-clock problem — the
 * cases take 300 ms — it is an admission problem: eight of these scheduled
 * together is the difference between a shard that fits in the host's memory
 * budget and one that does not.
 *
 * The union of the two lanes is the pre-split universe and their intersection is
 * empty; `tests/_helpers/split-universe.ts` records that and a guard checks it
 * against these two files rather than against a hand-written list.
 */

import { describe, expect, test } from "bun:test"
import {
  MAX_NOTEBOOK_CELLS,
  MAX_OUTPUTS_PER_CELL,
  type NotebookRenderOpts,
  renderNotebook,
} from "@/tool/read/ipynb"

const OPTS: NotebookRenderOpts = { includeOutputs: true, maxOutputChars: 2000 }

describe("renderNotebook — document-level DoS caps at exhaustive magnitude", () => {
  test("[case:doc-cap-200k-cells] a notebook with 200k cells renders only MAX_NOTEBOOK_CELLS + an elision marker", () => {
    const cells = Array.from({ length: 200_000 }, () => ({
      cell_type: "code",
      source: ["x = 1\n"],
    }))
    const s = renderNotebook(JSON.stringify({ cells }), OPTS) as string
    // The 5k-cell cap keeps the render bounded — NOT a multi-megabyte string.
    expect(s.length).toBeLessThan(1_000_000)
    expect(s).toContain(`[cell ${MAX_NOTEBOOK_CELLS - 1} · code]`)
    expect(s.includes(`[cell ${MAX_NOTEBOOK_CELLS} · code]`)).toBe(false)
    expect(s).toContain(`${200_000 - MAX_NOTEBOOK_CELLS} more cell(s) elided`)
  })

  test("[case:doc-cap-50k-outputs] a single cell with 50k capped outputs is bounded by MAX_OUTPUTS_PER_CELL", () => {
    const outputs = Array.from({ length: 50_000 }, () => ({
      output_type: "stream",
      text: "y".repeat(2_000),
    }))
    const nb = JSON.stringify({ cells: [{ cell_type: "code", source: ["spam()\n"], outputs }] })
    const s = renderNotebook(nb, { includeOutputs: true, maxOutputChars: 2000 }) as string
    // 64 outputs × ≤2000 chars ≪ the 100MB a naive render would produce.
    expect(s.length).toBeLessThan(200_000)
    expect(s).toContain("more output(s) elided")
    expect(s).toContain(`${50_000 - MAX_OUTPUTS_PER_CELL} more output(s) elided`)
  })
})
