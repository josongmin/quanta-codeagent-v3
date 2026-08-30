/**
 * aug-30 audit (G6-01) — red-on-injection: Layer-1 source-class substitution
 * must be reachable through the sibling document readers, not just csv_read.
 *
 * The aug-23 exfil-rail hardening gave csv_read a `classifySource` declaration
 * (path ⇒ SensitivityClass), which is the ONLY hook dispatch consults before
 * whole-output substitution (`execute.ts`: no classifySource ⇒ return null ⇒
 * no Layer-1). The six sibling readers (yaml/ndjson/pdf/xlsx/docx/pptx) never
 * got it, so `yaml_read .env.yaml` delivered the secret body verbatim while
 * `read` and `csv_read` of the same bytes were substituted.
 *
 * These tests inject a REAL secret-classified file (basename in the `.env.*`
 * family — `SECRET_DOTFILE_BASENAMES`/`.env.` prefix rule in
 * `sensitivity-classifier.ts`) through one text reader (yaml_read) and one
 * binary reader (xlsx_read, real OOXML bytes via `buildXlsx`), and assert the
 * model-facing tool_result carries the placeholder, never the body. They MUST
 * fail against a reader without `classifySource`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { PermissionContext } from "@/permission"
import { defaultTools, ToolRegistry } from "@/tool"
import { buildXlsx } from "@/tool/document/authoring/xlsx"
import { baseConfig, FakeLLM, RecordingStream, text, toolUse } from "./_harness"

const FAKE_SECRET = `sk_live_${"X".repeat(32)}`

/** Drive one tool call through the real agent loop and collect the
 *  model-facing tool_result previews plus the outcome rollup. */
const runOneTool = async (
  dir: string,
  toolName: string,
  input: unknown,
): Promise<{ preview: string; rollupCount: number }> => {
  const llm = new FakeLLM([toolUse("c1", toolName, input), text("done")])
  const stream = new RecordingStream()
  const registry = new ToolRegistry(defaultTools)
  const outcome = await runAgent(
    baseConfig({
      llm,
      registry,
      stream,
      cwd: dir,
      permission: { mode: "acceptEdits" } as PermissionContext,
      system: "test",
    }),
  )
  expect(outcome.reason).toBe("completed")
  const preview = stream.events
    .filter((e) => e.type === "tool_result")
    .map((e) => (e.type === "tool_result" ? e.preview : ""))
    .join("\n")
  const rollup = outcome.redactions?.find(
    (r) => r.origin === "tool_result" && r.kind === "source_class_secret",
  )
  return { preview, rollupCount: rollup?.count ?? 0 }
}

describe("G6-01 — Layer-1 source-class substitution through sibling document readers", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quanta-doc-redact-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("yaml_read of a secret-classified path replaces the ENTIRE output", async () => {
    const file = join(dir, ".env.yaml")
    writeFileSync(file, `stripe: ${FAKE_SECRET}\ndebug: true\n`)
    const { preview, rollupCount } = await runOneTool(dir, "yaml_read", { path: file })
    expect(preview).toContain("[REDACTED:source_class_secret]")
    expect(preview).not.toContain("sk_live_")
    expect(preview).not.toContain("debug") // ENTIRE output replaced, not just the value
    expect(rollupCount).toBeGreaterThan(0)
  })

  test("xlsx_read (binary reader) of a secret-classified path replaces the ENTIRE output", async () => {
    const file = join(dir, ".env.xlsx")
    const bytes = buildXlsx({
      sheets: [
        {
          name: "Keys",
          rows: [
            ["stripe", FAKE_SECRET],
            ["debug", "true"],
          ],
        },
      ],
    })
    writeFileSync(file, bytes)
    const { preview, rollupCount } = await runOneTool(dir, "xlsx_read", { path: file })
    expect(preview).toContain("[REDACTED:source_class_secret]")
    expect(preview).not.toContain("sk_live_")
    expect(rollupCount).toBeGreaterThan(0)
  })

  test("pdf_read attachment channel: a secret-classified PDF's raw bytes never reach the model as a document block", async () => {
    // pdf_read ships the file's bytes via `ToolResult.documents` (base64
    // DocumentBlock) — a channel BESIDE the text output. Layer-1 substitution
    // of the text alone would be inert for the actual content.
    const file = join(dir, ".env.pdf")
    const pdfBytes = Buffer.from(`%PDF-1.4\n${FAKE_SECRET}\n%%EOF\n`)
    writeFileSync(file, pdfBytes)
    const secretBase64 = pdfBytes.toString("base64")

    const llm = new FakeLLM([toolUse("c1", "pdf_read", { path: file }), text("done")])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig({
        llm,
        registry,
        stream,
        cwd: dir,
        permission: { mode: "acceptEdits" } as PermissionContext,
        system: "test",
      }),
    )
    expect(outcome.reason).toBe("completed")
    // The SECOND stream call carries the tool_result the model actually sees.
    const modelView = JSON.stringify(llm.seenMessages.at(-1) ?? [])
    expect(modelView).toContain("[REDACTED:source_class_secret]")
    expect(modelView).not.toContain(secretBase64)
  })

  test("paired control: a NON-secret PDF still reaches the model as a document block", async () => {
    const file = join(dir, "report.pdf")
    const pdfBytes = Buffer.from("%PDF-1.4\nhello-report\n%%EOF\n")
    writeFileSync(file, pdfBytes)
    const okBase64 = pdfBytes.toString("base64")

    const llm = new FakeLLM([toolUse("c1", "pdf_read", { path: file }), text("done")])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig({
        llm,
        registry,
        stream,
        cwd: dir,
        permission: { mode: "acceptEdits" } as PermissionContext,
        system: "test",
      }),
    )
    expect(outcome.reason).toBe("completed")
    const modelView = JSON.stringify(llm.seenMessages.at(-1) ?? [])
    expect(modelView).toContain(okBase64) // attachment channel intact when not secret
    expect(modelView).not.toContain("[REDACTED:source_class_secret]")
  })

  test("paired control: the same yaml body under a NON-secret name flows through un-substituted", async () => {
    const file = join(dir, "settings.yaml")
    writeFileSync(file, "region: us-east-1\ndebug: true\n")
    const { preview, rollupCount } = await runOneTool(dir, "yaml_read", { path: file })
    expect(preview).not.toContain("[REDACTED:source_class_secret]")
    expect(preview).toContain("debug")
    expect(rollupCount).toBe(0)
  })
})
