/**
 * ★ The catalog offered operators environment variables that no code reads.
 *
 * `config_refs.env`, `knobs` and the default-off ledger's `gate_owner` all name
 * env switches, and all three are read by operators and CI authors. The names
 * were checked by nothing, and a CI job copied from the TVH-03 handoff set
 * `QUANTA_REQUIRE_CAPABILITY`, which armed nothing, and reported a pass.
 *
 * Every rule in `tools/dev/catalog-config-refs.ts` has been wrong at least once,
 * and each time an audit of the guard found it rather than the guard finding
 * itself. So this file pins three different things, deliberately separately:
 *
 *  - the RATCHET over the real tree (no declared name unread);
 *  - SENTINELS that prove each root and each evidence shape still yields what it
 *    yielded when measured, so a silently dead shape fails as a shape and not as
 *    catalog drift;
 *  - FIXTURE arms, one per rule, through the real function on a scratch tree.
 *
 * No totals of "how many false claims" appear here. Three successive versions of
 * that sentence were wrong.
 *
 * The scan reads ~8,500 files. It runs in `beforeAll`, not at module load: a
 * module-scope scan behind an import is invisible to the module-load effect
 * guard, and it was paid by every run that merely collected this file.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import {
  type CatalogEnvSource,
  catalogCorpus,
  type DeclaredEnvNames,
  declaredEnvNames,
  describeUnbackedEnvNames,
  type EnvEvidence,
  type EnvEvidenceKind,
  envEvidenceAll,
  envEvidenceIndex,
  envKnobNames,
  gateOwnerEnvNames,
  unbackedEnvNames,
} from "../../../tools/dev/catalog-config-refs"
import { loadDefaultOffLedger } from "../../../tools/feature-catalog/default-off-ledger-checker"
import { REPO_ROOT } from "../../../tools/feature-catalog/paths"
import { loadFeaturesStrict } from "../../../tools/feature-catalog/schema"

/**
 * Shell and workflow fixtures need a literal `${`. Spelled through this constant
 * so a fixture is not mistaken for a broken template literal.
 */
const DOLLAR = "$"

const RETIRED = "QUANTA_REQUIRE_CAPABILITY"
const LIVE = "QUANTA_REQUIRE_CAPABILITIES"
const FABRICATED = "QUANTA_NOTHING_READS_THIS_NAME"
const REAL_CONTROL = "QUANTA_TEST_CACHE"

/**
 * One name per root × shape, each MEASURED on this tree before being written
 * here. A root that stops being scanned, or a shape that stops matching, fails
 * on its sentinel and says which — the count floors this replaces could lose the
 * entire `native/` root and pass, reporting the fallout as catalog drift.
 */
const SENTINELS: readonly (readonly [string, EnvEvidenceKind, string])[] = [
  ["SCREEN_OCR_DEBUG", "quoted", "native/"],
  ["QUANTA_SHADOW_MATRIX", "workflow", ".github/workflows/"],
  ["VITE_QUANTA_WS_URL", "ts-literal", "apps/"],
  ["QUANTA_TEST_NO_USER_LIBRARY", "ts-access", "tools/"],
  ["QUANTA_SMOKE_LIVE", "ts-access", "tests/"],
  // A `.ts` file with generic arrows. Parsed as TSX it misparses and the read
  // at otel-exporter.ts:629 disappears; this name was then backed only by an
  // inventory literal elsewhere.
  ["QUANTA_OTEL_BATCH_SIZE", "ts-access", "src/observability/"],
  ["QUANTA_BENCH_PRESET", "shell", "package.json"],
  // An extensionless bash script outside every root the old corpus scanned.
  ["QUANTA_TERMINAL_BRAIN_REPO", "shell", "adapters/"],
]

interface Scan {
  readonly records: readonly CatalogEnvSource[]
  readonly declared: DeclaredEnvNames
  readonly files: readonly string[]
  readonly all: ReadonlyMap<string, readonly EnvEvidence[]>
}
let scan: Scan | undefined
const scanned = (): Scan => {
  if (scan === undefined) throw new Error("beforeAll did not run")
  return scan
}

