/**
 * GUARD — no test in this repository may use a link-local / cloud-metadata
 * address as a NETWORK TARGET (TVH-01).
 *
 * ## The defect
 *
 * `tests/integration/browser-real-chrome-adversarial-e2e.test.ts` served a
 * fixture page whose inline `<script>` did a real
 * `fetch('http://<IMDS address>/latest/meta-data/')`. Every run of that suite
 * was a genuine egress attempt at the cloud instance-metadata service of
 * whatever host executed it — which on a cloud CI runner is a live endpoint
 * that answers with instance credentials. It also made the assertion
 * unfalsifiable: on a laptop the address simply connect-times-out, so the
 * "no leak was reported" expectation held regardless of behaviour.
 *
 * ## Why a grep would be WRONG, and would be rejected
 *
 * These addresses are the INPUT to this repo's SSRF defences, and the suites
 * that test those defences must spell them out:
 *
 *     classifyHost("<IMDS>")                       ← pure classifier input
 *     const DENIED = ["http://<IMDS>/", …]         ← a deny table
 *     const resolveHost: HostResolver = async () => ["<IMDS>"]
 *     redirectTo("https://<IMDS>/latest/meta-data/")  ← a scripted fetcher
 *     decideEgress({ host: "<IMDS>", allowlist: ["<IMDS>"] })
 *
 * At the time of writing that is 101 occurrences across 19 files, every one of
 * them legitimate. A guard that greps the literal fails all 19; the "fix" is an
 * allowlist of those 19 files, and the next real egress lands in one of them.
 *
 * So the guard is STRUCTURAL: `tests/_helpers/link-local-usage.ts` walks the
 * TypeScript AST and asks where the literal SITS — does it flow into an
 * argument of something that opens a socket (`fetch`, `Bun.spawn`, `execSync`,
 * `net.connect`, `port.navigate`, a `$` shell template), or into an embedded
 * `<script>`/HTML attribute/shell word that does. A literal consumed by any
 * other callee is data. A literal in a COMMENT is not a literal at all, which
 * is why this file and the browser fixture can discuss the address in prose.
 *
 * ## Anti-vacuum
 *
 * A scan that reached nothing reports the same clean verdict as a clean repo,
 * so three separate floors stand under the zero:
 *
 *   • REACH — `assertScanPopulation` over both corpora, floored at the MEASURED
 *     tracked-file count from `tools/dev/scan-reach-baseline.json`, with
 *     recursive subtree coverage (a count alone cannot see a subtree vanish).
 *   • PREDICATE — the matched set: the files that actually contain an address.
 *     A detector that rotted selects nothing while the walk stays full.
 *   • CALL SITES — the number of occurrences actually CLASSIFIED, floored, plus
 *     named positive controls: the specific legitimate-input files must still
 *     be classified as data. "Inspected zero call sites" cannot pass.
 *
 * And the instrument is proved on fixtures in both directions (cases A and B):
 * an injected real `fetch` is RED, the five legitimate shapes above are GREEN.
 * Both run through the SAME function the repo scan uses — not a restatement
 * of it.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import {
  classifyLinkLocalUsages,
  LINK_LOCAL_SAMPLE,
  type LinkLocalOccurrence,
  mentionsLinkLocal,
} from "../_helpers/link-local-usage"
import { REPO_ROOT } from "../_helpers/repo-root"
import { assertScanPopulation } from "./_shared/scan-population"

const TESTS_ROOT = join(REPO_ROOT, "tests")
const SRC_ROOT = join(REPO_ROOT, "src")
const SCAN_TIMEOUT_MS = 60_000

/**
 * The occurrence floor. Measured at 101 across the `tests/` tree on 2026-09-12;
 * pinned below that so ordinary churn in the SSRF suites does not trip it, but
 * far enough above zero that a classifier which stopped finding literals — or a
 * walk that stopped reaching the SSRF suites — cannot report a clean zero.
 */
const MIN_CLASSIFIED_CALL_SITES = 60

