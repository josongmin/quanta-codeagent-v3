import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CANONICAL = 'loadEnvFiles([".env.dev", ".env.local", ".env"])'
const FORBIDDEN = 'loadEnv([".env", ".env.local", ".env.dev"])'

describe("G-F6 eval env precedence", () => {
  test("eval entrypoint uses shared first-wins order, not a reverse local loop", () => {
    const src = readFileSync(join(process.cwd(), "src/apps/eval/index.ts"), "utf8")
    expect(src).toContain(CANONICAL)
    expect(src).not.toContain(FORBIDDEN)
    expect(src).toContain("loadEnvFiles")
  })

  test("shared loader first-wins with dotenv collision (child-isolated cwd)", async () => {
    const launch = mkdtempSync(join(tmpdir(), "r15-env-launch-"))
    const dir = mkdtempSync(join(tmpdir(), "r15-env-"))
    writeFileSync(join(dir, ".env.dev"), "R15_PROBE=from-dev\n")
    writeFileSync(join(dir, ".env.local"), "R15_PROBE=from-local\n")
    writeFileSync(join(dir, ".env"), "R15_PROBE=from-env\n")
    const script = `
      import { loadEnvFiles, envFileSourceOf } from ${JSON.stringify(join(process.cwd(), "src/shared/env-files.ts"))};
      process.chdir(${JSON.stringify(dir)});
      loadEnvFiles([".env.dev", ".env.local", ".env"]);
      process.stdout.write(JSON.stringify({
        probe: process.env.R15_PROBE,
        source: envFileSourceOf("R15_PROBE"),
      }));
    `
    const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
      cwd: launch,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exit).toBe(0)
    expect(stderr).toBe("")
    const parsed = JSON.parse(stdout) as { probe: string; source: string }
    expect(parsed.probe).toBe("from-dev")
    expect(parsed.source).toContain(".env.dev")
  })

  test("existing shell env wins over all dotenv files", async () => {
    const launch = mkdtempSync(join(tmpdir(), "r15-env-shell-launch-"))
    const dir = mkdtempSync(join(tmpdir(), "r15-env-shell-"))
    writeFileSync(join(dir, ".env.dev"), "R15_PROBE=from-dev\n")
    const script = `
      import { loadEnvFiles } from ${JSON.stringify(join(process.cwd(), "src/shared/env-files.ts"))};
      process.chdir(${JSON.stringify(dir)});
      loadEnvFiles([".env.dev", ".env.local", ".env"]);
      process.stdout.write(process.env.R15_PROBE ?? "");
    `
    const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
      cwd: launch,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, R15_PROBE: "from-shell" },
      stdout: "pipe",
    })
    expect(await new Response(proc.stdout).text()).toBe("from-shell")
    expect(await proc.exited).toBe(0)
  })

  test("missing files are skipped; empty dotenv value still first-wins", async () => {
    const launch = mkdtempSync(join(tmpdir(), "r15-env-empty-launch-"))
    const dir = mkdtempSync(join(tmpdir(), "r15-env-empty-"))
    writeFileSync(join(dir, ".env.dev"), "R15_PROBE=\n")
    writeFileSync(join(dir, ".env"), "R15_PROBE=from-env\n")
    const script = `
      import { loadEnvFiles } from ${JSON.stringify(join(process.cwd(), "src/shared/env-files.ts"))};
      process.chdir(${JSON.stringify(dir)});
      loadEnvFiles([".env.dev", ".env.local", ".env"]);
      process.stdout.write(JSON.stringify({
        probe: process.env.R15_PROBE,
        defined: process.env.R15_PROBE !== undefined,
      }));
    `
    const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
      cwd: launch,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: "pipe",
    })
    const parsed = JSON.parse(await new Response(proc.stdout).text()) as {
      probe: string
      defined: boolean
    }
    expect(await proc.exited).toBe(0)
    expect(parsed.defined).toBe(true)
    expect(parsed.probe).toBe("")
  })

  test("loader reads launch cwd, not a sibling directory of env files", async () => {
    const launch = mkdtempSync(join(tmpdir(), "r15-env-cwd-launch-"))
    const other = mkdtempSync(join(tmpdir(), "r15-env-cwd-other-"))
    writeFileSync(join(other, ".env.dev"), "R15_PROBE=from-other\n")
    const script = `
      import { loadEnvFiles } from ${JSON.stringify(join(process.cwd(), "src/shared/env-files.ts"))};
      loadEnvFiles([".env.dev", ".env.local", ".env"]);
      process.stdout.write(process.env.R15_PROBE ?? "absent");
    `
    const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
      cwd: launch,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: "pipe",
    })
    expect(await new Response(proc.stdout).text()).toBe("absent")
    expect(await proc.exited).toBe(0)
  })
})
