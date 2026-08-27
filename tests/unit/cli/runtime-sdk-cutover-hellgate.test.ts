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
      node.arguments[0] !== undefined &&
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
  // BUDGET, not decoration. Measured on a full `bun test tests/unit tests/meta
  // tests/adversarial` run (39,118 arms, 3,034 files): this arm took 7,722ms
  // against bun's 5,000ms default and FAILED — reporting a guard violation
  // when the truth was that a repo-wide scan did not finish in time. Exactly
  // four arms in the whole suite exceed 2,500ms, and all four are repo-wide
  // source scans; unloaded this one passes in well under a second. A false
  // accusation is worse than a slow test: it trains the reader to discount the
  // gate, and it cost a real misattribution on 2026-08-28 before the four were
  // re-run serially and all passed. A genuine hang is still bounded by the
  // outer `timeout` on the suite command.
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
  }, 60_000)

  test("import scanner rejects static and dynamic forbidden-import injections", () => {
    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(importedModules("injected.ts", `import x from "${forbidden}"`)).toEqual([forbidden])
      expect(importedModules("injected.ts", `await import("${forbidden}")`)).toEqual([forbidden])
    }
  })

  test("session-loop consumes sdk runtime, not runner interactive primitives", () => {
    // Refactor b17ce99aa split the session-loop into `session-loop/` lane
    // helpers. The sdk-runtime consumption (RuntimeSession / RuntimeContext)
    // now lives in the turn-driver helper; the entrypoint re-exports it. Assert
    // the SDK-runtime import survives in the helper that actually consumes it,
    // and that the forbidden runner interactive primitives are absent across the
    // WHOLE lane (entrypoint + every helper file), not just the entrypoint.
    const turnDriver = readSource("src/apps/cli/repl/session-loop/turn-driver.ts")
    expect(turnDriver).toContain('from "@/sdk/runtime"')

    const laneDir = join(REPO_ROOT, "src/apps/cli/repl/session-loop")
    const laneSources = [
      readSource("src/apps/cli/repl/session-loop.ts"),
      ...walkTs(laneDir).map((f) => readFileSync(f, "utf8")),
    ]
    // import-fences (@/sdk/runtime/bridge, @/sdk/runtime/compat, @/runner) migrated
    // to biome noRestrictedImports (file-specific overrides for the lane).
    for (const src of laneSources) {
      expect(src).not.toContain("runInteractive(")
      expect(src).not.toContain("runOnce(")
      expect(src).not.toContain("RuntimeSessionInternal")
      expect(src).not.toContain("__unsafePeekExecutionView")
      expect(src).not.toContain("__unsafeReplaceMessages")
      expect(src).not.toContain("createLegacyRunnerSessionHost(")
      expect(src).not.toContain("peekMessages(")
      expect(src).not.toContain("peekLastOutcome(")
      expect(src).not.toContain("replaceMessages(")
    }
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