/**
 * NAMED POSITIVE CONTROLS. These files exist to feed link-local addresses to a
 * pure classifier; if the guard ever reports them as network use it has become
 * the grep it replaced, and if it stops seeing them at all the scan has rotted.
 * Both directions are asserted.
 */
const LEGITIMATE_CLASSIFIER_INPUT = [
  "tests/unit/browser-edge-ssrf-hellgate.test.ts",
  "tests/unit/ssrf-typed-policy-hellgate.test.ts",
  "tests/unit/browser-tool-hellgate.test.ts",
  "tests/unit/tls-mitm-bun-bridge-hellgate.test.ts",
  "tests/unit/ssrf-egress-deep-security-r6-hellgate.test.ts",
  "tests/unit/ssrf-classifier-hellgate.test.ts",
  "tests/unit/tool/ssrf-redirect-bypass-hellgate.test.ts",
  "tests/integration/browser-edge-injection-e2e.test.ts",
] as const

const walk = (dir: string, keep: (path: string) => boolean, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    // `withFileTypes` reports a symlink as neither file nor directory; resolve
    // it rather than silently dropping whatever it points at.
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory())
    if (isDir) walk(path, keep, out)
    else if (keep(path)) out.push(path)
  }
  return out
}

interface ScanResult {
  readonly scanned: readonly string[]
  readonly withAddress: readonly string[]
  readonly occurrences: readonly LinkLocalOccurrence[]
}

const scan = (root: string, keep: (path: string) => boolean): ScanResult => {
  const scanned = walk(root, keep)
  const withAddress: string[] = []
  const occurrences: LinkLocalOccurrence[] = []
  for (const file of scanned) {
    const source = readFileSync(file, "utf8")
    if (!mentionsLinkLocal(source)) continue
    const found = classifyLinkLocalUsages(relative(REPO_ROOT, file), source)
    if (found.length === 0) continue
    withAddress.push(file)
    occurrences.push(...found)
  }
  return { scanned, withAddress, occurrences }
}

const render = (o: LinkLocalOccurrence): string =>
  `${o.file}:${o.line}:${o.column} — ${o.address} used as a NETWORK TARGET (${o.site}): ${o.excerpt}`

// ── fixtures: the instrument, proved in both directions ─────────────────────
const A = LINK_LOCAL_SAMPLE

/** Real network use, in every shape the classifier claims to catch. */
const NETWORK_FIXTURES: readonly { readonly why: string; readonly source: string }[] = [
  {
    why: "a bare fetch of the metadata endpoint",
    source: `await fetch("http://${A}/latest/meta-data/")`,
  },
  {
    why: "a fetch whose url is assembled in a template",
    source: `const host = "${A}"\nawait fetch(\`http://\${host}/latest/meta-data/\`)`,
  },
  { why: "a fetch of a url built by concatenation", source: `fetch("http://" + "${A}" + "/")` },
  { why: "new URL passed to fetch", source: `fetch(new URL("http://${A}/"))` },
  { why: "a spawned curl", source: `Bun.spawn(["curl", "-s", "http://${A}/latest/meta-data/"])` },
  { why: "execSync with a shell command line", source: `execSync("curl -s http://${A}/")` },
  { why: "a node http.get", source: `http.get("http://${A}/latest/meta-data/", cb)` },
  { why: "a browser port navigation", source: `await port.navigate(handle, "http://${A}/")` },
  { why: "a WebSocket", source: `new WebSocket("ws://${A}/")` },
  {
    why: "an in-page fetch inside an embedded <script> (the original defect)",
    source:
      "const page = `<!doctype html><body><script>fetch('http://" +
      A +
      "/latest/meta-data/')</" +
      "script></body>`",
  },
  {
    why: "an HTML attribute the browser fetches",
    source: `const page = \`<img src="http://${A}/meta.png" />\``,
  },
  {
    // MUTATION SURVIVOR, closed: emptying `SHELL_TAGS` left the suite 12/12
    // green, so a future ``await $`curl http://<addr>/latest/meta-data` ``
    // would have passed the SSRF guard. `NETWORK_SINKS` and
    // `NETWORK_RECEIVERS` were both covered; the third sink family — tagged
    // shell templates — was not.
    why: "a Bun shell tag running curl",
    source: `await $\`curl -s http://${A}/latest/meta-data/\``,
  },
  {
    why: "a Bun shell tag through the `sh` alias",
    source: `await sh\`wget -qO- http://${A}/\``,
  },
  {
    why: "a CDP Runtime.evaluate expression",
    source: `port.cdp(h, "Runtime.evaluate", { expression: "fetch('http://${A}/')" })`,
  },
]

