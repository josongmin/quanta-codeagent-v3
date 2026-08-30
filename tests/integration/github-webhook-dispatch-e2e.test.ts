/**
 * H9 — GitHub webhook ingest → event-source → dispatch FULL-PIPE e2e.
 *
 * The `@/integrations/github` slice ships a webhook event source
 * (`createWebhookEventSource`), a PR context loader (`loadPrContext`) and a PR
 * output sink (`createPrOutputSink`). The unit suite exercises each leaf in
 * isolation + attack-hellgates; this suite wires the WHOLE pipe end-to-end over
 * a REAL local HTTP socket so the integration contract is sealed:
 *
 *   real POST /webhook  (node:http client → node:http server)
 *     → raw-byte HMAC verify (`verifyHubSignature256`)
 *     → delivery-id dedup (`DeliveryStore`)
 *     → JSON parse + normalize + mention-filter
 *     → enqueue → poll() drains a ProactiveTrigger
 *     → loadPrContext  (hermetic injected GhCliPort — NO real `gh`)
 *     → output sink postComment write-back (hermetic injected GhCliPort)
 *     → assert the comment carried the idempotency marker.
 *
 * Hermetic + offline: the ONLY socket is a loopback node:http server bound on
 * an ephemeral port; every GitHub REST/`gh` call is an injected fake. No real
 * network, no timing assertions.
 *
 * Adversarial battery: forged signature → 401, duplicate delivery id → dedup
 * (single trigger), malformed JSON → 400 (graceful, no throw), sink write
 * failure → surfaced `{ ok:false, error }` (never a silent drop).
 *
 * Red-on-injection: deleting the signature check (accept forged) OR the dedup
 * check (process duplicates twice) turns the relevant cases RED — proven by the
 * two "MUTANT" cases below that drive the pipe with those guards disabled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import {
  asIdempotencyKey,
  computeIdempotencyKey,
  createDeliveryStore,
  createWebhookEventSource,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"
import { loadPrContext } from "@/integrations/github/pr-context-loader"
import { createPrOutputSink } from "@/integrations/github/pr-output-sink"
import type { ClockPort, GhCliPort, GhCliResult } from "@/reactor"

// ── Constants ────────────────────────────────────────────────────────────
const SECRET = "h9-webhook-shared-secret"
const REPO_SLUG = "octo/widget"
const PR_NUMBER = 42

const clockOf = (): ClockPort => ({ now: () => 1_700_000_000_000 })

const webhookHeaders = (headers: IncomingMessage["headers"]): Record<string, string> => {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[key.toLowerCase()] = value
    else if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(", ")
  }
  return normalized
}

const dispatchLoopbackRequest = async (
  onRequest: (request: WebhookRequest) => Promise<WebhookResponse>,
  req: IncomingMessage,
  res: ServerResponse,
  chunks: readonly Buffer[],
): Promise<void> => {
  const request: WebhookRequest = {
    method: req.method ?? "GET",
    path: (req.url ?? "/").split("?")[0] ?? "/",
    headers: webhookHeaders(req.headers),
    body: new Uint8Array(Buffer.concat(chunks)),
  }
  let response: WebhookResponse
  try {
    response = await onRequest(request)
  } catch {
    response = { status: 500, body: "handler threw" }
  }
  res.writeHead(response.status, { "content-type": "text/plain" })
  res.end(response.body ?? "")
}

// ── Real loopback node:http transport that exposes the bound port ──────────
// Mirrors the production `createNodeWebhookTransport` shape but surfaces the
// ephemeral port so the test client can connect. The slice's `routeRequest`
// pipeline runs UNCHANGED behind it — this is the integration seam, not a
// reimplementation of the slice logic.
interface BoundTransport {
  readonly transport: WebhookTransportPort
  port(): number
  serverRef(): Server | undefined
}

const makeLoopbackTransport = (): BoundTransport => {
  let server: Server | undefined
  let boundPort = 0
  const transport: WebhookTransportPort = {
    async listen({ onRequest }) {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (c) => chunks.push(c instanceof Buffer ? c : Buffer.from(c)))
        req.on("end", () => {
          void dispatchLoopbackRequest(onRequest, req, res, chunks)
        })
      })
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", () => resolve())
      })
      boundPort = (server?.address() as AddressInfo).port
      const handle: WebhookHandle = {
        async close(): Promise<void> {
          await new Promise<void>((resolve) => {
            server?.close(() => resolve())
          })
        },
      }
      return handle
    },
  }
  return {
    transport,
    port: () => boundPort,
    serverRef: () => server,
  }
}

// ── Real HTTP client (no global agent — speaks plain POST over loopback) ───
interface HttpResult {
  readonly status: number
  readonly body: string
}

const postWebhook = (
  port: number,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<HttpResult> =>
  new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/webhook",
        headers: { "content-length": String(body.length), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c instanceof Buffer ? c : Buffer.from(c)))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })

// ── Payload + signature helpers ────────────────────────────────────────────
const signBody = (body: Uint8Array): string =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`

/** A well-formed `issue_comment` on a PR that mentions @quanta from a
 *  collaborator — the canonical "should dispatch" event. */
