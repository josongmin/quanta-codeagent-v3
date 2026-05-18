/**
 * `bun run bench` — SWE-bench Verified harness skeleton + Best-of-N.
 *
 * Composition only (RFC §4 apps/bench): wires the corpus adapter, the runner,
 * and the Best-of-N sampler around a real agent. Targets RFC §1.1 (single
 * trajectory 50% → Best-of-N 70%); the real Python swebench integration is the
 * documented seam in swebench.ts and intentionally out of scope here.
 *
 * Env / argv:
 *   --corpus <dir> | QUANTA_SWEBENCH_CORPUS_ROOT   corpus root
 *   --n <int>                                      Best-of-N (default 1)
 *   --limit <int>                                  cap instances
 *   --model <id> | QUANTA_MODEL                    model id
 *   QUANTA_PROVIDER / ANTHROPIC_API_KEY / OPENAI_API_KEY  provider pick
 * Never crashes when keys are absent — prints guidance and exits 0.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { AnthropicAdapter, type LLMPort, OpenAIAdapter } from "@/llm"
import { logger } from "@/shared"
import { runInstance } from "./runner"
import { patchVote, sampleBestOfN } from "./sampler"
import { loadCorpus } from "./swebench"
import type { BenchSummary, Instance, InstanceResult } from "./types"

// ── tiny dotenv (no dependency, first-wins; apps/cli has its own copy) ──────
const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments. */
const parseEnvLine = (raw: string): [string, string] | null => {
  const line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())]
}

const loadEnv = (files: string[]): void => {
  for (const f of files) {
    const p = resolve(process.cwd(), f)
    if (!existsSync(p)) continue
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const pair = parseEnvLine(raw)
      if (pair && process.env[pair[0]] === undefined) process.env[pair[0]] = pair[1]
    }
  }
}

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

type Provider = "anthropic" | "openai"

// Local provider pick — duplicated from apps/cli on purpose (no cross-app import).
const pickProvider = (): Provider => {
  const explicit = process.env.QUANTA_PROVIDER as Provider | undefined
  if (explicit === "anthropic" || explicit === "openai") return explicit
  if (process.env.ANTHROPIC_API_KEY) return "anthropic"
  if (process.env.OPENAI_API_KEY) return "openai"
  return "anthropic"
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
}

/** Build the LLM, or null when the provider's key is absent. */
const buildLLM = (provider: Provider, model: string): LLMPort | null => {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return null
    return new OpenAIAdapter({
      apiKey,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return new AnthropicAdapter({ apiKey, model })
}

const printSummary = (summary: BenchSummary): void => {
  for (const r of summary.results) {
    const mark = r.passed ? "PASS" : "FAIL"
    const extra = r.error ? ` (${r.error})` : ""
    logger.info(`  [${mark}] ${r.id} (turns=${r.turns})${extra}`)
  }
  const pct = summary.total === 0 ? 0 : Math.round((summary.resolved / summary.total) * 100)
  logger.info(`resolved ${summary.resolved}/${summary.total} (${pct}%)`)
}

/** Run one instance n times via Best-of-N; pick passing run, then majority
 *  patch vote as a tiebreak among equally-scored runs. */
const resolveInstance = async (
  instance: Instance,
  llm: LLMPort,
  n: number,
  maxTurns: number,
  timeoutMs: number,
): Promise<InstanceResult> => {
  if (n <= 1) return runInstance(instance, { llm, maxTurns, timeoutMs })

  const out = await sampleBestOfN<InstanceResult>({
    n,
    makeAttempt: () => runInstance(instance, { llm, maxTurns, timeoutMs }),
    score: (r) => (r.passed ? 1 : 0),
  })

  const passing = out.attempts.filter((a) => a.value?.passed)
  if (passing.length > 1) {
    const vote = patchVote(
      passing.map((a) => ({
        index: a.index,
        score: a.score,
        value: { patch: a.value?.patch ?? "" },
      })),
    )
    const winner = out.attempts.find((a) => a.index === vote.representative.index)
    if (winner?.value) return winner.value
  }
  return out.best.value ?? { id: instance.id, passed: false, patch: "", turns: 0 }
}

const main = async (): Promise<void> => {
  loadEnv([".env.dev", ".env.local", ".env"])

  const corpusRoot = argValue("--corpus") ?? process.env.QUANTA_SWEBENCH_CORPUS_ROOT ?? ""
  const n = Math.max(1, Number(argValue("--n") ?? "1"))
  const limitArg = argValue("--limit")
  const maxTurns = Number(process.env.QUANTA_MAX_TURNS ?? "30")
  const timeoutMs = Number(process.env.QUANTA_BENCH_TIMEOUT_MS ?? "120000")

  const all = await loadCorpus(corpusRoot)
  if (all.length === 0) {
    logger.info(
      `No corpus found at "${corpusRoot || "(unset)"}". Set QUANTA_SWEBENCH_CORPUS_ROOT or pass --corpus <dir>. Nothing to run.`,
    )
    process.exit(0)
  }
  const instances = limitArg ? all.slice(0, Number(limitArg)) : all

  const provider = pickProvider()
  const model = argValue("--model") ?? process.env.QUANTA_MODEL ?? DEFAULT_MODEL[provider]
  const llm = buildLLM(provider, model)
  if (!llm) {
    logger.info(
      `Found ${instances.length} instance(s) but no API key for provider "${provider}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run. Exiting.`,
    )
    process.exit(0)
  }

  logger.info(
    `bench: ${instances.length} instance(s), provider=${provider}, model=${model}, n=${n}`,
  )

  const results: InstanceResult[] = []
  for (const instance of instances) {
    results.push(await resolveInstance(instance, llm, n, maxTurns, timeoutMs))
  }
  printSummary({
    total: results.length,
    resolved: results.filter((r) => r.passed).length,
    results,
  })
}

main().catch((e) => {
  logger.error(`bench fatal: ${(e as Error).message}`)
  process.exit(1)
})
