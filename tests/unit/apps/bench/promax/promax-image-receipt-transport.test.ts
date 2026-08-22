/**
 * PMX-04 owner split — the remote side TRANSPORTS the image receipt; it never
 * classifies raw Docker output.
 *
 * The ticket's test is "a local harness fake and a remote transport fake produce
 * the SAME typed image-receipt schema". A source scan for `docker` inside
 * `remote/**` would be a decorative rail (the whole box-session module runs
 * docker commands for other reasons), so the proof here is behavioural on both
 * sides of the claim:
 *
 *  - POSITIVE — the receipt the harness produced from an injected Docker port
 *    and the receipt that came back through the transport are DEEP-EQUAL. If
 *    remote ever re-derived a field, the two would drift.
 *  - NEGATIVE — handed raw Docker output, or a document carrying a fault code
 *    the harness table does not own, the transport REFUSES. There is no route by
 *    which remote can author a classification.
 *
 * ⚠️ SPEND SAFETY. No ssh, no EC2, no Docker: the box boundary is an injected
 * `fetch` returning strings.
 */
import { describe, expect, test } from "bun:test"
import {
  type DockerPort,
  type ProMaxImageFreezeReceipt,
  runProMaxImagePreflight,
  serializeProMaxImageFreezeReceipt,
} from "@/apps/bench/harness/promax"
import { receiveProMaxImageReceipt } from "@/apps/bench/remote/box-session/image-receipt-transport"

const DIGEST = `key4127/refactor-dockerhub@sha256:${"a".repeat(64)}`
const LOCAL_ID = `sha256:${"1".repeat(64)}`
const REMOTE_PATH = "/home/ubuntu/campaign/image-freeze.json"

const dockerFake =
  (failPull = false): DockerPort =>
  async (argv) => {
    if (argv[0] === "pull" && failPull) return { code: 1, stdout: "", stderr: "denied" }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return {
        code: 0,
        stdout: `${JSON.stringify({
          Id: LOCAL_ID,
          Os: "linux",
          Architecture: "amd64",
          RepoDigests: [DIGEST],
        })}\n`,
        stderr: "",
      }
    }
    if (argv[0] === "exec") {
      return { code: 0, stdout: "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=OK\n", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }

/** The LOCAL producer: the harness drives an injected Docker port. */
const localReceipt = async (failPull = false): Promise<ProMaxImageFreezeReceipt> =>
  runProMaxImagePreflight({
    campaignId: "PMX-7@abc123",
    upstreamGitCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
    targets: [
      {
        instanceId: "promax__alpha-1",
        sourceImageName: "key4127/refactor-dockerhub:promax__alpha-1",
        registryRepoDigest: DIGEST,
      },
    ],
    docker: dockerFake(failPull),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    probeFilePath: "/campaign/preflight-probe.txt",
    goldenSource: { path: "/campaign/source-golden.json", sha256: "e".repeat(64) },
    goldenDerived: { path: "/campaign/campaign-golden.json", sha256: "f".repeat(64) },
  })

/** The REMOTE producer: the same receipt, but as bytes off a box. */
const throughTransport = async (text: string, code = 0) =>
  receiveProMaxImageReceipt({
    remotePath: REMOTE_PATH,
    fetch: async (path) => {
      expect(path).toBe(REMOTE_PATH)
      return { code, stdout: text, stderr: code === 0 ? "" : "no such file" }
    },
  })

describe("PMX-04 — local harness receipt and remote transport receipt are the SAME value", () => {
  test("a clean run round-trips deep-equal through the box boundary", async () => {
    const local = await localReceipt()
    const remote = await throughTransport(serializeProMaxImageFreezeReceipt(local))
    if (!remote.ok) throw new Error(`transport refused: ${JSON.stringify(remote)}`)
    expect(remote.receipt).toEqual(local)
    // and the typed schema really carries invariant-6's fields on BOTH sides
    expect(remote.receipt.images[0]?.registry_repo_digest).toBe(DIGEST)
    expect(remote.receipt.images[0]?.local_image_id).toBe(LOCAL_ID)
    expect(remote.receipt.images[0]?.architecture).toBe("amd64")
  })

  test("a FAULTED run round-trips deep-equal too — faults are transported, not re-derived", async () => {
    const local = await localReceipt(true)
    expect(local.faults.map((f) => f.code)).toEqual(["pull_failed"])
    const remote = await throughTransport(serializeProMaxImageFreezeReceipt(local))
    if (!remote.ok) throw new Error("transport refused")
    expect(remote.receipt).toEqual(local)
    expect(remote.receipt.faults[0]?.argv).toEqual(["pull", DIGEST])
  })
})

describe("PMX-04 — the transport CANNOT classify Docker output", () => {
  test("raw Docker stderr is refused, never coerced into a fault", async () => {
    const r = await throughTransport(
      "Error response from daemon: manifest for key4127/x:latest not found: manifest unknown",
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    if (r.code !== "receipt_rejected") throw new Error(`expected a rejection, got ${r.code}`)
    expect(r.failures.map((f) => f.code)).toEqual(["receipt_unparseable"])
  })

  test("a receipt whose fault code was INVENTED by a consumer is refused", async () => {
    const local = await localReceipt(true)
    const doc = JSON.parse(serializeProMaxImageFreezeReceipt(local)) as {
      faults: { code: string }[]
    }
    const first = doc.faults[0]
    if (first === undefined) throw new Error("expected a fault")
    first.code = "registry_was_flaky"
    const r = await throughTransport(JSON.stringify(doc))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    if (r.code !== "receipt_rejected") throw new Error(`expected a rejection, got ${r.code}`)
    expect(r.failures.map((f) => f.code)).toEqual(["fault_code_unknown"])
  })

  test("a transport-level failure is a DISTINCT outcome from a rejected receipt", async () => {
    const r = await throughTransport("", 1)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    if (r.code !== "transport_failed")
      throw new Error(`expected a transport failure, got ${r.code}`)
    expect(r.message).toContain(REMOTE_PATH)
  })

  test("an EMPTY fetch that exits 0 is still refused (no silent empty receipt)", async () => {
    const r = await throughTransport("")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe("receipt_rejected")
  })
})
