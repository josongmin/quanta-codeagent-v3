import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { GATES } from "../../tools/dev/gate-manifest"
import { expandTestFiles } from "../../tools/dev/sandboxed-test"
import { assertScanPopulation } from "./_shared/scan-population"

const ROOT = join(import.meta.dir, "..", "..")
const AUDIT_PATH = "docs/bugbash/sep-05-duplicate-development.md"
const REGISTER_PATH =
  "docs/plans/sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md"
const EXECUTION_INDEX_PATH = "docs/plans/sep-5-duplicate-development/tickets/README.md"
const PROMPT_PACK_PATH = "docs/plans/sep-5-duplicate-development/prompts/README.md"
const AUDIT_IDS = Array.from({ length: 31 }, (_, index) => `D${index}`)

const EXPECTED_DISPOSITIONS = {
  execute: [],
  conditional: ["D7", "D8", "D13", "D15", "D16", "D17", "D21", "D22", "D23", "D25", "D26"],
  intentional: ["D29"],
  closed: [
    "D0",
    "D1",
    "D2",
    "D3",
    "D4",
    "D5",
    "D6",
    "D9",
    "D10",
    "D11",
    "D12",
    "D14",
    "D18",
    "D19",
    "D20",
    "D24",
    "D27",
    "D28",
    "D30",
  ],
} as const satisfies Readonly<Record<AuditDisposition, readonly string[]>>

// Findings closed by a landed implementation ticket. The remaining closed
// false-positive/intentional findings belong in SEP5-11 so they cannot return
// as unscoped cleanup.
const IMPLEMENTED_FINDINGS = [
  "D0",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D10",
  "D11",
  "D19",
  "D27",
  "D28",
] as const

const EXPECTED = [
  "tests/unit/cli/gh-exec-policy-hellgate.test.ts",
  "tests/unit/tool/gh-pr-comment-outbound-policy.test.ts",
  "tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts",
  "tests/unit/secret-sink-parity-hellgate.test.ts",
  "tests/unit/auth/private-file-atomic.test.ts",
  "tests/unit/auth/chatgpt-refresh-transaction.test.ts",
  "tests/integration/chatgpt-refresh-cross-process.test.ts",
  "tests/unit/migration/claude-config-entrypoint-parity.test.ts",
  "tests/unit/cli/mcp-name-surface-parity.test.ts",
  "tests/unit/permission/thread-permission-entrypoint-parity.test.ts",
  "tests/unit/shared/jsonrpc-envelope.test.ts",
  "tests/unit/retrieval-authority-manifest.test.ts",
  "tests/unit/knob-read-authority-parity.test.ts",
] as const

const TICKETS = [
  {
    id: "SEP5-00",
    path: "docs/plans/sep-5-duplicate-audit/tickets/SEP5-00-audit-truth.md",
    status: "LANDED",
    rails: [] as const,
  },
  {
    id: "SEP5-01",
    path: "docs/plans/sep-5-gh-safety/tickets/SEP5-01-gh-execution-authority.md",
    status: "LANDED",
    rails: ["tests/unit/cli/gh-exec-policy-hellgate.test.ts"],
  },
  {
    id: "SEP5-02",
    path: "docs/plans/sep-5-gh-safety/tickets/SEP5-02-pr-comment-outbound-safety.md",
    status: "LANDED",
    rails: [
      "tests/unit/tool/gh-pr-comment-outbound-policy.test.ts",
      "tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts",
    ],
  },
  {
    id: "SEP5-03",
    path: "docs/plans/sep-5-secret-detection/tickets/SEP5-03-secret-detector-parity.md",
    status: "LANDED",
    rails: ["tests/unit/secret-sink-parity-hellgate.test.ts"],
  },
  {
    id: "SEP5-04A",
    path: "docs/plans/sep-5-oauth-transaction/tickets/SEP5-04A-private-atomic-token-write.md",
    status: "LANDED",
    rails: ["tests/unit/auth/private-file-atomic.test.ts"],
  },
  {
    id: "SEP5-04B",
    path: "docs/plans/sep-5-oauth-transaction/tickets/SEP5-04B-chatgpt-refresh-transaction.md",
    status: "LANDED",
    rails: [
      "tests/unit/auth/chatgpt-refresh-transaction.test.ts",
      "tests/integration/chatgpt-refresh-cross-process.test.ts",
    ],
  },
  {
    id: "SEP5-05",
    path: "docs/plans/sep-5-migration-decoder/tickets/SEP5-05-claude-config-decoder.md",
    status: "LANDED",
    rails: ["tests/unit/migration/claude-config-entrypoint-parity.test.ts"],
  },
  {
    id: "SEP5-06",
    path: "docs/plans/sep-5-mcp-naming/tickets/SEP5-06-mcp-naming-authority.md",
    status: "LANDED",
    rails: ["tests/unit/cli/mcp-name-surface-parity.test.ts"],
  },
  {
    id: "SEP5-07",
    path: "docs/plans/sep-5-permission-validation/tickets/SEP5-07-permission-validator-authority.md",
    status: "LANDED",
    rails: ["tests/unit/permission/thread-permission-entrypoint-parity.test.ts"],
  },
  {
    id: "SEP5-08",
    path: "docs/plans/sep-5-jsonrpc-envelope/tickets/SEP5-08-jsonrpc-envelope-core.md",
    status: "LANDED",
    rails: ["tests/unit/shared/jsonrpc-envelope.test.ts"],
  },
  {
    id: "SEP5-09",
    path: "docs/plans/sep-5-retrieval-authority/tickets/SEP5-09-retrieval-authority-retirement.md",
    status: "LANDED",
    rails: ["tests/unit/retrieval-authority-manifest.test.ts"],
  },
  {
    id: "SEP5-10",
    path: "docs/plans/sep-5-knob-authority/tickets/SEP5-10-knob-owner-burndown.md",
    status: "LANDED",
    rails: ["tests/unit/knob-read-authority-parity.test.ts"],
  },
  {
    id: "SEP5-11",
    path: "docs/plans/sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md",
    status: "ACTIVE REGISTER",
    rails: [] as const,
  },
  {
    id: "SEP5-12",
    path: "docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md",
    status: "COMPLETE",
    rails: ["tests/unit/sep5-ratchet-enrollment.test.ts"],
  },
] as const

