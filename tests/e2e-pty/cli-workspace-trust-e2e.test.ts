/**
 * PTY e2e — the interactive CLI's one workspace-trust question, on the real binary path.
 *
 * ADR-0559: an untrusted launch folder is asked about once, before the session starts
 * anything the folder controls. The unit hellgate drives the resolver; this drives the
 * real CLI on a real terminal, where a question that never renders, or an answer that is
 * never saved, would be invisible to every other suite (the shared harness trusts its own
 * scratch folder so they do not stop at it).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const QUESTION = /Trust this folder\? \[y\/N\]/
/** The reader's prompt glyph — painted once the session is running. */
const BOOT = /›/
const T = 30_000

describe.skipIf(!PTY_AVAILABLE)("CLI workspace-trust question e2e (PTY)", () => {
  let configDir = ""
  let folder = ""
  let cli: PtyCli | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "e2e-trust-config-"))
    folder = mkdtempSync(join(tmpdir(), "e2e-trust-folder-"))
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(configDir, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
  })

  const launch = (): PtyCli => {
    const c = drivePtyCli({
      cwd: folder,
      env: { QUANTA_CONFIG_DIR: configDir, QUANTA_TRUSTED_PATHS: "" },
    })
    cli = c
    return c
  }
  const trustFile = (): string => join(configDir, "trust.json")

  test("an untrusted folder is asked about; yes is saved, and the next launch does not ask", async () => {
    const first = launch()
    await first.waitFor(QUESTION, T)
    first.send("y\r")
    await first.waitFor(BOOT, T)
    expect(existsSync(trustFile()), "the yes was not saved").toBe(true)
    const saved = JSON.parse(readFileSync(trustFile(), "utf8")) as Record<
      string,
      { trusted: boolean }
    >
    expect(saved[realpathSync(folder)]?.trusted).toBe(true)
    first.kill()

    const second = launch()
    // The first session now exists, so the session picker comes first; Enter starts a new one.
    await second.waitFor(/Resume a session\?/, T)
    second.send("\r")
    await second.waitFor(BOOT, T)
    expect(QUESTION.test(second.screen()), "a trusted folder was asked about again").toBe(false)
  }, 90_000)

  test("PAIRED CONTROL: no is not saved, and the session still starts", async () => {
    const c = launch()
    await c.waitFor(QUESTION, T)
    c.send("n\r")
    await c.waitFor(BOOT, T)
    expect(existsSync(trustFile())).toBe(false)
  }, 60_000)
})
