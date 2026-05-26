import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"

const readSource = (path: string): string =>
  readFileSync(join(import.meta.dir, "../../../", path), "utf8")

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const APPS_ROOT = join(REPO_ROOT, "src/apps")
const walkTs = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkTs(full))
    else if (stat.isFile() && (extname(full) === ".ts" || extname(full) === ".tsx")) out.push(full)
  }
  return out
}

describe("CLI runtime SDK cutover source gates", () => {
  test("app surfaces no longer import raw compat owners or runner side ports directly", () => {
    const offenders: Array<{ path: string; needle: string }> = []
    for (const file of walkTs(APPS_ROOT)) {
      const src = readFileSync(file, "utf8")
      if (src.includes('from "@/host/runtime/session-host"')) {
        offenders.push({ path: file, needle: "@/host/runtime/session-host" })
      }
      if (src.includes('from "@/runner/side-conversation-port"')) {
        offenders.push({ path: file, needle: "@/runner/side-conversation-port" })
      }
      if (src.includes('from "@/sdk/runtime/compat"')) {
        offenders.push({ path: file, needle: "@/sdk/runtime/compat" })
      }
      if (src.includes('from "@/runner/assemble/config"')) {
        offenders.push({ path: file, needle: "@/runner/assemble/config" })
      }
    }
    expect(offenders).toEqual([])
  })

  test("session-loop consumes sdk runtime, not runner interactive primitives", () => {
    const src = readSource("src/apps/cli/repl/session-loop.ts")
    expect(src).toContain('from "@/sdk/runtime"')
    expect(src).not.toContain('from "@/sdk/runtime/bridge"')
    expect(src).not.toContain('from "@/sdk/runtime/compat"')
    expect(src).not.toContain('from "@/runner"')
    expect(src).not.toContain("runInteractive(")
    expect(src).not.toContain("runOnce(")
    expect(src).not.toContain("RuntimeSessionInternal")
    expect(src).not.toContain("__unsafePeekExecutionView")
    expect(src).not.toContain("__unsafeReplaceMessages")
    expect(src).not.toContain("createLegacyRunnerSessionHost(")
    expect(src).not.toContain("peekMessages(")
    expect(src).not.toContain("peekLastOutcome(")
    expect(src).not.toContain("replaceMessages(")
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

    expect(deps).toContain('from "@/sdk/runtime/bridge"')
    expect(deps).toContain("composeBootstrapRuntimeDeps")
    expect(deps).not.toContain('from "@/runner/assemble/config"')
    expect(deps).not.toContain('from "@/runner/session-memory-auto"')
    expect(deps).not.toContain('from "../config-assemble"')

    expect(surface).not.toContain("import { assembleConfig")
    expect(surface).toContain("startSideConversation: async (args) => {")

    expect(setup).not.toContain("sideConversationPort")
    expect(setup).not.toContain('from "@/host/runtime/session-host"')
    expect(setup).not.toContain('from "@/runner/assemble/config"')

    expect(internal).not.toContain('export type { SessionDeps } from "@/runner/assemble/config"')
    expect(internal).not.toContain("export { assembleConfig")
    expect(internal).not.toContain("./config-assemble")
  })
})
