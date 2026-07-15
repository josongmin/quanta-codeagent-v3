import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type { DiagnosticItem, DiagnosticsProvider, DiagnosticsSession } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `edit-repair-loop` (ADR-0472 / feature
 * 07-resilience/edit-repair-loop). Prior coverage drove the repair loop at the
 * DISPATCH level (`dispatchTool(...)`) or the reactor/runner in isolation — the
 * FULL `runAgent × scripted-LLM` chain (a model turn issues an `edit`/`write`,
 * the introduced-lint bracket fires, the fast-model repair RE-DRIVES until the
 * check goes green, then the outer loop continues to a real completing turn) was
 * never exercised through the live agent loop (`runAgent = 0`).
 *
 * This drives the REAL loop:
 *
 *   scripted LLM turn 1  → `write` tool call that writes a file containing a
 *                          "BUG" marker
 *     → dispatch `execute()` opens the lint bracket (pre = clean)
 *       → the edit lands the BUG on disk
 *         → `finish()` re-snapshots (post = 1 introduced diagnostic)
 *           → `runRepairLoop` drives the fast model (SAME scripted LLM, routed
 *              by the repair-prompt marker) which rewrites the file WITHOUT the
 *              BUG marker → re-check goes green (CONVERGES)
 *   scripted LLM turn 2  → a final text answer → `completed`
 *
 * Ground truth: the repair reactor actually RAN a SECOND edit attempt (its
 * distinct repair-prompt stream call was observed), the file on disk was
 * repaired to the fixed content, the tool output advertises the green repair,
 * and the outer loop completed.
 */

/** A diagnostics provider whose verdict is derived from the file's LIVE on-disk
 *  content: any file that still contains the `BUG` marker reports ONE error
 *  diagnostic; a clean file reports none. This makes the pre/post/re-check
 *  snapshots self-consistent with what the edit + the repair actually wrote —
 *  no scripted call-count trickery. Records every diagnostics() invocation so
 *  the test can prove the bracket + the repair re-check both ran. */
const BUG_MARKER = "BUG"
const bugDiagnostic = (): DiagnosticItem => ({
  severity: "error",
  message: "undefined symbol BUG",
  range: { start: { line: 0, character: 0 } },
  code: "no-bug",
})

class FileContentDiagnosticsProvider implements DiagnosticsProvider {
  diagnosticsCalls = 0
  openCalls = 0
  unavailableReason(): string {
    return "test provider always available"
  }
  async open(_filePath: string, _cwd: string): Promise<DiagnosticsSession | null> {
    this.openCalls += 1
    const self = this
    return {
      async diagnostics(filePath: string): Promise<DiagnosticItem[]> {
        self.diagnosticsCalls += 1
        let body = ""
        try {
          body = readFileSync(filePath, "utf8")
        } catch {
          body = ""
        }
        return body.includes(BUG_MARKER) ? [bugDiagnostic()] : []
      },
      async stop(): Promise<void> {},
    }
  }
}

const REPAIR_MARKER = "Repair the file"

/** Routes each stream() by inspecting the conversation text. The repair reactor
 *  calls the SAME `config.llm` with a prompt containing "Repair the file …";
 *  everything else is a main-loop turn. Records how many repair-prompt calls it
 *  served so the test can prove the fast-model re-drive actually iterated. */
class EditRepairRoutingLLM implements LLMPort {
  readonly model = "edit-repair-test-model"
  repairCalls = 0
  mainCalls = 0
  private wroteTurn = false
  constructor(
    private readonly filePath: string,
    private readonly fixedContent: string,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const convo = input.messages
      .flatMap((m) =>
        m.content.map((b) =>
          b.type === "text" ? b.text : b.type === "tool_result" ? String(b.content) : "",
        ),
      )
      .join(" ")
    // A repair-reactor call: reply with ONLY the corrected file body (no BUG).
    if (convo.includes(REPAIR_MARKER)) {
      this.repairCalls += 1
      yield { type: "text_delta", delta: this.fixedContent }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    this.mainCalls += 1
    // Main turn 1: write a file that INTRODUCES the bug.
    if (!this.wroteTurn) {
      this.wroteTurn = true
      yield { type: "tool_use_start", id: "w1", name: "write" }
      yield {
        type: "tool_use_end",
        id: "w1",
        input: { path: this.filePath, content: `line one\n${BUG_MARKER} here\nline three\n` },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    // Main turn 2: after the tool_result comes back, finish.
    yield* text("all done")
  }
}

const editRepairConfig = (
  over: Partial<AgentConfig> & Pick<AgentConfig, "llm" | "cwd">,
): AgentConfig =>
  cfg({
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "please edit the file" }] }],
    maxTurns: 6,
    ...over,
  })