beforeAll(async () => {
  const features = await loadFeaturesStrict()
  const ledger = await loadDefaultOffLedger(
    join(REPO_ROOT, "tools", "feature-catalog", "default-off-ledger.yaml"),
  )
  const records: CatalogEnvSource[] = [
    ...features.map(({ feature, path }) => ({
      path: relative(REPO_ROOT, path),
      env: [
        ...(feature.config_refs?.env ?? []),
        ...envKnobNames(feature.knobs as Parameters<typeof envKnobNames>[0]),
      ],
    })),
    ...ledger.rows.map((row) => ({
      path: `tools/feature-catalog/default-off-ledger.yaml#${row.feature_id}.gate_owner`,
      env: gateOwnerEnvNames(row.gate_owner),
    })),
  ]
  const declared = declaredEnvNames(records)
  const files = catalogCorpus(REPO_ROOT)
  const all = envEvidenceAll(
    REPO_ROOT,
    [
      ...declared.keys(),
      ...SENTINELS.map(([name]) => name),
      RETIRED,
      LIVE,
      FABRICATED,
      REAL_CONTROL,
    ],
    files,
  )
  scan = { records, declared, files, all }
}, 120_000)

describe("every env name the catalog offers is one some code reads", () => {
  test("SENTINELS — every root and every shape still yields what it was measured to", () => {
    const { all, declared, files } = scanned()
    // Anti-vacuity on the inputs, loose on purpose: the sentinels are what bite.
    expect(files.length).toBeGreaterThan(5_000)
    expect(declared.size).toBeGreaterThan(400)
    for (const [name, kind, prefix] of SENTINELS) {
      const hit = (all.get(name) ?? []).find(
        (evidence) => evidence.kind === kind && evidence.where.startsWith(prefix),
      )
      expect({ name, kind, prefix, found: hit !== undefined }).toEqual({
        name,
        kind,
        prefix,
        found: true,
      })
    }
    // ...and the sentinels cover every shape the module declares.
    expect([...new Set(SENTINELS.map(([, kind]) => kind))].sort()).toEqual([
      "quoted",
      "shell",
      "ts-access",
      "ts-literal",
      "workflow",
    ])
  })

  test("RATCHET — no declared env name is backed by nothing", () => {
    const { declared, all } = scanned()
    const unbacked = unbackedEnvNames(declared, all)
    expect(unbacked.length === 0 ? "" : describeUnbackedEnvNames(unbacked)).toBe("")
  })

  test("the ledger's gate_owner and knobs WITHOUT `where: env` are declarations too", () => {
    const { records } = scanned()
    // Both were extracted by nothing, and five names — three knobs, two ledger
    // owners — sat unread behind that gap.
    expect(records.some((record) => record.path.includes("default-off-ledger.yaml#"))).toBe(true)
    expect(envKnobNames([{ name: "QUANTA_NO_WHERE" }])).toEqual(["QUANTA_NO_WHERE"])
    expect(envKnobNames([{ name: "QUANTA_FILE_WHERE", where: "src/x.ts" }])).toEqual([
      "QUANTA_FILE_WHERE",
    ])
    expect(envKnobNames(["QUANTA_BARE_STRING"])).toEqual(["QUANTA_BARE_STRING"])
    // PAIRED CONTROLS — a CLI flag and a TypeScript property are not env names.
    expect(envKnobNames([{ name: "--trigger-phrase", where: "cli" }])).toEqual([])
    expect(envKnobNames([{ name: "AgentConfig.editRepair" }])).toEqual([])
    expect(gateOwnerEnvNames(["QUANTA_GATE", "config.flag"])).toEqual(["QUANTA_GATE"])
  })

  test("a retired name is NOT backed, though grep finds it four times", () => {
    const { all } = scanned()
    expect(all.has(RETIRED)).toBe(false)
    expect(all.get(LIVE)?.some((evidence) => evidence.kind === "ts-literal")).toBe(true)
  })

  test("RED ON INJECTION — a fabricated name is reported, a real one is not", () => {
    const { records, all } = scanned()
    const inject = (name: string) =>
      declaredEnvNames([
        ...records,
        { path: "tools/feature-catalog/features/00-injected.yaml", env: [name] },
      ])
    const unbacked = unbackedEnvNames(inject(FABRICATED), all)
    expect(unbacked.map(({ name }) => name)).toEqual([FABRICATED])
    expect(describeUnbackedEnvNames(unbacked)).toContain("00-injected.yaml")
    expect(unbackedEnvNames(inject(REAL_CONTROL), all)).toEqual([])
  })
})

