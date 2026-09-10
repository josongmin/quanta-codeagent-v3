import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const evalEntrypoint = join(process.cwd(), "src/apps/eval/entry.ts")

const runEvalHelp = async (args: {
  readonly cwd: string
  readonly env?: Record<string, string>
}): Promise<{ stdout: string; stderr: string; exit: number }> => {
  const script = `
    const origExit = process.exit.bind(process);
    process.exit = ((code) => {
      process.stdout.write("PROBE=" + (process.env.R15_EVAL_PROBE ?? "unset") + "\\n");
      origExit(typeof code === "number" ? code : 0);
    });
    process.argv = ["bun", ${JSON.stringify(evalEntrypoint)}, "--help"];
    await import(${JSON.stringify(evalEntrypoint)});
  `
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
    cwd: args.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      HOME: process.env.HOME ?? tmpdir(),
      ...(args.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exit }
}

describe("G-F6 eval entrypoint loader rail", () => {
  test("child process importing eval sees .env.dev first-wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r15-eval-ep-"))
    writeFileSync(join(dir, ".env.dev"), "R15_EVAL_PROBE=dev-wins\n")
    writeFileSync(join(dir, ".env.local"), "R15_EVAL_PROBE=local-loses\n")
    writeFileSync(join(dir, ".env"), "R15_EVAL_PROBE=env-loses\n")
    const { stdout, exit } = await runEvalHelp({ cwd: dir })
    expect(exit).toBe(0)
    expect(stdout).toContain("PROBE=dev-wins")
  })

  test("shell env wins over eval entrypoint dotenv files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r15-eval-shell-"))
    writeFileSync(join(dir, ".env.dev"), "R15_EVAL_PROBE=dev-loses\n")
    const { stdout, exit } = await runEvalHelp({
      cwd: dir,
      env: { R15_EVAL_PROBE: "from-shell" },
    })
    expect(exit).toBe(0)
    expect(stdout).toContain("PROBE=from-shell")
  })
})
