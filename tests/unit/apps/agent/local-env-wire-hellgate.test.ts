/**
 * ADR-0455 jun-02 wire hellgate — `.quanta/environment.toml` actually reaches
 * `AgentConfig.localEnv` at the composition root, not merely the apply seam.
 *
 * Round-2/3 audit found the slice (parser/select/apply + shell→tool apply) was
 * landed but NO root called `loadLocalEnvConfig` to feed `AgentConfig.localEnv`
 * — so no operator could activate it (the fc maturity was corrected L3→L2). This
 * proves the loader bind that closes the seam:
 *
 *   HELL-LEW-01  buildBaseFromArgs WITHOUT a partial.localEnv ⇒ base.localEnv
 *                ABSENT (default-OFF byte-identical; ambient env unchanged).
 *   HELL-LEW-02  buildBaseFromArgs WITH a partial.localEnv ⇒ base.localEnv is
 *                that exact selection (the partial→base thread that keeps the
 *                base builder SYNC while the async loader runs at runMain).
 *   HELL-LEW-03  resolveLocalEnvSelection on a dir holding a real
 *                `.quanta/environment.toml` + QUANTA_LOCAL_ENV ⇒ the declared
 *                env's vars/pathPrepend (end-to-end loader → select).
 *   HELL-LEW-04  no config file anywhere on the walk ⇒ undefined (default-OFF).
 *   HELL-LEW-05  a DECLARED-but-malformed config ⇒ undefined (fail-closed; not
 *                applied — never a silently-wrong env).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildBaseFromArgs, resolveLocalEnvSelection } from "@/../src/apps/agent/index"

const SEL = { vars: { FOO: "bar" }, pathPrepend: ["/opt/x/bin"] }

describe("ADR-0455 wire — local-env loader at the agent composition root", () => {
  it("HELL-LEW-01: no partial.localEnv ⇒ base.localEnv absent (default-OFF)", () => {
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as { localEnv?: unknown }
    expect(base.localEnv).toBeUndefined()
  })

  it("HELL-LEW-02: partial.localEnv ⇒ threaded onto base.localEnv (sync base builder)", () => {
    const base = buildBaseFromArgs({
      mode: "interactive",
      dials: {},
      localEnv: SEL,
    }) as unknown as {
      localEnv?: typeof SEL
    }
    expect(base.localEnv).toEqual(SEL)
  })

  describe("resolveLocalEnvSelection (loader → select)", () => {
    let dir = ""
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "quanta-localenv-"))
    })
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    const writeConfig = async (root: string, body: string): Promise<void> => {
      await mkdir(join(root, ".quanta"), { recursive: true })
      await writeFile(join(root, ".quanta", "environment.toml"), body, "utf8")
    }

    it("HELL-LEW-03: real config + QUANTA_LOCAL_ENV ⇒ declared env selected", async () => {
      const root = await mkdtemp(join(dir, "ok-"))
      await writeConfig(
        root,
        ["[env.dev]", 'vars = { FOO = "bar" }', 'pathPrepend = ["/opt/x/bin"]'].join("\n"),
      )
      const sel = await resolveLocalEnvSelection(
        { QUANTA_LOCAL_ENV: "dev" } as NodeJS.ProcessEnv,
        root,
      )
      expect(sel).toBeDefined()
      expect(sel?.vars.FOO).toBe("bar")
      expect(sel?.pathPrepend).toEqual(["/opt/x/bin"])
    })

    it("HELL-LEW-04: no config on the walk ⇒ undefined (default-OFF)", async () => {
      const root = await mkdtemp(join(dir, "empty-"))
      // mark the repo boundary so the walk does not escape into a parent that
      // might carry a real config.
      await mkdir(join(root, ".git"), { recursive: true })
      const sel = await resolveLocalEnvSelection({} as NodeJS.ProcessEnv, root)
      expect(sel).toBeUndefined()
    })

    it("HELL-LEW-05: malformed config ⇒ undefined (fail-closed, not applied)", async () => {
      const root = await mkdtemp(join(dir, "bad-"))
      await writeConfig(root, "this is not = valid = toml [[[")
      const sel = await resolveLocalEnvSelection(
        { QUANTA_LOCAL_ENV: "dev" } as NodeJS.ProcessEnv,
        root,
      )
      expect(sel).toBeUndefined()
    })
  })
})