/**
 * One rule at a time, through the real function on a scratch tree. Every case
 * here was measured wrong in a previous version of the guard.
 */
describe("what counts as evidence", () => {
  const inFixture = (files: Readonly<Record<string, string>>, names: readonly string[]) => {
    const root = mkdtempSync(join(tmpdir(), "cfgrefs-fixture-"))
    try {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true })
        writeFileSync(join(root, rel), body)
      }
      return envEvidenceIndex(root, names, Object.keys(files))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const backed = (found: ReadonlyMap<string, EnvEvidence>, names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, found.get(name)?.kind ?? null]))

  test("a COMMENT is never evidence — indented, trailing, block, or in a template", () => {
    const names = [
      "QUANTA_WF_TRAIL",
      "QUANTA_WF_INDENT",
      "QUANTA_WF_TEMPLATE",
      "QUANTA_SW_BLOCK",
      "QUANTA_WF_REAL",
      "QUANTA_SW_REAL",
    ]
    const found = inFixture(
      {
        ".github/workflows/ci.yml": [
          "jobs: # QUANTA_WF_TRAIL",
          "  a:",
          "    # QUANTA_WF_INDENT is documented here",
          "    steps:",
          `      - run: echo ${DOLLAR}{{ vars.QUANTA_WF_REAL }}`,
        ].join("\n"),
        ".github/workflows/bot.yml.template": `      - run: echo ${DOLLAR}{{ vars.QUANTA_WF_TEMPLATE }}\n`,
        "native/x.swift": [
          '/* environment["QUANTA_SW_BLOCK"] was removed */',
          'let v = ProcessInfo.processInfo.environment["QUANTA_SW_REAL"]',
        ].join("\n"),
      },
      names,
    )
    expect(backed(found, names)).toEqual({
      QUANTA_WF_TRAIL: null,
      QUANTA_WF_INDENT: null,
      QUANTA_WF_TEMPLATE: null,
      QUANTA_SW_BLOCK: null,
      QUANTA_WF_REAL: "workflow",
      QUANTA_SW_REAL: "quoted",
    })
  })

  test("a WRITE is not a read, in every spelling measured as one", () => {
    const names = [
      "QUANTA_EQ",
      "QUANTA_NULLISH",
      "QUANTA_OR",
      "QUANTA_PAREN",
      "QUANTA_DEL",
      "QUANTA_STRKEY",
      "QUANTA_TYPE",
      "QUANTA_RS_WRITE",
      "QUANTA_RHS",
      "QUANTA_RHS_ASSIGN",
    ]
    const found = inFixture(
      {
        // Semicolons on purpose: without them `"1"\n(process.env.X) = "1"` parses as a
        // CALL of "1", and the fixture — not the guard — made a write look like a read.
        // Semicolons on purpose: without them `"1"` followed by `(process.env.X) = "1"`
        // parses as a CALL of "1", and the FIXTURE made a write look like a read.
        "src/w.ts": [
          'process.env.QUANTA_EQ = "1";',
          'process.env.QUANTA_NULLISH ??= "1";',
          'process.env["QUANTA_OR"] ||= "1";',
          '(process.env.QUANTA_PAREN) = "1";',
          "delete process.env.QUANTA_DEL;",
          'const bag = { "QUANTA_STRKEY": "1" };',
          'type T = "QUANTA_TYPE";',
          // PAIRED CONTROL: a read on the RIGHT of `=` is still a read.
          "const y = process.env.QUANTA_RHS;",
          // ...and on the right of an assignment EXPRESSION — the case a write check
          // that ignores which side it is on gets wrong. A declaration is not one.
          "let z; z = process.env.QUANTA_RHS_ASSIGN;",
        ].join("\n"),
        "src/d.rs": 'cmd.env("QUANTA_RS_WRITE", "1");\n',
      },
      names,
    )
    expect(backed(found, names)).toEqual({
      QUANTA_EQ: null,
      QUANTA_NULLISH: null,
      QUANTA_OR: null,
      QUANTA_PAREN: null,
      QUANTA_DEL: null,
      QUANTA_STRKEY: null,
      QUANTA_TYPE: null,
      QUANTA_RS_WRITE: null,
      QUANTA_RHS: "ts-access",
      QUANTA_RHS_ASSIGN: "ts-access",
    })
  })

  test("FALSE-RED shapes — each is a real read the guard used to miss", () => {
    const names = [
      "QUANTA_RENAMED",
      "QUANTA_TEMPLATED",
      "QUANTA_PATTERN",
      "QUANTA_IN",
      "QUANTA_AFTER_GENERIC",
      "QUANTA_SH",
      "QUANTA_PKG",
      "QUANTA_RS_AFTER_CHAR",
    ]
    const found = inFixture(
      {
        "src/r.ts": [
          "const { QUANTA_RENAMED: aliased } = env",
          "const t = process.env[`QUANTA_TEMPLATED`]",
          "let p; ({ QUANTA_PATTERN: p } = env)",
          // Parsed as TSX, this generic arrow broke the tree and hid what followed.
          "const id = <T>(x: T): T => x",
          "const after = process.env.QUANTA_AFTER_GENERIC",
        ].join("\n"),
        "tests/unit/in.test.ts": 'if ("QUANTA_IN" in process.env) {}\n',
        "scripts/run": `#!/usr/bin/env bash\necho "${DOLLAR}{QUANTA_SH:-default}"\n`,
        "package.json": JSON.stringify({
          scripts: { bench: `QUANTA_X=1 run ${DOLLAR}{QUANTA_PKG:-a}` },
        }),
        // A char literal `'"'` used to open a string that swallowed the read after it.
        "src/c.rs": 'let q = \'"\'; let v = std::env::var("QUANTA_RS_AFTER_CHAR");\n',
      },
      names,
    )
    expect(backed(found, names)).toEqual({
      QUANTA_RENAMED: "ts-access",
      QUANTA_TEMPLATED: "ts-access",
      QUANTA_PATTERN: "ts-access",
      QUANTA_IN: "ts-access",
      QUANTA_AFTER_GENERIC: "ts-access",
      QUANTA_SH: "shell",
      QUANTA_PKG: "shell",
      QUANTA_RS_AFTER_CHAR: "quoted",
    })
  })

  test("in a TEST file a literal only NAMES a variable; outside one it declares it", () => {
    const names = ["QUANTA_SPEC", "QUANTA_TSX_TEST", "QUANTA_HELPER", "QUANTA_PROD"]
    const found = inFixture(
      {
        "src/x.spec.ts": 'const a = "QUANTA_SPEC"\n',
        "apps/web/src/b.test.tsx": 'const b = "QUANTA_TSX_TEST"\n',
        "tests/_helpers/h.ts": 'gateOn(env, "QUANTA_HELPER")\n',
        "src/prod.ts": 'gateOn(env, "QUANTA_PROD")\n',
      },
      names,
    )
    expect(backed(found, names)).toEqual({
      QUANTA_SPEC: null,
      QUANTA_TSX_TEST: null,
      QUANTA_HELPER: null,
      QUANTA_PROD: "ts-literal",
    })
  })
})