describe("edit-repair-loop — real runAgent loop drives the fast-model repair to green", () => {
  let dir: string
  const origGate = process.env.QUANTA_EDIT_REPAIR_LOOP

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-repair-loop-e2e-"))
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (origGate === undefined) delete process.env.QUANTA_EDIT_REPAIR_LOOP
    else process.env.QUANTA_EDIT_REPAIR_LOOP = origGate
    __resetRuntimeConfig()
  })

  test("write introduces a lint → repair re-drives once → converges green → loop completes", async () => {
    const file = join(dir, "mod.txt")
    const fixedContent = "line one\nclean here\nline three\n"
    const llm = new EditRepairRoutingLLM(file, fixedContent)
    const provider = new FileContentDiagnosticsProvider()

    const out = await withTimeout(
      runAgent(
        editRepairConfig({
          llm,
          cwd: dir,
          diagnosticsProvider: provider,
          editRepair: { maxIters: 3 },
        }),
      ),
      15_000,
      "edit-repair-loop-e2e",
    )

    // 1. The outer loop completed (write turn → repair-in-dispatch → final turn).
    expect(out.reason).toBe("completed")

    // 2. GROUND TRUTH: the fast-model repair reactor RE-DROVE — a distinct
    //    repair-prompt stream call was served (the second edit attempt).
    expect(llm.repairCalls).toBeGreaterThanOrEqual(1)

    // 3. CONVERGED: the file on disk carries the REPAIRED (bug-free) content the
    //    reactor produced, NOT the buggy content the main turn first wrote.
    const onDisk = readFileSync(file, "utf8")
    expect(onDisk).toBe(fixedContent)
    expect(onDisk).not.toContain(BUG_MARKER)

    // 4. The provider was actually consulted for pre + post + re-check snapshots.
    expect(provider.diagnosticsCalls).toBeGreaterThanOrEqual(3)

    // 5. The tool output surfaced the green edit-repair to the model.
    const finalAssistant = out.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "tool_result" && String(b.content).includes("[edit-repair]"),
        ),
    )
    expect(finalAssistant).toBeDefined()
    const toolResultText = out.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => String(b.content))
      .join("\n")
    expect(toolResultText).toContain("cleared the edit's introduced lints")
  })

  // ── MUTATION / NON-VACUITY CONTROL ────────────────────────────────────────
  // If the model's FIRST write is already clean (no BUG marker), the bracket
  // finds ZERO introduced lints, so the repair reactor MUST NOT run at all. This
  // proves the repair-call assertion above discriminates: it fires only on a
  // real introduced-lint, not unconditionally.
  test("CONTROL: a clean edit introduces no lint ⇒ repair reactor never runs", async () => {
    const file = join(dir, "clean.txt")
    class CleanWriteLLM implements LLMPort {
      readonly model = "clean-test-model"
      repairCalls = 0
      private wrote = false
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        const convo = input.messages
          .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
          .join(" ")
        if (convo.includes(REPAIR_MARKER)) {
          this.repairCalls += 1
          yield* text("SHOULD-NOT-HAPPEN")
          return
        }
        if (!this.wrote) {
          this.wrote = true
          yield { type: "tool_use_start", id: "w1", name: "write" }
          yield {
            type: "tool_use_end",
            id: "w1",
            input: { path: file, content: "totally clean content\n" },
          }
          yield { type: "message_stop", stop_reason: "tool_use" }
          return
        }
        yield* text("done clean")
      }
    }
    const llm = new CleanWriteLLM()
    const provider = new FileContentDiagnosticsProvider()
    const out = await withTimeout(
      runAgent(
        editRepairConfig({ llm, cwd: dir, diagnosticsProvider: provider, editRepair: { maxIters: 3 } }),
      ),
      15_000,
      "edit-repair-loop-e2e-clean",
    )
    expect(out.reason).toBe("completed")
    // The discriminator: NO introduced lint ⇒ NO repair re-drive.
    expect(llm.repairCalls).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("totally clean content\n")
  })

  // ── OFF-PARITY CONTROL ────────────────────────────────────────────────────
  // With the knob OFF the whole repair seam is skipped even though the edit
  // introduces a lint — the buggy content survives on disk untouched and the
  // reactor never runs (byte-identical default-OFF contract).
  test("CONTROL: knob OFF ⇒ no repair even when the edit introduces a lint", async () => {
    delete process.env.QUANTA_EDIT_REPAIR_LOOP
    __resetRuntimeConfig()
    const file = join(dir, "off.txt")
    const llm = new EditRepairRoutingLLM(file, "line one\nclean here\nline three\n")
    const provider = new FileContentDiagnosticsProvider()
    const out = await withTimeout(
      runAgent(
        editRepairConfig({ llm, cwd: dir, diagnosticsProvider: provider, editRepair: { maxIters: 3 } }),
      ),
      15_000,
      "edit-repair-loop-e2e-off",
    )
    expect(out.reason).toBe("completed")
    // OFF: repair never ran; the BUG the main turn wrote is still on disk.
    expect(llm.repairCalls).toBe(0)
    expect(readFileSync(file, "utf8")).toContain(BUG_MARKER)
  })
})
