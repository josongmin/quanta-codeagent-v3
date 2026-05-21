#!/usr/bin/env bun
/**
 * `smoke:record` — capture a LIVE trajectory for a scenario and propose an
 * `expect.json` diff. Hits the real provider (OpenAI by default); requires
 * `OPENAI_API_KEY`.
 *
 *   bun run smoke:record 03-grep-symbol           # record + write trajectory.jsonl
 *   bun run smoke:record 03-grep-symbol --dry      # record, print, write NOTHING
 *   QUANTA_LLM_PROVIDER=openai bun run smoke:record 03-grep-symbol
 *
 * Writes `trajectory.jsonl` (overwrites — review the git diff) and prints a
 * field-level diff of the existing `expect.json` against an expectation
 * PROPOSED from the observed run, so the author can tighten assertions by hand.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LLMPort } from "@/llm"
import { CaptureStream } from "./capture-stream"
import { buildLiveLLM } from "./provider"
import { diffExpect, proposeExpect, RecordingLLM, serializeTrajectory } from "./recorder"
import { discoverScenarios, loadPrompts, materializeWorkspace, runConversation } from "./runner"
import type { ExpectSpec } from "./types"

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const dry = args.includes("--dry")
  const id = args.find((a) => !a.startsWith("--"))
  if (id === undefined) {
    process.stderr.write("smoke:record: usage — smoke:record <scenario-id> [--dry]\n")
    process.exit(2)
  }

  const meta = discoverScenarios({ id })[0]
  if (meta === undefined) {
    process.stderr.write(`smoke:record: no scenario with id "${id}"\n`)
    process.exit(2)
  }

  let inner: LLMPort
  let provider: string
  let model: string
  try {
    const built = buildLiveLLM()
    inner = built.llm
    provider = built.provider
    model = built.model
  } catch (e) {
    process.stderr.write(`smoke:record: cannot build LLM — ${(e as Error).message}\n`)
    process.exit(2)
    return
  }

  const recordingLlm = new RecordingLLM(inner)
  const capture = new CaptureStream()
  const work = materializeWorkspace(meta)
  process.stdout.write(`smoke:record ${meta.id} (provider=${provider}, model=${model})\n`)
  let lastReason = "completed"
  let totalTurns = 0
  try {
    const r = await runConversation({
      prompts: loadPrompts(meta.dir),
      work,
      llm: recordingLlm,
      capture,
    })
    lastReason = r.lastReason
    totalTurns = r.totalTurns
  } finally {
    // workspace is disposable; leave cleanup to the OS tmp reaper to keep the
    // recorder simple (it never writes back into `work`).
  }

  process.stdout.write(
    `  captured ${recordingLlm.captured.length} events · ${totalTurns} turns · stop=${lastReason}\n`,
  )
  process.stdout.write(`  tools: ${JSON.stringify(capture.toolCallCounts())}\n`)

  const trajectoryPath = join(meta.dir, "trajectory.jsonl")
  if (!dry) {
    writeFileSync(trajectoryPath, serializeTrajectory(recordingLlm.captured), "utf8")
    process.stdout.write(`  wrote ${trajectoryPath}\n`)
  } else {
    process.stdout.write("  --dry: trajectory NOT written\n")
  }

  const existing: ExpectSpec = existsSync(join(meta.dir, "expect.json"))
    ? (JSON.parse(readFileSync(join(meta.dir, "expect.json"), "utf8")) as ExpectSpec)
    : {}
  const proposed = proposeExpect({ capture, stopReason: lastReason, turns: totalTurns })
  const diff = diffExpect(existing, proposed)
  if (diff.length === 0) {
    process.stdout.write("  expect.json agrees with the observed run (proposed fields)\n")
  } else {
    process.stdout.write(`  expect.json diff (existing vs observed):\n${diff}\n`)
    process.stdout.write(`  proposed expect.json:\n${JSON.stringify(proposed, null, 2)}\n`)
  }
  process.exit(0)
}

void main()
