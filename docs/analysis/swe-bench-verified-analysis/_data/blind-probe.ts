/**
 * Blind localization probe: ask the model (gpt-5.4) WHERE it would fix each
 * sampled SWE-bench problem, given ONLY the issue text (no gold patch, no repo).
 * Then score file/owner hit vs the gold patch — measures the mislocation rate
 * that a codegraph grounding tool would attack.
 *
 *   OPENAI_API_KEY=... QUANTA_MODEL=gpt-5.4 bun run \
 *     docs/analysis/swe-bench-verified-analysis/_data/blind-probe.ts
 */
const BASE = `${import.meta.dir}/..`
const MODEL = process.env.QUANTA_MODEL ?? "gpt-5.4"
const KEY = process.env.OPENAI_API_KEY
if (!KEY) throw new Error("set OPENAI_API_KEY")

const SAMPLE = [
  "django__django-15280", "matplotlib__matplotlib-14623", "sympy__sympy-22080",
  "pylint-dev__pylint-6386", "pydata__xarray-3095", // mislocation-prone / multi-site
  "pallets__flask-5014", "pylint-dev__pylint-6903", // easy L0 controls
]

const ask = async (repo: string, problem: string) => {
  const body = {
    model: MODEL,
    input: [
      { role: "system", content: "You are localizing a bug fix in an open-source Python repo. Given ONLY the issue text, name the EXACT file path(s) and the function/method/class you would edit, and a 1-2 sentence fix. You do not have the repo; rely on knowledge of the codebase. Respond as compact JSON: {\"files\":[\"path\"],\"symbols\":[\"Class.method\"],\"fix\":\"...\"}." },
      { role: "user", content: `Repo: ${repo}\n\nIssue:\n${problem.slice(0, 6000)}` },
    ],
  }
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { error: `${res.status} ${await res.text()}`.slice(0, 200) }
  const j = (await res.json()) as any
  const text = j.output_text ?? j.output?.flatMap((o: any) => o.content?.map((c: any) => c.text) ?? []).join("") ?? JSON.stringify(j).slice(0, 300)
  return { text }
}

const out: any[] = []
for (const id of SAMPLE) {
  const r = JSON.parse(await Bun.file(`${BASE}/_data/by-instance/${id}.json`).text())
  const goldFiles = [...r.patch.matchAll(/diff --git a\/(\S+) /g)].map((m: any) => m[1])
  const ans = await ask(r.repo, r.problem_statement)
  out.push({ id, repo: r.repo, gold_files: goldFiles, answer: ans })
  console.error(`probed ${id}: ${ans.error ? "ERR " + ans.error : "ok"}`)
}
await Bun.write(`${BASE}/_data/probe-results.json`, JSON.stringify(out, null, 2))
console.error(`wrote ${out.length} -> _data/probe-results.json`)