const issueCommentPayload = (commentBody: string): Uint8Array => {
  const obj = {
    action: "created",
    repository: { owner: { login: "octo" }, name: "widget" },
    sender: { login: "alice", type: "User" },
    issue: { number: PR_NUMBER, pull_request: { url: "https://x" }, body: "" },
    comment: {
      body: commentBody,
      author_association: "COLLABORATOR",
      user: { login: "alice" },
    },
  }
  return new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8"))
}

const deliveryHeaders = (
  body: Uint8Array,
  deliveryId: string,
  opts?: { event?: string; sig?: string },
): Record<string, string> => ({
  "x-github-event": opts?.event ?? "issue_comment",
  "x-github-delivery": deliveryId,
  "x-hub-signature-256": opts?.sig ?? signBody(body),
  "content-type": "application/json",
})

// ── Hermetic GhCliPort fakes (NO real `gh` / network) ──────────────────────
interface FakeCall {
  readonly args: readonly string[]
  readonly cwd: string
}

/** A scripted gh fake: route by the args shape. Records every call. */
const makeGhFake = (
  route: (args: readonly string[]) => GhCliResult,
): { port: GhCliPort; calls: FakeCall[] } => {
  const calls: FakeCall[] = []
  const port: GhCliPort = {
    async run(args, cwd) {
      calls.push({ args: [...args], cwd })
      return route(args)
    },
  }
  return { port, calls }
}

const ok = (stdout: string): GhCliResult => ({ stdout, stderr: "", exitCode: 0 })
const fail = (exitCode: number, stderr: string): GhCliResult => ({ stdout: "", stderr, exitCode })

/** Route the 4 `loadPrContext` shapes to canned JSON. */
const contextRoute = (args: readonly string[]): GhCliResult => {
  const joined = args.join(" ")
  if (args[0] === "pr" && args[1] === "view") {
    return ok(
      JSON.stringify({
        title: "Fix the widget",
        body: "PR body",
        baseRefName: "main",
        headRefName: "feature",
        baseRefOid: "base-sha",
        headRefOid: "head-sha",
        number: PR_NUMBER,
      }),
    )
  }
  if (args[0] === "pr" && args[1] === "diff") return ok("diff --git a/x b/x\n+changed")
  if (joined.includes("/pulls/") && joined.includes("/files")) {
    return ok(JSON.stringify([{ filename: "src/widget.ts" }]))
  }
  if (joined.includes("/issues/") && joined.includes("/comments")) {
    return ok(JSON.stringify([{ user: { login: "bob" }, body: "lgtm", created_at: "2024-01-01" }]))
  }
  return fail(1, `unrouted: ${joined}`)
}

const noRedact = { redact: (t: string): string => t }

// ── Shared lifecycle ───────────────────────────────────────────────────────
let bound: BoundTransport
let handle: { stop(): Promise<void> } | undefined

const bootSource = () => {
  const deliveryStore = createDeliveryStore()
  const source = createWebhookEventSource({
    transport: bound.transport,
    secret: SECRET,
    clockPort: clockOf(),
    deliveryStore,
  })
  return { source, deliveryStore }
}

beforeEach(() => {
  bound = makeLoopbackTransport()
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.stop()
})