const walkTests = (dir: string, acc: string[] = []): string[] => {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walkTests(p, acc)
    else if (ent.endsWith(".test.ts")) acc.push(p.slice(ROOT.length + 1))
  }
  return acc
}

const assertSelected = (
  selected: readonly string[],
  expected: readonly string[],
): { ok: true } | { ok: false; missing: string } => {
  for (const path of expected) {
    if (!selected.includes(path)) return { ok: false, missing: path }
  }
  return { ok: true }
}

const parseFullSuiteRoots = (shardsSrc: string): string[] => {
  const block = shardsSrc.match(/full:\s*\[([\s\S]*?)\],\s*core:/)
  if (block?.[1] === undefined) {
    throw new Error("SUITE_ROOTS.full array not found in run-test-shards.ts")
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").filter((r) => r !== "")
}

const resolvedFullSuiteSelection = (roots: readonly string[]): string[] => {
  const abs = roots.map((root) => resolve(ROOT, root)).filter((dir) => existsSync(dir))
  return expandTestFiles(abs).map((file) => relative(ROOT, file))
}

type AuditDisposition = "execute" | "conditional" | "intentional" | "closed"

const auditDispositionIds = (
  markdown: string,
): Readonly<Record<AuditDisposition, readonly string[]>> => {
  const result: Record<AuditDisposition, string[]> = {
    execute: [],
    conditional: [],
    intentional: [],
    closed: [],
  }
  for (const match of markdown.matchAll(
    /^\| \[D(\d+)\]\(#d\d+\) \| (execute|conditional|intentional|closed) \|/gm,
  )) {
    result[match[2] as AuditDisposition].push(`D${match[1]}`)
  }
  for (const ids of Object.values(result)) ids.sort()
  return result
}

const auditHeadingIds = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/^## (D\d+)\./gm)].map((match) => match[1] ?? "").sort()

const allDispositionIds = (
  dispositions: Readonly<Record<AuditDisposition, readonly string[]>>,
): readonly string[] => Object.values(dispositions).flat().sort()

const registerIds = (markdown: string, heading: string): readonly string[] => {
  const start = markdown.indexOf(`## ${heading}`)
  if (start < 0) throw new Error(`missing register heading: ${heading}`)
  const next = markdown.indexOf("\n## ", start + 4)
  const section = markdown.slice(start, next < 0 ? undefined : next)
  return [...section.matchAll(/^\| (D\d+) \|/gm)].map((m) => m[1] ?? "").sort()
}

const isTracked = (path: string): boolean => {
  const result = Bun.spawnSync(["git", "ls-files", "--error-unmatch", path], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  })
  return result.exitCode === 0
}

const ticketMarkdownPaths = (): readonly string[] => {
  const plansRoot = join(ROOT, "docs", "plans")
  const paths: string[] = []
  for (const packet of readdirSync(plansRoot)) {
    if (!packet.startsWith("sep-5-")) continue
    const ticketsDir = join(plansRoot, packet, "tickets")
    if (!existsSync(ticketsDir)) continue
    for (const name of readdirSync(ticketsDir)) {
      if (name.endsWith(".md") && name !== "README.md") {
        paths.push(relative(ROOT, join(ticketsDir, name)))
      }
    }
  }
  return paths.sort()
}

const indexLinkedPaths = (markdown: string): ReadonlySet<string> =>
  new Set(
    [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)].map((match) =>
      relative(ROOT, resolve(dirname(join(ROOT, EXECUTION_INDEX_PATH)), match[1] ?? "")),
    ),
  )

