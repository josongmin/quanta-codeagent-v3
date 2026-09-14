/**
 * `QUANTA_TRUSTED_PATHS` counts only from the operator's environment.
 *
 * The CLI loads the launch folder's `.env.dev` / `.env.local` / `.env` first, so a cloned
 * repository could list itself and trust its own language servers, `.mcp.json` commands,
 * plugins and hooks (sep-14 plan R-1's forge arm). A dotenv-supplied value reads as unset.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { __resetEnvFileProvenanceForTest, loadEnvFiles } from "@/shared/env-files"
import { operatorTrustedPaths } from "@/shared/operator-trusted-paths"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { withTempDirSync } from "../../_helpers/temp-dir"

const prior = process.env.QUANTA_TRUSTED_PATHS
afterEach(() => {
  if (prior === undefined) delete process.env.QUANTA_TRUSTED_PATHS
  else process.env.QUANTA_TRUSTED_PATHS = prior
  __resetEnvFileProvenanceForTest()
  __resetRuntimeConfig()
})

describe("operatorTrustedPaths", () => {
  test("RED: a value a dotenv file supplied is not consent", () => {
    withTempDirSync("trusted-paths-dotenv-", (dir) => {
      delete process.env.QUANTA_TRUSTED_PATHS
      writeFileSync(join(dir, ".env.dev"), `QUANTA_TRUSTED_PATHS=${dir}\n`)
      loadEnvFiles([join(dir, ".env.dev")])
      __resetRuntimeConfig()
      // fixture: the dotenv value loaded
      expect(process.env.QUANTA_TRUSTED_PATHS as string | undefined).toBe(dir)
      expect(operatorTrustedPaths()).toBeUndefined()
    })
  })

  test("PAIRED CONTROL: the same value from the real environment counts", () => {
    withTempDirSync("trusted-paths-real-", (dir) => {
      process.env.QUANTA_TRUSTED_PATHS = dir
      // A dotenv file naming the key afterwards does not override the real value, and
      // leaves no provenance for it.
      writeFileSync(join(dir, ".env.dev"), "QUANTA_TRUSTED_PATHS=/elsewhere\n")
      loadEnvFiles([join(dir, ".env.dev")])
      __resetRuntimeConfig()
      expect(operatorTrustedPaths()).toBe(dir)
    })
  })
})
