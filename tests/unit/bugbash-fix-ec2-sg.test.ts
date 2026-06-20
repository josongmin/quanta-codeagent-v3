/**
 * Bugbash jun-20 finding #5 (ec2-sg): ensureSecurityGroup must NOT fold a
 * describe-security-groups FAILURE (non-zero exit = network/creds error) into
 * the "SG not found" branch and then try create-security-group — that masks the
 * real cause as a misleading "create-security-group failed". The sibling
 * box-session.ts copy already throws a dedicated connectivity error BEFORE the
 * empty/None check; this ports that behavior.
 *
 * TEETH: a describe failure must reject with a connectivity/credentials message
 * and must NEVER issue a create-security-group call. Reverting the dedicated
 * throw flips it back into a create attempt, turning both assertions red.
 */
import { describe, expect, test } from "bun:test"
import { type SpawnFn, type SpawnResult } from "../../src/apps/bench/remote/backend"
import { createEc2Backend } from "../../src/apps/bench/remote/ec2"

interface Issued {
  readonly cmd: string
  readonly args: readonly string[]
}

const makeMockSpawn = (
  respond: (cmd: string, args: readonly string[]) => SpawnResult,
): { spawn: SpawnFn; issued: Issued[] } => {
  const issued: Issued[] = []
  const spawn: SpawnFn = async (cmd, args) => {
    issued.push({ cmd, args })
    return respond(cmd, args)
  }
  return { spawn, issued }
}

const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

describe("ec2 ensureSecurityGroup: describe FAILURE ≠ SG-not-found", () => {
  test("describe-security-groups non-zero exit throws a connectivity/credentials error", async () => {
    const { spawn } = makeMockSpawn((cmd, args) => {
      if (cmd === "aws" && args.includes("describe-security-groups"))
        return {
          code: 255,
          stdout: "",
          stderr: "Unable to locate credentials. You can configure credentials by running...",
        }
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {} })
    await expect(
      backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }),
    ).rejects.toThrow(/reach EC2|network\/credentials/i)
  })

  test("describe FAILURE does NOT route into create-security-group (no masking)", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "aws" && args.includes("describe-security-groups"))
        return { code: 254, stdout: "", stderr: "Could not connect to the endpoint URL" }
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {} })
    await backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }).catch(() => undefined)
    // TEETH: a describe failure must abort BEFORE create — folding it into the
    // not-found branch would issue create-security-group and mask the real cause.
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("create-security-group"))).toBe(
      false,
    )
  })

  test("legitimate SG-not-found (None on a clean describe) STILL creates", async () => {
    const { spawn, issued } = makeMockSpawn((cmd, args) => {
      if (cmd === "curl") return ok("203.0.113.7")
      if (cmd === "aws" && args.includes("describe-security-groups")) return ok("None")
      if (cmd === "aws" && args.includes("create-security-group")) return ok("sg-created")
      if (cmd === "aws" && args.includes("describe-instances")) return ok("1.2.3.4")
      return ok()
    })
    const backend = createEc2Backend({ spawn, sleep: async () => {}, maxPolls: 1, pollIntervalMs: 1 })
    await backend.grade("/p.jsonl", { datasetPath: "/d.jsonl", runId: "r" }).catch(() => undefined)
    // CONTROL: a clean describe that reports None is a real "not found" ⇒ create.
    expect(issued.some((i) => i.cmd === "aws" && i.args.includes("create-security-group"))).toBe(
      true,
    )
  })
})
