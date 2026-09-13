/**
 * HELLGATE NW-2 (sep-14, SEC-ADV-2) — the tier-1 eviction spill must stay inside
 * the working directory.
 *
 * With `QUANTA_MICROCOMPACT=1` the loop's compaction wire builds the default
 * eviction spill port over `<cwd>/.quanta/tool-output` and persists every cleared
 * tool_result there, pruning the directory to keep=50 after each write. A cloned
 * repo controls `<cwd>/.quanta`, so a symlinked `.quanta/tool-output` (or
 * `.quanta`) used to turn each eviction into an out-of-repo write plus `*.txt`
 * deletion in the symlink's target.
 *
 * Drives the REAL `runAgent` loop (the production composition of the port) over a
 * scratch repo. Refused arms: the victim stays at exactly 80 files and 0 foreign
 * entries, and every cleared block tells the model the original was not
 * persisted and why. Paired control: a real directory still receives one spill
 * file per cleared block and is pruned to keep=50.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput, ToolResultBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { scopedEnv } from "../_support/scoped-env"

const VICTIM_NOTES = 80
const KEEP = 50
const env = scopedEnv(
  [
    "QUANTA_MICROCOMPACT",
    "QUANTA_MICROCOMPACT_FLOOR_TOKENS",
    "QUANTA_MICROCOMPACT_INTERVAL_MS",
    "QUANTA_TOOL_OUTPUT_SPILL_KEEP",
  ],
  {
    QUANTA_MICROCOMPACT: "1",
    QUANTA_MICROCOMPACT_FLOOR_TOKENS: "100",
    QUANTA_MICROCOMPACT_INTERVAL_MS: "1",
    QUANTA_TOOL_OUTPUT_SPILL_KEEP: String(KEEP),
  },
)

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model = "scripted"
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "text_delta", delta: "final answer" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/** Five old 60k tool dumps, well under the tier-2 threshold, so only tier-1
 *  eviction can shrink the transcript. */
const bloatedHistory = (): Message[] => {
  const out: Message[] = [userText("start the task")]
  for (let i = 0; i < 5; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "text", text: `DECISION ${i}` },
        { type: "tool_use", id: `u${i}`, name: "Read", input: { path: `f${i}` } },
      ],
    })
    out.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `u${i}`, content: `dump${i}:${"x".repeat(60_000)}` },
      ],
    })
  }
  out.push(userText("now answer"))
  return out
}

let root: string
let repo: string
beforeEach(() => {
  env.beforeEach()
  root = mkdtempSync(join(tmpdir(), "evict-spill-containment-"))
  repo = join(root, "repo")
  mkdirSync(repo)
})
afterEach(() => {
  env.afterEach()
  rmSync(root, { recursive: true, force: true })
})

/** Run one answer turn over the bloated history; return the cleared tool_result
 *  blocks the model was actually sent. */
const runEviction = async (): Promise<ToolResultBlock[]> => {
  const llm = new ScriptedLLM()
  const config: AgentConfig = {
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: bloatedHistory(),
    system: "test-system",
    cwd: repo,
    maxTurns: 3,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
  }
  const out = await runAgent(config)
  expect(out.reason).toBe("completed")
  const sent = llm.inputs[0]?.messages ?? []
  return sent
    .flatMap((m) => m.content)
    .filter(
      (b): b is ToolResultBlock =>
        b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
    )
}

const seedNotes = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < VICTIM_NOTES; i++) writeFileSync(join(dir, `note-${i}.txt`), `precious-${i}`)
}

const census = (dir: string): { entries: string[]; foreign: string[]; intact: number } => {
  const entries = readdirSync(dir).sort()
  const foreign = entries.filter((n) => !/^note-\d+\.txt$/.test(n))
  const intact = entries.filter((n) => {
    const m = /^note-(\d+)\.txt$/.exec(n)
    return m !== null && readFileSync(join(dir, n), "utf8") === `precious-${m[1]}`
  }).length
  return { entries, foreign, intact }
}

describe("NW-2 eviction spill — refused arms through the real loop", () => {
  test("`.quanta/tool-output` → out-of-repo dir: victim stays at 80 files, 0 foreign", async () => {
    const victim = join(root, "victim")
    seedNotes(victim)
    mkdirSync(join(repo, ".quanta"))
    symlinkSync("../../victim", join(repo, ".quanta", "tool-output"))

    const cleared = await runEviction()

    const after = census(victim)
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(after.intact).toBe(VICTIM_NOTES)
    expect(cleared.length).toBeGreaterThan(0)
    for (const block of cleared) {
      expect(block.content).toContain(
        `not persisted to disk: ${join(repo, ".quanta", "tool-output")} is a symbolic link;`,
      )
      expect(block.content).not.toContain("<persisted-output")
    }
  })

  test("`.quanta` itself → out-of-repo dir: its tool-output stays at 80 files, 0 foreign", async () => {
    const outside = join(root, "outside")
    seedNotes(join(outside, "tool-output"))
    symlinkSync("../outside", join(repo, ".quanta"))

    const cleared = await runEviction()

    const after = census(join(outside, "tool-output"))
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(after.intact).toBe(VICTIM_NOTES)
    expect(cleared.length).toBeGreaterThan(0)
    for (const block of cleared) {
      expect(block.content).toContain(
        `not persisted to disk: ${join(repo, ".quanta")} is a symbolic link;`,
      )
    }
  })
})

describe("NW-2 eviction spill — paired control", () => {
  test("real `.quanta/tool-output` with 80 files: one spill per cleared block, pruned to keep=50", async () => {
    const spillDir = join(repo, ".quanta", "tool-output")
    seedNotes(spillDir)

    const cleared = await runEviction()

    expect(cleared.length).toBeGreaterThan(0)
    const after = census(spillDir)
    expect(after.entries).toHaveLength(KEEP)
    expect(after.foreign).toHaveLength(cleared.length)
    expect(after.intact).toBe(KEEP - cleared.length)
    for (const block of cleared) {
      const m = /<persisted-output path="([^"]+)" chars="\d+">/.exec(block.content)
      expect(m).not.toBeNull()
      const path = (m as RegExpExecArray)[1] as string
      expect(path.startsWith(`${spillDir}/`)).toBe(true)
      expect(readFileSync(path, "utf8").startsWith("dump")).toBe(true)
    }
  })
})
