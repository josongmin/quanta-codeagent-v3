/**
 * Blind localization probe via the logged-in quanta credential (chatgpt-oauth →
 * gpt-5.4). Asks the model WHERE it would fix each sampled SWE-bench problem
 * given ONLY the issue text, then we score file/owner hit vs the gold patch —
 * measuring the mislocation rate a codegraph grounding tool would attack.
 *
 *   bun run docs/analysis/swe-bench-verified-analysis/_data/blind-probe.ts
 */
import { createLLM } from "@/llm"
import type { StreamInput } from "@/llm/types"

const BASE = `${import.meta.dir}/..`
const MODEL = process.env.QUANTA_MODEL ?? "gpt-5.4"

const SAMPLE = [
  "django__django-15280", "matplotlib__matplotlib-14623", "sympy__sympy-22080",
  "pylint-dev__pylint-6386", "pydata__xarray-3095", // mislocation-prone / multi-site
  "pallets__flask-5014", "pylint-dev__pylint-6903", // easy L0 controls
]

const llm = createLLM("chatgpt-oauth", { model: MODEL }, process.env)

const SYS =
  "You are localizing a bug fix in an open-source Python repo. Given ONLY the issue text, name the EXACT file path(s) and the function/method/class you would edit, plus a 1-2 sentence fix. You do NOT have the repo open; rely on your knowledge of the codebase. Output ONLY compact JSON: {\"files\":[\"path\"],\"symbols\":[\"Class.method\"],\"fix\":\"...\"}."

const ask = async (repo: string, problem: string): Promise<string> => {
  const input: StreamInput = {
    system: SYS,
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: `Repo: ${repo}\n\nIssue:\n${problem.slice(0, 6000)}` }] }],
  }
  let out = ""
  for await (const ev of llm.stream(input)) {
    if (ev.type === "text_delta") out += ev.delta
  }
  return out
}

const results: any[] = []
for (const id of SAMPLE) {
  const r = JSON.parse(await Bun.file(`${BASE}/_data/by-instance/${id}.json`).text())
  const goldFiles = [...r.patch.matchAll(/diff --git a\/(\S+) /g)].map((m: any) => m[1])
  try {
    const answer = await ask(r.repo, r.problem_statement)
    results.push({ id, repo: r.repo, gold_files: goldFiles, answer })
    console.error(`probed ${id}: ok (${answer.length} chars)`)
  } catch (e: any) {
    results.push({ id, repo: r.repo, gold_files: goldFiles, error: String(e).slice(0, 200) })
    console.error(`probed ${id}: ERR ${String(e).slice(0, 120)}`)
  }
}
await Bun.write(`${BASE}/_data/probe-results.json`, JSON.stringify(results, null, 2))
console.error(`wrote ${results.length} -> _data/probe-results.json`)
