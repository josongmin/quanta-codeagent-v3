import { describe, expect, test } from "bun:test"
import type { SpawnResult } from "../backend"
import { resolveLaunchAmi } from "./ec2-lifecycle"

const result = (stdout: string, code = 0, stderr = ""): SpawnResult => ({
  code,
  stdout,
  stderr,
})

describe("resolveLaunchAmi", () => {
  test("explicit AMI passes through without an AWS lookup", async () => {
    let calls = 0
    const ami = await resolveLaunchAmi(async () => {
      calls += 1
      return result("")
    }, "ami-0123456789abcdef0")
    expect(ami).toBe("ami-0123456789abcdef0")
    expect(calls).toBe(0)
  })

  test("SSM reference resolves to the current region image", async () => {
    let argv: readonly string[] = []
    const ami = await resolveLaunchAmi(async (args) => {
      argv = args
      return result("ami-012a353bb3afb92ee\n")
    }, "ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id")
    expect(ami).toBe("ami-012a353bb3afb92ee")
    expect(argv.join(" ")).toContain("ssm get-parameter")
  })

  test("invalid or failed lookup refuses before launch", async () => {
    expect(
      resolveLaunchAmi(async () => result("None\n", 254, "ParameterNotFound"), "ssm:/missing"),
    ).rejects.toThrow("AMI SSM resolution failed")
  })
})
