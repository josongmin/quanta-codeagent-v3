/**
 * Re-fetch the full SWE-bench Verified split (500 rows) to `verified-full.jsonl`.
 *
 *   bun run docs/analysis/swe-bench-verified-analysis/_data/fetch.ts
 *
 * Pulls from the HuggingFace datasets-server rows API — the SAME source as
 * `tests/smoke/swebench/select.ts` (DATASET / ROWS_API constants), so the full
 * dump can never drift from the pinned smoke picks.
 */
const DATASET = "princeton-nlp/SWE-bench_Verified"
const ROWS_API = "https://datasets-server.huggingface.co/rows"
// SSOT now lives under the bench tool: tools/leaderboard-dashboard/rawdata/.
const out =
  process.argv[2] ??
  `${import.meta.dir}/../../../../tools/leaderboard-dashboard/rawdata/verified-full.jsonl`

const rows: unknown[] = []
for (let offset = 0; offset < 600; offset += 100) {
  const url = `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${offset}&length=100`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HF rows API ${res.status} at offset ${offset}`)
  const body = (await res.json()) as { rows: { row: unknown }[] }
  if (body.rows.length === 0) break
  rows.push(...body.rows.map((r) => r.row))
  console.error(`fetched ${rows.length} (offset ${offset})`)
}
await Bun.write(out, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)
console.error(`wrote ${rows.length} rows -> ${out}`)
