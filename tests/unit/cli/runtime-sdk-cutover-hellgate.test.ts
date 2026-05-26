import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const readSource = (path: string): string =>
  readFileSync(join(import.meta.dir, "../../../", path), "utf8")

describe("CLI runtime SDK cutover source gates", () => {
  test("session-loop consumes sdk runtime, not runner interactive primitives", () => {
    const src = readSource("src/apps/cli/repl/session-loop.ts")
    expect(src).toContain('from "@/sdk/runtime"')
    expect(src).toContain('from "@/host/runtime"')
    expect(src).toContain('from "@/host/runtime/session-host"')
    expect(src).not.toContain('from "@/runner"')
    expect(src).not.toContain("runInteractive(")
    expect(src).not.toContain("runOnce(")
    expect(src).not.toContain("RuntimeSessionInternal")
    expect(src).not.toContain("__unsafePeekExecutionView")
    expect(src).not.toContain("__unsafeReplaceMessages")
  })

  test("prompt pipeline and external queue stop importing runner PromptSource types", () => {
    const pipeline = readSource("src/apps/cli/repl/prompt-pipeline.ts")
    const queue = readSource("src/apps/cli/repl/external-prompt-queue.ts")
    expect(pipeline).not.toContain('from "@/runner"')
    expect(queue).not.toContain('from "@/runner"')
    expect(pipeline).toContain('from "./prompt-types"')
    expect(queue).toContain('from "./prompt-types"')
  })

  test("cli setup and side-conversation seams avoid old runner barrels in the main path", () => {
    const repl = readSource("src/apps/cli/repl.ts")
    const deps = readSource("src/apps/cli/repl/session-deps-compose.ts")
    const surface = readSource("src/apps/cli/repl/surface-compose.ts")
    const setup = readSource("src/apps/cli/repl/session-setup.ts")
    const internal = readSource("src/apps/cli/internal.ts")

    expect(repl).not.toContain('from "@/host/runtime/session-host"')
    expect(repl).not.toContain('from "@/runner"')
    expect(repl).not.toContain('from "@/runner/session-execution-plane"')

    expect(deps).toContain('from "@/runner/assemble/config"')
    expect(deps).toContain('from "@/host/runtime/session-host"')
    expect(deps).toContain("composeLegacySessionDeps")
    expect(deps).not.toContain('from "@/runner/session-memory-auto"')
    expect(deps).not.toContain('from "../config-assemble"')

    expect(surface).not.toContain("import { assembleConfig")
    expect(surface).toContain("sideConvPort: setup.sideConversationPort")

    expect(setup).toContain("const sideConversationPort = buildLegacySideConversationPort(")
    expect(setup).toContain('from "@/host/runtime/session-host"')
    expect(setup).not.toContain('from "@/runner/assemble/config"')

    expect(internal).toContain('export type { SessionDeps } from "@/runner/assemble/config"')
    expect(internal).not.toContain("export { assembleConfig")
    expect(internal).not.toContain("./config-assemble")
  })
})