/** The legitimate shapes this repository genuinely uses. All must stay GREEN. */
const DATA_FIXTURES: readonly { readonly why: string; readonly source: string }[] = [
  { why: "pure classifier input", source: `expect(classifyHost("${A}")).not.toBeNull()` },
  {
    why: "a deny table",
    source: `const DENIED = ["http://${A}/", "http://${A}/latest/meta-data/iam/"]`,
  },
  { why: "a table-driven case tuple", source: `const CASES = [["metadata", "${A}"]] as const` },
  {
    why: "a stubbed resolver returning the address",
    source: `const resolveHost: HostResolver = async () => ["${A}"]`,
  },
  {
    why: "a scripted fetcher's redirect target",
    source: `scriptedFetch({ [start]: redirectTo("https://${A}/a.png") })`,
  },
  {
    why: "an options object handed to a pure decision function",
    source: `decideEgress({ host: "${A}", allowlist: ["${A}"], amendments })`,
  },
  {
    why: "a tool-registry dispatch the suite asserts is DENIED",
    source: `await reg.run("browser_navigate", { url: "http://${A}/" }, CTX)`,
  },
  {
    why: "inert text inside an embedded page (same template, no call site)",
    source: `const page = \`<!doctype html><body><div>${A}</div></body>\``,
  },
  { why: "an assertion on a denial reason", source: `expect(reason).toContain("${A}")` },
  {
    why: "a peer-host stub",
    source: `const reboundPrivatePeer: ResolvePeerHost = () => "${A}"`,
  },
]