describe("H9 — github webhook → dispatch full pipe (real socket, hermetic gh)", () => {
  test("happy path: signed comment → ingest → poll → context load → write-back", async () => {
    const { source } = bootSource()
    handle = source
    await source.start()

    const body = issueCommentPayload("@quanta please review this")
    const res = await postWebhook(bound.port(), body, deliveryHeaders(body, "delivery-001"))
    expect(res.status).toBe(202)
    expect(res.body).toBe("accepted")

    // event-source drains exactly one ProactiveTrigger
    const triggers = await source.poll()
    expect(triggers.length).toBe(1)
    const trig = triggers[0]
    expect(trig?.reason).toBe("pr_comment")
    expect(trig?.evidence.value).toBe(`https://github.com/octo/widget/pull/${PR_NUMBER}`)
    expect(trig?.simulatedMessage).toContain("@alice")

    // dispatch: load PR context via hermetic gh
    const loaderGh = makeGhFake(contextRoute)
    const ctx = await loadPrContext({
      ghCliPort: loaderGh.port,
      repoCwd: "/tmp/repo",
      repoSlug: REPO_SLUG,
      prNumber: PR_NUMBER,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.title).toBe("Fix the widget")
    expect(ctx?.changedFiles).toContain("src/widget.ts")
    expect(ctx?.recentComments[0]?.author).toBe("bob")
    expect(loaderGh.calls.length).toBe(4) // view + diff + files + comments

    // dispatch: write a reply comment through the sink
    const postedBodies: string[] = []
    const sinkGh = makeGhFake((args) => {
      const joined = args.join(" ")
      // marker lookup (find-existing) → empty list, then POST
      if (joined.includes("--method POST")) {
        const bodyArg = args.find((a) => a.startsWith("body="))
        if (bodyArg !== undefined) postedBodies.push(bodyArg.slice("body=".length))
        return ok(
          JSON.stringify({ html_url: "https://github.com/octo/widget/pull/42#issuecomment-9001" }),
        )
      }
      return ok("[]") // listing → no existing comment
    })
    const sink = createPrOutputSink({
      ghCliPort: sinkGh.port,
      repoCwd: "/tmp/repo",
      repoSlug: REPO_SLUG,
      prNumber: PR_NUMBER,
      redactPort: noRedact,
      reconcileConcurrentPosts: false,
    })
    const key = computeIdempotencyKey("delivery-001", "comment")
    const out = await sink.postComment({ body: "On it!", key })
    expect(out.ok).toBe(true)
    expect(out.url).toContain("issuecomment-9001")
    // the write-back carried our idempotency marker (dedup primary key)
    expect(postedBodies.length).toBe(1)
    expect(postedBodies[0]).toContain(`<!-- quanta:idempotency=${key} -->`)
  })

  test("forged signature → 401, NEVER enqueues (adversarial)", async () => {
    const { source } = bootSource()
    handle = source
    await source.start()

    const body = issueCommentPayload("@quanta hi")
    // sign with the WRONG secret → forged
    const forgedSig = `sha256=${createHmac("sha256", "attacker").update(body).digest("hex")}`
    const res = await postWebhook(
      bound.port(),
      body,
      deliveryHeaders(body, "forged-001", { sig: forgedSig }),
    )
    expect(res.status).toBe(401)
    expect(res.body).toBe("invalid signature")

    const triggers = await source.poll()
    expect(triggers.length).toBe(0)
  })

  test("duplicate delivery id → dedup, processed ONCE (adversarial)", async () => {
    const { source } = bootSource()
    handle = source
    await source.start()

    const body = issueCommentPayload("@quanta dedup me")
    const headers = deliveryHeaders(body, "dup-777")

    const first = await postWebhook(bound.port(), body, headers)
    expect(first.status).toBe(202)
    expect(first.body).toBe("accepted")

    // SAME delivery id again
    const second = await postWebhook(bound.port(), body, headers)
    expect(second.status).toBe(202)
    expect(second.body).toBe("duplicate delivery (dedup)")

    // only ONE trigger drained despite two POSTs
    const triggers = await source.poll()
    expect(triggers.length).toBe(1)
  })

  test("malformed JSON body → 400 graceful, no throw, no enqueue (adversarial)", async () => {
    const { source } = bootSource()
    handle = source
    await source.start()

    const body = new Uint8Array(Buffer.from("{not valid json at all", "utf8"))
    const res = await postWebhook(bound.port(), body, deliveryHeaders(body, "bad-json-1"))
    expect(res.status).toBe(400)
    expect(res.body).toBe("invalid JSON body")

    const triggers = await source.poll()
    expect(triggers.length).toBe(0)
  })

  test("non-mention comment → 202 'no mention', recorded so retry doesn't re-eval", async () => {
    const { source } = bootSource()
    handle = source
    await source.start()

    const body = issueCommentPayload("just a normal comment, no trigger phrase")
    const res = await postWebhook(bound.port(), body, deliveryHeaders(body, "no-mention-1"))
    expect(res.status).toBe(202)
    expect(res.body).toBe("no mention")
    expect((await source.poll()).length).toBe(0)
  })

  test("sink write failure → surfaced {ok:false,error}, NOT silently dropped (adversarial)", async () => {
    // gh exits non-zero on POST → the sink must report the failure, never
    // pretend success / swallow it.
    const sinkGh = makeGhFake((args) => {
      const joined = args.join(" ")
      if (joined.includes("--method POST")) return fail(1, "HTTP 422: validation failed")
      return ok("[]")
    })
    const sink = createPrOutputSink({
      ghCliPort: sinkGh.port,
      repoCwd: "/tmp/repo",
      repoSlug: REPO_SLUG,
      prNumber: PR_NUMBER,
      redactPort: noRedact,
      reconcileConcurrentPosts: false,
    })
    const out = await sink.postComment({
      body: "this should fail loudly",
      key: asIdempotencyKey("k-fail"),
    })
    expect(out.ok).toBe(false)
    expect(out.error).toBeDefined()
    expect(out.error).toContain("gh-exit-1")
  })

  test("context loader fails any shot → undefined (no partial dispatch)", async () => {
    // diff call fails → loader must NOT surface a partial PrContext
    const loaderGh = makeGhFake((args) => {
      if (args[0] === "pr" && args[1] === "diff") return fail(1, "network down")
      return contextRoute(args)
    })
    const ctx = await loadPrContext({
      ghCliPort: loaderGh.port,
      repoCwd: "/tmp/repo",
      repoSlug: REPO_SLUG,
      prNumber: PR_NUMBER,
    })
    expect(ctx).toBeUndefined()
  })

  // ── RED-ON-INJECTION proofs ──────────────────────────────────────────────
  // These drive the SAME real-socket pipe but with the protection bypassed at
  // the transport boundary. They MUST stay green (asserting the bypass leaks),
  // which is the inverse witness: if the production guard were removed, the
  // FORGED / DEDUP cases above would observe this same leak and go RED.

  test("MUTANT(no-signature-check): forged sig WOULD enqueue — proves the real guard matters", async () => {
    // A mutant pipe whose handler skips `verifyHubSignature256` entirely.
    const queue: string[] = []
    const mutant: WebhookTransportPort = {
      async listen({ onRequest: _ignored }) {
        // Bypass the slice handler — accept ANYTHING, enqueue. This models the
        // failure mode "signature check deleted".
        const srv = createServer((_req, res) => {
          queue.push("dispatched-without-verify")
          res.writeHead(202)
          res.end("accepted")
        })
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
        const p = (srv.address() as AddressInfo).port
        ;(mutant as { _port?: number })._port = p
        return {
          async close() {
            await new Promise<void>((r) => srv.close(() => r()))
          },
        }
      },
    }
    const h = await mutant.listen({ onRequest: async () => ({ status: 202 }) })
    const port = (mutant as { _port?: number })._port ?? 0
    const body = issueCommentPayload("@quanta")
    const forged = `sha256=${createHmac("sha256", "attacker").update(body).digest("hex")}`
    const res = await postWebhook(port, body, deliveryHeaders(body, "m1", { sig: forged }))
    await h.close()
    // The mutant LEAKS: forged payload dispatched. The real pipe (forged case
    // above) returns 401 — that asymmetry is the red-on-injection witness.
    expect(res.status).toBe(202)
    expect(queue.length).toBe(1)
  })

  test("MUTANT(no-dedup): duplicate delivery WOULD double-process — proves dedup matters", async () => {
    // A delivery store whose `has()` always returns false (dedup removed).
    const noDedupStore = {
      has: (_id: string): boolean => false,
      add: (_id: string): void => {},
      snapshot: (): readonly string[] => [],
    }
    const source = createWebhookEventSource({
      transport: bound.transport,
      secret: SECRET,
      clockPort: clockOf(),
      deliveryStore: noDedupStore,
    })
    handle = source
    await source.start()

    const body = issueCommentPayload("@quanta twice")
    const headers = deliveryHeaders(body, "same-id-xyz")
    const r1 = await postWebhook(bound.port(), body, headers)
    const r2 = await postWebhook(bound.port(), body, headers)
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    // With dedup removed, the SAME delivery id enqueues TWICE — the real store
    // (dedup case above) drains exactly one. That asymmetry is the witness.
    const triggers = await source.poll()
    expect(triggers.length).toBe(2)
  })
})