const validateTicket = (
  ticket: (typeof TICKETS)[number],
  markdown: string | undefined,
  linked: ReadonlySet<string>,
): readonly string[] => {
  if (markdown === undefined) return [`${ticket.id}:missing-ticket`]
  const errors: string[] = []
  const status = markdown.match(/^\*\*Status:\*\* ([^\n]+)/m)?.[1]
  if (!status?.startsWith(ticket.status)) errors.push(`${ticket.id}:status`)
  if (!linked.has(ticket.path)) errors.push(`${ticket.id}:index-link`)
  if (!isTracked(ticket.path)) errors.push(`${ticket.id}:untracked`)
  for (const rail of ticket.rails) {
    if (!existsSync(join(ROOT, rail))) errors.push(`${ticket.id}:missing-rail:${rail}`)
    if (!markdown.includes(`\`${rail}\``)) errors.push(`${ticket.id}:undocumented-rail:${rail}`)
  }
  return errors
}

const validateTicketManifest = (
  contents: ReadonlyMap<string, string>,
  indexMarkdown: string,
): readonly string[] => {
  const linked = indexLinkedPaths(indexMarkdown)
  return TICKETS.flatMap((ticket) => validateTicket(ticket, contents.get(ticket.path), linked))
}

describe("SEP5 ratchet enrollment", () => {
  test("expected primary-file list is frozen and every path exists", () => {
    expect(EXPECTED.length).toBe(13)
    for (const path of EXPECTED) {
      expect(existsSync(join(ROOT, path))).toBe(true)
    }
  })

  test("prepush full-suite selection includes every primary file", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["test:ci"]).toBe("bun run prepush")
    const fullGate = GATES.find((g) => g.id === "full-suite")
    expect(fullGate?.run.includes("test:full:ci")).toBe(true)
    expect(pkg.scripts["test:full:ci"] ?? "").toContain("--suite=full")

    const shardsSrc = readFileSync(join(ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    const roots = parseFullSuiteRoots(shardsSrc)
    expect(roots).toContain("tests/unit")
    expect(roots).toContain("tests/integration")

    const selected = resolvedFullSuiteSelection(roots)
    const testsRoot = join(ROOT, "tests")
    assertScanPopulation(
      walkTests(testsRoot).map((p) => join(ROOT, p)),
      testsRoot,
      {
        id: "tests/unit/sep5-ratchet-enrollment.test.ts#TESTS",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    expect(selected.length).toBeGreaterThan(0)
    expect(assertSelected(selected, EXPECTED)).toEqual({ ok: true })
  })

  test("synthetic missing path is rejected", () => {
    const selected = walkTests(join(ROOT, "tests"))
    expect(assertSelected(selected, ["tests/unit/does-not-exist.test.ts"]).ok).toBe(false)
  })

  test("removing one expected path from a cloned selection fails for that path", () => {
    const shardsSrc = readFileSync(join(ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    const selected = resolvedFullSuiteSelection(parseFullSuiteRoots(shardsSrc)).filter(
      (p) => p !== EXPECTED[0],
    )
    const r = assertSelected(selected, EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toBe(EXPECTED[0])
  })

  test("mutation: dropping tests/unit from parsed full roots misses a primary", () => {
    const selected = resolvedFullSuiteSelection(["tests/integration", "tests/meta"])
    const r = assertSelected(selected, EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toBe(EXPECTED[0])
  })

  test("audit dispositions and SEP5-11 register are a closed, exact universe", () => {
    const auditMarkdown = readFileSync(join(ROOT, AUDIT_PATH), "utf8")
    const audit = auditDispositionIds(auditMarkdown)
    const register = readFileSync(join(ROOT, REGISTER_PATH), "utf8")

    expect(allDispositionIds(audit)).toEqual([...AUDIT_IDS].sort())
    expect(auditHeadingIds(auditMarkdown)).toEqual([...AUDIT_IDS].sort())
    for (const disposition of Object.keys(EXPECTED_DISPOSITIONS) as AuditDisposition[]) {
      expect(audit[disposition]).toEqual([...EXPECTED_DISPOSITIONS[disposition]].sort())
    }
    expect(registerIds(register, "Conditional items")).toEqual(audit.conditional)
    expect(registerIds(register, "Closed items")).toEqual(
      [...audit.closed, ...audit.intentional]
        .filter((id) => !IMPLEMENTED_FINDINGS.includes(id as (typeof IMPLEMENTED_FINDINGS)[number]))
        .sort(),
    )
  })

  test("ticket manifest is an exact, tracked, linked status and proof universe", () => {
    expect(TICKETS.map((ticket) => ticket.id)).toEqual([
      "SEP5-00",
      "SEP5-01",
      "SEP5-02",
      "SEP5-03",
      "SEP5-04A",
      "SEP5-04B",
      "SEP5-05",
      "SEP5-06",
      "SEP5-07",
      "SEP5-08",
      "SEP5-09",
      "SEP5-10",
      "SEP5-11",
      "SEP5-12",
    ])
    expect(ticketMarkdownPaths()).toEqual(TICKETS.map((ticket) => ticket.path).sort())
    const contents = new Map(
      TICKETS.map((ticket) => [ticket.path, readFileSync(join(ROOT, ticket.path), "utf8")]),
    )
    const index = readFileSync(join(ROOT, EXECUTION_INDEX_PATH), "utf8")
    expect(validateTicketManifest(contents, index)).toEqual([])
  })

  test("governance packet tracking and terminal copy cannot regress", () => {
    const index = readFileSync(join(ROOT, EXECUTION_INDEX_PATH), "utf8")
    const promptPack = readFileSync(join(ROOT, PROMPT_PACK_PATH), "utf8")
    expect(isTracked(PROMPT_PACK_PATH)).toBe(true)
    expect(isTracked(REGISTER_PATH)).toBe(true)
    for (const markdown of [index, promptPack]) {
      expect(markdown).not.toContain("currently untracked")
      expect(markdown).not.toContain("commit pending")
      expect(markdown).not.toContain("delivery remains pending")
    }
    expect(promptPack).toContain("historical truth snapshot")
    expect(promptPack).toContain("freeze the current")
    expect(promptPack).toContain("Do not dispatch these historical implementation")
  })

  test("mutation: omitting one conditional item breaks exact register parity", () => {
    const audit = auditDispositionIds(readFileSync(join(ROOT, AUDIT_PATH), "utf8"))
    const register = readFileSync(join(ROOT, REGISTER_PATH), "utf8")
    const mutated = register.replace(/^\| D15 \|.*\n/m, "")
    expect(registerIds(mutated, "Conditional items")).not.toEqual(audit.conditional)
  })

  test("mutation: a duplicate disposition ID cannot hide a missing audit finding", () => {
    const auditMarkdown = readFileSync(join(ROOT, AUDIT_PATH), "utf8")
    const mutated = auditMarkdown.replace("| [D15](#d15) |", "| [D14](#d14) |")
    expect(allDispositionIds(auditDispositionIds(mutated))).not.toEqual([...AUDIT_IDS].sort())
  })

  test("mutation: swapping two finding dispositions is rejected by exact identity", () => {
    const auditMarkdown = readFileSync(join(ROOT, AUDIT_PATH), "utf8")
    const mutated = auditMarkdown
      .replace("| [D7](#d7) | conditional |", "| [D7](#d7) | closed |")
      .replace("| [D9](#d9) | closed |", "| [D9](#d9) | conditional |")
    const dispositions = auditDispositionIds(mutated)
    expect(dispositions.closed).toHaveLength(EXPECTED_DISPOSITIONS.closed.length)
    expect(dispositions.conditional).toHaveLength(EXPECTED_DISPOSITIONS.conditional.length)
    expect(dispositions.closed).not.toEqual([...EXPECTED_DISPOSITIONS.closed].sort())
    expect(dispositions.conditional).not.toEqual([...EXPECTED_DISPOSITIONS.conditional].sort())
  })

  test("mutation: missing ticket, damaged status, and broken index link are each named", () => {
    const contents = new Map(
      TICKETS.map((ticket) => [ticket.path, readFileSync(join(ROOT, ticket.path), "utf8")]),
    )
    const index = readFileSync(join(ROOT, EXECUTION_INDEX_PATH), "utf8")

    const missing = new Map(contents)
    missing.delete(TICKETS[1].path)
    expect(validateTicketManifest(missing, index)).toContain("SEP5-01:missing-ticket")

    const damagedStatus = new Map(contents)
    damagedStatus.set(
      TICKETS[2].path,
      (damagedStatus.get(TICKETS[2].path) ?? "").replace(
        "**Status:** LANDED",
        "**Status:** PLANNED",
      ),
    )
    expect(validateTicketManifest(damagedStatus, index)).toContain("SEP5-02:status")

    const brokenIndex = index.replace(
      "../../sep-5-secret-detection/tickets/SEP5-03-secret-detector-parity.md",
      "../../sep-5-secret-detection/tickets/missing.md",
    )
    expect(validateTicketManifest(contents, brokenIndex)).toContain("SEP5-03:index-link")
  })
})