describe("link-local / metadata addresses are never a NETWORK target in test source", () => {
  test("A. RED ON INJECTION — every real network shape is classified as network use", () => {
    for (const fixture of NETWORK_FIXTURES) {
      const found = classifyLinkLocalUsages("fixture.ts", fixture.source)
      expect(
        found.length,
        `${fixture.why}: no address found at all — ${fixture.source}`,
      ).toBeGreaterThan(0)
      expect(
        found.filter((o) => o.verdict === "network").map((o) => o.site),
        `${fixture.why} MUST be network use — ${fixture.source}`,
      ).not.toEqual([])
    }
  })

  test("B. PAIRED CONTROL — the legitimate classifier-input shapes stay data", () => {
    for (const fixture of DATA_FIXTURES) {
      const found = classifyLinkLocalUsages("fixture.ts", fixture.source)
      // The address must be SEEN (otherwise "not network" is vacuous)…
      expect(found.length, `${fixture.why}: no address found — ${fixture.source}`).toBeGreaterThan(
        0,
      )
      // …and judged data.
      expect(
        found.filter((o) => o.verdict === "network").map(render),
        `${fixture.why} is classifier INPUT, not egress — ${fixture.source}`,
      ).toEqual([])
    }
  })

  test(
    "C. no test source in tests/ uses a link-local address as a network target",
    () => {
      const result = scan(TESTS_ROOT, (p) => p.endsWith(".ts"))

      // THE VERDICT FIRST, deliberately. The reach floors below intersect the
      // scan with `git ls-files`, so an UNCOMMITTED file carrying a real egress
      // would otherwise report as "a matched path the scan never reached" —
      // true, unhelpful, and not the thing that is wrong. A violation must
      // name itself, whether or not it has been committed yet.
      expect(
        result.occurrences.filter((o) => o.verdict === "network").map(render),
        "a test may not open a socket to a link-local / cloud-metadata address. " +
          "Serve a fake metadata document from a loopback origin instead (see " +
          "tests/integration/browser-real-chrome-adversarial-e2e.test.ts).",
      ).toEqual([])

      // FLOOR 1 — the guard actually classified call sites, not zero of them.
      expect(
        result.occurrences.length,
        "the classifier inspected too few call sites — a detector that stopped " +
          "matching reports the same clean zero as a clean tree",
      ).toBeGreaterThanOrEqual(MIN_CLASSIFIED_CALL_SITES)
      // FLOOR 2 — the named legitimate-input files are still being classified.
      const seen = new Set(result.occurrences.map((o) => o.file))
      expect(
        LEGITIMATE_CLASSIFIER_INPUT.filter((f) => !seen.has(f)),
        "these files feed link-local addresses to a pure classifier and must be " +
          "reached by the scan; if one was renamed, update the control list",
      ).toEqual([])
      // FLOOR 3 + 4 — reach (tracked, recursive subtree coverage) and predicate.
      assertScanPopulation(result.scanned, TESTS_ROOT, {
        id: "tests/unit/link-local-network-use-guard.test.ts#TESTS",
        collectable: (name) => name.endsWith(".ts"),
        matched: result.withAddress,
      })
    },
    SCAN_TIMEOUT_MS,
  )

  test(
    "C2. the same holds for colocated tests under src/",
    () => {
      const result = scan(SRC_ROOT, (p) => p.endsWith(".test.ts"))
      assertScanPopulation(result.scanned, SRC_ROOT, {
        id: "tests/unit/link-local-network-use-guard.test.ts#SRC-TESTS",
        collectable: (name) => name.endsWith(".test.ts"),
      })
      expect(
        result.occurrences.filter((o) => o.verdict === "network").map(render),
        "a colocated test may not open a socket to a link-local / metadata address",
      ).toEqual([])
    },
    SCAN_TIMEOUT_MS,
  )

  test("E. PRECISION — one real fetch in a page does not condemn every other mention in it", () => {
    // A measured defect in the instrument itself: the embedded-source rules used
    // to answer "does this fragment contain ANY network use", so one real
    // in-page `fetch` marked every other appearance of the address in the same
    // page — including inert body text — as egress. A guard that cannot say
    // WHICH occurrence is the violation cannot be acted on.
    const page =
      "const PAGE = `<!doctype html><body>" +
      `<div id="out">${A} is the metadata address</div>` +
      "<script>fetch('http://" +
      A +
      "/latest/meta-data/')</" +
      "script></body>`"
    const found = classifyLinkLocalUsages("page.ts", page)
    expect(found.length, "both mentions must be seen").toBe(2)
    const network = found.filter((o) => o.verdict === "network")
    expect(network.length, `exactly the <script> fetch, not the <div>: ${found.map(render)}`).toBe(
      1,
    )
    expect(network[0]?.site).toContain("embedded <script>")
    expect(network[0]?.excerpt).toContain("fetch(")
    // The inert one stayed data.
    expect(found.filter((o) => o.verdict === "data").length).toBe(1)
  })

  test("D. the instrument needs no self-exemption", () => {
    // Every address pattern in the classifier is assembled from parts, so the
    // detector scores zero against its own scan. This matters: the alternative
    // is exempting the detector's file, and an exempted file is a hole exactly
    // the size of the detector.
    for (const rel of [
      "tests/_helpers/link-local-usage.ts",
      "tests/unit/link-local-network-use-guard.test.ts",
    ]) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8")
      expect(
        classifyLinkLocalUsages(rel, source).map(render),
        `${rel} must not itself contain a spelled-out link-local address`,
      ).toEqual([])
    }
    // …and the sample it hands fixtures really is one.
    expect(mentionsLinkLocal(LINK_LOCAL_SAMPLE)).toBe(true)
  })
})
