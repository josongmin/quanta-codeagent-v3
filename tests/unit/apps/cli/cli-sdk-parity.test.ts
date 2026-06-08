import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("T5 CLI SDK parity", () => {
  test("CLI runtime composition goes through the sdk runtime surface", () => {
    const runtimeContext = read("src/apps/cli/repl/runtime-context-compose.ts")
    const sessionSetup = read("src/apps/cli/repl/session-setup.ts")

    expect(runtimeContext).toContain('from "@/sdk/runtime"')
    expect(runtimeContext).toContain("composeRuntimeBootstrapContext")

    expect(sessionSetup).toContain('from "@/sdk/runtime"')
    expect(sessionSetup).not.toContain("sideConversationPort")
  })

  test("CLI session loop no longer reaches legacy runtime escape hatches", () => {
    const sessionLoop = read("src/apps/cli/repl/session-loop.ts")

    expect(sessionLoop).toContain('from "@/sdk/runtime"')
    expect(sessionLoop).not.toContain("RuntimeSessionInternal")
    expect(sessionLoop).not.toContain("__unsafePeekExecutionView")
    expect(sessionLoop).not.toContain("__unsafeReplaceMessages")
    expect(sessionLoop).not.toContain("createLegacyRunnerSessionHost(")
    expect(sessionLoop).not.toContain("peekMessages(")
    expect(sessionLoop).not.toContain("peekLastOutcome(")
    expect(sessionLoop).not.toContain("replaceMessages(")
  })
})
