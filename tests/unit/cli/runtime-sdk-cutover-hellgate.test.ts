import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import ts from "typescript"

const readSource = (path: string): string =>
  readFileSync(join(import.meta.dir, "../../../", path), "utf8")

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const APPS_ROOT = join(REPO_ROOT, "src/apps")
const FORBIDDEN_IMPORTS = [
  "@/host/runtime/session-host",
  "@/runner/side-conversation-port",
  "@/sdk/runtime/compat",
  "@/runner/assemble/config",
] as const
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

const importedModules = (file: string, source: string): readonly string[] => {
  const program = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const modules: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      modules.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(program)
  return modules
}

describe("CLI runtime SDK cutover source gates", () => {
  test("app surfaces no longer import raw compat owners or runner side ports directly", () => {
    const offenders: Array<{ path: string; needle: string }> = []
    const files = walkTs(APPS_ROOT)
    expect(files.length).toBeGreaterThan(100)
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      for (const needle of importedModules(file, src)) {
        if (FORBIDDEN_IMPORTS.includes(needle as (typeof FORBIDDEN_IMPORTS)[number])) {
          offenders.push({ path: file, needle })
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("import scanner rejects static and dynamic forbidden-import injections", () => {
    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(importedModules("injected.ts", `import x from "${forbidden}"`)).toEqual([forbidden])
      expect(importedModules("injected.ts", `await import("${forbidden}")`)).toEqual([forbidden])
    }
  })

  test("session-loop consumes sdk runtime, not runner interactive primitives", () => {
    const src = readSource("src/apps/cli/repl/session-loop.ts")
    expect(src).toContain('from "@/sdk/runtime"')
    // import-fences (@/sdk/runtime/bridge, @/sdk/runtime/compat, @/runner) migrated
    // to biome noRestrictedImports (file-specific override for session-loop.ts).
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
    // @/runner import-fences migrated to biome noRestrictedImports (file-specific
    // overrides for prompt-pipeline.ts + external-prompt-queue.ts).
    expect(pipeline).toContain('from "./prompt-types"')
    expect(queue).toContain('from "./prompt-types"')
  })

  test("cli setup and side-conversation seams avoid old runner barrels in the main path", () => {
    const runtimeContext = readSource("src/apps/cli/repl/runtime-context-compose.ts")
    const sdkContext = readSource("src/sdk/runtime/context.ts")
    const mutableSurface = readSource("src/apps/cli/repl/surface-compose/mutable-wires.ts")
    const sessionLoop = readSource("src/apps/cli/repl/session-loop.ts")
    const setup = readSource("src/apps/cli/repl/session-setup.ts")
    const internal = readSource("src/apps/cli/internal.ts")

    // repl.ts import-fences (@/host/runtime/session-host, @/runner, @/runner/session-execution-plane) migrated to biome noRestrictedImports (see biome.json).

    expect(runtimeContext).toContain('from "@/sdk/runtime"')
    expect(runtimeContext).toContain("composeRuntimeBootstrapContext")
    // runtime-context-compose.ts import-fences (@/sdk/runtime/bridge, @/runner/assemble/config, @/runner/session-memory-auto) migrated to biome noRestrictedImports (see biome.json).
    expect(runtimeContext).not.toContain("RuntimeSessionDeps")
    expect(runtimeContext).not.toContain(".withAdmissibility(")

    expect(mutableSurface).not.toContain("import { assembleConfig")
    expect(mutableSurface).toContain("const startSideConversation = async")
    expect(mutableSurface).toContain('return "not-wired"')
    expect(mutableSurface).not.toContain(".wrapRegistry(")
    expect(mutableSurface).not.toContain(".setGranularRegistry(")

    expect(sdkContext).not.toContain("RuntimeSessionDeps")
    expect(sdkContext).not.toContain("CreateRuntimeFacadeFromSessionDepsArgs")
    // sdk/runtime/context.ts import-fence (@/sdk/runtime/bridge) migrated to biome noRestrictedImports (see biome.json).
    expect(sdkContext).not.toContain("createRuntimeFacadeFromSessionDeps")
    expect(sdkContext).not.toContain("export interface RuntimeBridgeState")

    expect(sessionLoop).not.toContain(".ensureAutomationEngine(")

    expect(setup).not.toContain("sideConversationPort")
    // session-setup.ts import-fences (@/host/runtime/session-host, @/runner/assemble/config) migrated to biome noRestrictedImports (see biome.json).

    expect(internal).not.toContain('export type { SessionDeps } from "@/runner/assemble/config"')
    expect(internal).not.toContain("export { assembleConfig")
    expect(internal).not.toContain("./config-assemble")
  })
})
