#!/usr/bin/env bun
/**
 * `bun run eval <subcommand>` — Tier 0–4 verification harness.
 *
 * Subcommands:
 *   audit                          Tier 0 static coverage matrix
 *   synthetic [--usecase ID] [--all]   Tier 1 LLM-judged scenario runs
 *   public swebench-verified [--report PATH]   Tier 2 wraps bench-report
 *   trajectory classify --input DIR   Tier 3 label real sessions
 *   compare --scenario ID --usecase ID --agents quanta,claude-code   Tier 4 (stub)
 *   report                         render aggregate matrix to stdout
 *   classify "<text>"              ad-hoc one-off taxonomy classifier
 *
 * Provider selection mirrors `bun run bench`:
 *   QUANTA_PROVIDER=anthropic|openai (default: whichever key is set)
 *   QUANTA_MODEL / QUANTA_JUDGE_MODEL  override per role
 *
 * Exits 0 in all "no work to do / missing key" paths so a CI matrix entry that
 * has no API key configured does not break the build — it prints guidance.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_MODEL, type LLMPort, type Provider, pickProvider, tryCreateLLM } from "@/llm"
import { logger } from "@/shared"
import { runAudit } from "./audit"
import { isKnownAdapter, KNOWN_ADAPTERS, runCompare } from "./compare"
import { runSwebenchAdapter } from "./public"
import { buildReport } from "./report"
import { generateScenarios, runSynthetic } from "./synthetic"
import { classifyQuery } from "./taxonomy"
import { classifyTrajectories, freezeFixture, replayFixture } from "./trajectory"
import type { UseCaseId } from "./types"

// ── argv helpers ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  if (i < 0 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// ── tiny dotenv (no dep, first-wins; mirrors apps/bench) ─────────────────────

const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

const loadEnv = (files: readonly string[]): void => {
  for (const f of files) {
    const p = resolve(process.cwd(), f)
    if (!existsSync(p)) continue
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim()
      if (line === "" || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      const v = unquote(line.slice(eq + 1).trim())
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}

loadEnv([".env", ".env.local", ".env.dev"])

// ── provider pick + LLM construction (delegated to the shared @/llm factory) ──
// Provider precedence, per-provider key env vars, OPENAI_BASE_URL, and the
// canonical DEFAULT_MODEL all live in `@/llm` (OCP/DIP). `process.env` is the
// composition-root env view handed to the factory.

const resolveLLM = (
  role: "agent" | "judge" | "classifier",
): { llm: LLMPort; provider: Provider; model: string } | null => {
  const provider = pickProvider(process.env)
  const envKey =
    role === "judge"
      ? "QUANTA_JUDGE_MODEL"
      : role === "classifier"
        ? "QUANTA_CLASSIFIER_MODEL"
        : "QUANTA_MODEL"
  // `--model` > per-role model env > canonical DEFAULT_MODEL[provider] (the
  // factory fills the default when `model` is omitted).
  const modelArg = argValue("--model") ?? process.env[envKey]
  const llm = tryCreateLLM(provider, modelArg !== undefined ? { model: modelArg } : {}, process.env)
  if (llm === null) {
    console.error(`eval/${role}: ${provider.toUpperCase()}_API_KEY not set — skip ${role} step`)
    return null
  }
  const model = modelArg ?? DEFAULT_MODEL[provider]
  return { llm, provider, model }
}

// ── subcommands ──────────────────────────────────────────────────────────────

const cmdAudit = async (): Promise<number> => {
  const result = await runAudit()
  const matrix = result.matrix
  console.log(
    `audit run=${result.runId} leaves=${matrix.totals.total} ok=${matrix.totals.counts.ok} partial=${matrix.totals.counts.partial} no=${matrix.totals.counts.no} tbd=${matrix.totals.counts.tbd} (${result.durationMs}ms)`,
  )
  return 0
}

const cmdSynthetic = async (): Promise<number> => {
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const judge = resolveLLM("judge") ?? agent
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const summary = await runSynthetic({
    agent: agent.llm,
    judge: judge.llm,
    ...(usecase !== undefined ? { usecase } : {}),
  })
  console.log(
    `synthetic run=${summary.runId} total=${summary.total} pass=${summary.counts.pass} partial=${summary.counts.partial} fail=${summary.counts.fail} err=${summary.counts.error} (${summary.durationMs}ms)`,
  )
  return 0
}

const cmdPublic = async (): Promise<number> => {
  const bench = argv[1]
  if (bench !== "swebench-verified") {
    console.error("eval public: only 'swebench-verified' is wired in this iteration")
    return 1
  }
  const reportPath = argValue("--report")
  const summary = await runSwebenchAdapter(reportPath !== undefined ? { reportPath } : {})
  console.log(
    `public run=${summary.runId} total=${summary.total} pass=${summary.counts.pass} fail=${summary.counts.fail} (${summary.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryClassify = async (): Promise<number> => {
  const input = argValue("--input")
  if (input === undefined) {
    console.error("eval trajectory classify: --input <dir> is required")
    return 1
  }
  const cls = resolveLLM("classifier")
  if (cls === null) return 0
  const summary = await classifyTrajectories({ llm: cls.llm, inputDir: input })
  console.log(
    `trajectory run=${summary.runId} total=${summary.total} classified=${summary.classified} unrecognised=${summary.unrecognised} no-meta=${summary.noMeta} classifier-errors=${summary.classifierErrors} (${summary.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryReplay = async (): Promise<number> => {
  const fixture = argValue("--fixture")
  if (fixture === undefined) {
    console.error("eval trajectory replay: --fixture <jsonl> is required")
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const result = await replayFixture({ llm: agent.llm, fixture })
  console.log(
    `replay run=${result.runId} verdict=${result.verdict} matched=${result.diff?.matched ?? "n/a"} diverged=${result.diff?.divergedEvents ?? "n/a"} turns=${result.originalTurns}→${result.replayTurns} (${result.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryFreeze = async (): Promise<number> => {
  const source = argValue("--source")
  const usecase = argValue("--usecase")
  const prompt = argValue("--prompt")
  if (source === undefined || usecase === undefined) {
    console.error("eval trajectory freeze: --source <jsonl> and --usecase <id> required")
    return 1
  }
  const result = freezeFixture({
    source,
    usecase,
    ...(prompt !== undefined ? { prompt } : {}),
  })
  if (result === null) {
    console.error(
      "eval trajectory freeze: source has no .meta.json sidecar and no --prompt provided",
    )
    return 1
  }
  console.log(`frozen ${result.fixturePath}\n  meta ${result.metaPath}`)
  return 0
}

const cmdTrajectory = async (): Promise<number> => {
  const sub = argv[1]
  switch (sub) {
    case "classify":
      return cmdTrajectoryClassify()
    case "replay":
      return cmdTrajectoryReplay()
    case "freeze":
      return cmdTrajectoryFreeze()
    default:
      console.error("eval trajectory: subcommand must be one of: classify, replay, freeze")
      return 1
  }
}

const cmdCompare = async (): Promise<number> => {
  const scenarioId = argValue("--scenario")
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const agentsRaw = argValue("--agents") ?? "quanta,claude-code"
  if (scenarioId === undefined || usecase === undefined) {
    console.error(
      "eval compare: --scenario, --usecase required (--agents defaults quanta,claude-code)",
    )
    return 1
  }
  // Trim each token: `--agents "quanta, claude-code"` (space after comma)
  // would otherwise route `" claude-code"` to the unknown-adapter branch.
  const agents = agentsRaw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
  // Validate ALL adapter names up front — silent skip on a typo was the bug.
  const unknown = agents.filter((a) => !isKnownAdapter(a))
  if (unknown.length > 0) {
    console.error(
      `eval compare: unknown adapter(s) [${unknown.join(", ")}] — known: ${KNOWN_ADAPTERS.join(", ")}`,
    )
    return 1
  }
  if (agents.length < 2) {
    console.error("eval compare: --agents needs at least 2 entries to form a matchup")
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const judge = resolveLLM("judge") ?? agent
  const summary = await runCompare({
    quantaLlm: agent.llm,
    judgeLlm: judge.llm,
    scenarioId,
    usecase,
    agents,
  })
  console.log(
    `compare run=${summary.runId} ran=[${summary.agentsRan.join(",")}] skipped=[${summary.agentsSkipped.map((s) => `${s.agent}(${s.reason})`).join(", ")}] matchups=${summary.matchups.length} (${summary.durationMs}ms)`,
  )
  for (const m of summary.matchups) {
    const winner = m.winnerIndex === -1 ? "tie" : m.winnerIndex === 0 ? m.a : m.b
    console.log(`  ${m.a} vs ${m.b} → ${winner}${m.note !== "" ? ` (${m.note})` : ""}`)
  }
  return 0
}

const cmdGenerate = async (): Promise<number> => {
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const countRaw = argValue("--count")
  if (usecase === undefined) {
    console.error("eval generate: --usecase <id> is required")
    return 1
  }
  const count = countRaw !== undefined ? Number.parseInt(countRaw, 10) : 5
  if (!Number.isFinite(count) || count <= 0) {
    console.error(`eval generate: invalid --count ${countRaw}`)
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const result = await generateScenarios({ llm: agent.llm, usecase, count })
  console.log(
    `generate usecase=${usecase} accepted=${result.accepted.length} rejected=${result.rejected.length}`,
  )
  for (const a of result.accepted) console.log(`  + ${a.path}`)
  for (const r of result.rejected) console.log(`  - ${r.reason}`)
  return 0
}

const cmdReport = async (): Promise<number> => {
  const out = buildReport()
  console.log(out.markdown)
  console.error(out.headline)
  return 0
}

const cmdClassify = async (): Promise<number> => {
  const text = argv[1]
  if (text === undefined || text === "") {
    console.error("eval classify: pass the query as a single argument")
    return 1
  }
  const cls = resolveLLM("classifier")
  if (cls === null) return 0
  const result = await classifyQuery(text, { llm: cls.llm })
  console.log(
    JSON.stringify({ id: result.id, confidence: result.confidence, alt: result.alt }, null, 2),
  )
  return 0
}

const HELP = `quanta eval — verification harness (Tier 0..4)

  audit                                      Tier 0 static coverage
  synthetic [--usecase ID]                   Tier 1 LLM-judged scenarios
  generate --usecase ID [--count N]          Tier 1 auto-generate scenarios (LLM)
  public swebench-verified [--report PATH]   Tier 2 wraps bench-report.json
  trajectory classify --input DIR            Tier 3 label real sessions
  trajectory replay --fixture <jsonl>        Tier 3 re-execute a fixture + diff
  trajectory freeze --source <jsonl> --usecase ID [--prompt TEXT]
                                             Tier 3 promote a session to fixture
  compare --scenario ID --usecase ID [--agents quanta,claude-code,...]
                                             Tier 4 head-to-head + pairwise judge
  report                                     render aggregate matrix
  classify "<text>"                          ad-hoc taxonomy classifier
`

const main = async (): Promise<number> => {
  const sub = argv[0]
  switch (sub) {
    case "audit":
      return cmdAudit()
    case "synthetic":
      return cmdSynthetic()
    case "generate":
      return cmdGenerate()
    case "public":
      return cmdPublic()
    case "trajectory":
      return cmdTrajectory()
    case "compare":
      return cmdCompare()
    case "report":
      return cmdReport()
    case "classify":
      return cmdClassify()
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP)
      return 0
    default:
      console.error(`unknown subcommand: ${sub}`)
      console.error(HELP)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    logger.error("eval: fatal", { error: e instanceof Error ? e.message : String(e) })
    process.exit(1)
  })
