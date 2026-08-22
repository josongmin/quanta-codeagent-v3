// meta-test: pins the `wiring` block (SOTA Tier-6 — machine-checkable
// producer/consumer contract) added to the feature catalog. Lives outside src/,
// so no @/ alias — imports the tooling directly like the sibling fc meta-tests.
//
// WHY THIS EXISTS
// ---------------
// `surface_integration` is prose + a hand-audited status word: it cannot
// mechanically tell "a type-surface exists" apart from "it is wired end-to-end".
// That gap produced a FALSE-GREEN: `02-tool-system/99-deferred-tool-registry`
// declared `surface_integration.cli: full` while its OWN evidence says
// "deliberately NO scheduler wired into the loop" — a pure in-memory type-
// surface scored as fully integrated. The `wiring` block declares the honest
// posture (`wireStatus`) plus a producer/consumer contract whose SiteRefs must
// resolve to REAL {module, exportedSymbol}. This ratchet is what gives those
// declarations teeth.
//
// SCOPE (deliberate, per the schema doc-comment): this is a
// DECLARATION-vs-SYMBOL-RESOLUTION check — STATIC. It proves each SiteRef's
// symbol EXISTS (directly OR via a barrel `export … from` chain) and that
// `wireStatus` is honest about producer/consumer presence. It does NOT prove
// runtime composition-reachability (that the consumer is actually invoked from a
// live surface builder) — that is a SEPARATE, heavier proof kind owned by
// reachability.ts (import-graph BFS). Conflating the two is exactly the disease
// that made `cli: full` untrustworthy, so we keep them apart on purpose.
import { describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseSymbols } from "../../tools/feature-catalog/reachability"
import {
  type Feature,
  FeatureSchema,
  loadFeaturesStrict,
  type SiteRef,
  WiringSchema,
} from "../../tools/feature-catalog/schema"

const REPO = resolve(import.meta.dir, "..", "..")
const SRC = join(REPO, "src")
const features = await loadFeaturesStrict(join(REPO, "tools/feature-catalog/features"))

// ---------------------------------------------------------------------------
// Symbol resolver — resolve a SiteRef's {module, exportedSymbol} to a boolean.
//
// Mirrors reachability.ts's own machinery: parseSymbols() to read a module's
// exports/re-exports, and a resolveSpec() twin (reachability keeps its copy
// private) to walk `export … from "./x"` barrel chains. A symbol counts as
// "exported by <module>" iff it is in that module's ownExports OR reachable
// through a re-export / star-re-export chain rooted at <module>. Depth-guarded
// against import cycles.
// ---------------------------------------------------------------------------

/** Resolve a specifier (relative or `@/`) from `fromAbs` → absolute src .ts, or null. */
const resolveSpec = async (spec: string, fromAbs: string): Promise<string | null> => {
  let base: string | null = null
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2))
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromAbs), spec)
  else return null // node:/bun:/bare pkg — not a repo module
  const cands = base.endsWith(".ts") ? [base] : [`${base}.ts`, join(base, "index.ts")]
  for (const c of cands) {
    try {
      if ((await stat(c)).isFile()) return c
    } catch {
      /* next candidate */
    }
  }
  return null
}

const readParsed = async (abs: string): Promise<ReturnType<typeof parseSymbols> | null> => {
  try {
    return parseSymbols(await readFile(abs, "utf8"))
  } catch {
    return null
  }
}

/** Does <moduleAbs> export <name> (directly or via barrel re-export chain)? */
const moduleExportsSymbol = async (
  moduleAbs: string,
  name: string,
  seen = new Set<string>(),
): Promise<boolean> => {
  if (seen.has(moduleAbs)) return false
  seen.add(moduleAbs)
  const p = await readParsed(moduleAbs)
  if (!p) return false
  if (p.ownExports.has(name)) return true
  // named re-export: `export { name as exposed } from "./x"` — follow to srcName
  for (const rx of p.reexports) {
    if (rx.exposed === name) {
      const tgt = await resolveSpec(rx.spec, moduleAbs)
      if (tgt && (await moduleExportsSymbol(tgt, rx.srcName, seen))) return true
    }
  }
  // star re-export: `export * from "./x"` — the name may live in any star source
  for (const spec of p.starSpecs) {
    const tgt = await resolveSpec(spec, moduleAbs)
    if (tgt && (await moduleExportsSymbol(tgt, name, seen))) return true
  }
  return false
}

interface SiteResolution {
  readonly ok: boolean
  readonly reason: string
}

/** Resolve one SiteRef: module file must exist AND export the symbol. */
const resolveSite = async (ref: SiteRef): Promise<SiteResolution> => {
  const abs = join(REPO, ref.module)
  let isFile = false
  try {
    isFile = (await stat(abs)).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) return { ok: false, reason: `module not found: ${ref.module}` }
  const exported = await moduleExportsSymbol(abs, ref.exportedSymbol)
  return exported
    ? { ok: true, reason: "" }
    : { ok: false, reason: `${ref.module} does not export "${ref.exportedSymbol}"` }
}

const withWiring = features.filter(
  (f): f is typeof f & { feature: Feature & { wiring: NonNullable<Feature["wiring"]> } } =>
    f.feature.wiring !== undefined,
)

// ---------------------------------------------------------------------------
// Schema-shape sanity (pure zod — no fs).
// ---------------------------------------------------------------------------
describe("wiring — schema shape", () => {
  test("WC-01: absent wiring block ⇒ byte-identical legacy (feature parses, wiring undefined)", () => {
    const r = FeatureSchema.safeParse({
      id: "no-wiring",
      title: "x",
      section: 2,
      subsystem: "2.1",
      maturity: "L3",
      purpose: "x",
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.wiring).toBeUndefined()
  })

  test("WC-02: activation is an ARRAY (union of conditions), not a single knob", () => {
    const r = WiringSchema.safeParse({
      wireStatus: "wired",
      activation: [
        { kind: "config", key: "capEnforce", value: true },
        { kind: "preset", key: "swe-strict" },
        { kind: "port-present", key: "DeferredResultRegistry" },
      ],
      producer: [{ module: "src/x.ts", exportedSymbol: "P", role: "produces" }],
      consumer: [{ module: "src/y.ts", exportedSymbol: "C", role: "consumes" }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.activation.length).toBe(3)
  })

  test("WC-03: per-surface contracts record accepts the full surface set", () => {
    const r = WiringSchema.safeParse({
      wireStatus: "wired",
      contracts: {
        cli: { status: "full", producer: { module: "src/x.ts", exportedSymbol: "P", role: "p" } },
        bench: { status: "partial" },
        headless: { status: "na" },
      },
    })
    expect(r.success).toBe(true)
  })

  test("WC-04: wireStatus is closed to {wired,seam-only,forward-contract}", () => {
    expect(WiringSchema.safeParse({ wireStatus: "cli-full" }).success).toBe(false)
    for (const s of ["wired", "seam-only", "forward-contract"]) {
      expect(WiringSchema.safeParse({ wireStatus: s }).success).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The RATCHET — over the real catalog.
// ---------------------------------------------------------------------------
describe("wiring — contract ratchet (static symbol resolution)", () => {
  // Teeth #1 — EVERY SiteRef anywhere in a wiring block must resolve to a real
  // {module, exportedSymbol}. This is the anti-drift core: a rename/delete of
  // the producer/consumer symbol fires here.
  test("WC-10: every SiteRef in every wiring block resolves to a real exported symbol", async () => {
    const offenders: string[] = []
    for (const { feature: f } of withWiring) {
      const w = f.wiring
      const sites: Array<{ where: string; ref: SiteRef }> = [
        ...w.producer.map((ref) => ({ where: "producer[]", ref })),
        ...w.consumer.map((ref) => ({ where: "consumer[]", ref })),
      ]
      for (const [surface, c] of Object.entries(w.contracts)) {
        if (c.producer) sites.push({ where: `contracts.${surface}.producer`, ref: c.producer })
        if (c.consumer) sites.push({ where: `contracts.${surface}.consumer`, ref: c.consumer })
      }
      for (const { where, ref } of sites) {
        const res = await resolveSite(ref)
        if (!res.ok) offenders.push(`${f.id} @ ${where}: ${res.reason}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // Teeth #2 — wireStatus HONESTY. This is what turns "type surface only" into a
  // declarable state instead of a laundered `cli: full`:
  //   wired            ⇒ MUST declare ≥1 producer AND ≥1 consumer, both resolving.
  //   seam-only        ⇒ MUST declare ≥1 producer; MUST declare NO consumer
  //                      (a wired consumer would contradict "seam-only").
  //   forward-contract ⇒ MUST declare NO producer and NO consumer (placeholder).
  test("WC-11: wireStatus is honest about producer/consumer presence", async () => {
    const offenders: string[] = []
    for (const { feature: f } of withWiring) {
      const w = f.wiring
      const nProd = w.producer.length
      const nCons = w.consumer.length
      if (w.wireStatus === "wired") {
        if (nProd === 0) offenders.push(`${f.id}: wireStatus=wired but NO producer`)
        if (nCons === 0) offenders.push(`${f.id}: wireStatus=wired but NO consumer`)
      } else if (w.wireStatus === "seam-only") {
        if (nProd === 0) offenders.push(`${f.id}: wireStatus=seam-only but NO producer`)
        if (nCons > 0) {
          offenders.push(
            `${f.id}: wireStatus=seam-only but declares ${nCons} consumer(s) — a wired consumer contradicts "seam-only"`,
          )
        }
      } else {
        // forward-contract
        if (nProd > 0 || nCons > 0) {
          offenders.push(`${f.id}: wireStatus=forward-contract must have NO producer/consumer`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  // Teeth #3 — a per-surface contract that claims `full` (status=full) must
  // carry BOTH a producer and consumer SiteRef, and both must resolve. This is
  // the direct fix for the false-green: you cannot write a `full` surface
  // contract without naming the two ends and having them exist. `partial`
  // requires a producer only (the seam is real but the render/consume is weak).
  test("WC-12: a surface contract status=full needs a resolving producer AND consumer", async () => {
    const offenders: string[] = []
    for (const { feature: f } of withWiring) {
      for (const [surface, c] of Object.entries(f.wiring.contracts)) {
        if (c.status !== "full") continue
        if (!c.producer) {
          offenders.push(`${f.id}.${surface}: status=full but no producer SiteRef`)
          continue
        }
        if (!c.consumer) {
          offenders.push(`${f.id}.${surface}: status=full but no consumer SiteRef`)
          continue
        }
        const [pr, cr] = await Promise.all([resolveSite(c.producer), resolveSite(c.consumer)])
        if (!pr.ok) offenders.push(`${f.id}.${surface} producer: ${pr.reason}`)
        if (!cr.ok) offenders.push(`${f.id}.${surface} consumer: ${cr.reason}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("WC-13: at least the migrated seed features carry a wiring block", () => {
    const ids = new Set(withWiring.map((f) => f.feature.id))
    for (const seed of [
      "deferred-tool-registry",
      "tool-output-schema-factory",
      "memory-telemetry-port",
    ]) {
      expect(ids.has(seed), `seed ${seed} has a wiring block`).toBe(true)
    }
  })

  // The deferred-tool-registry is the flagship migration: its OLD state
  // (surface_integration.cli=full) was the false-green. Pin its NEW honest
  // state so a regression back to a bogus "wired" claim fails here.
  test("WC-14: deferred-tool-registry is declared seam-only (producer, NO consumer)", async () => {
    const f = withWiring.find((x) => x.feature.id === "deferred-tool-registry")?.feature
    expect(f, "deferred-tool-registry present").toBeDefined()
    const w = f?.wiring
    expect(w?.wireStatus).toBe("seam-only")
    expect(w?.consumer.length).toBe(0) // the honest fact: NO scheduler wired
    expect((w?.producer.length ?? 0) > 0).toBe(true)
    // and the producer actually resolves (the registry class exists via the barrel)
    for (const ref of w?.producer ?? []) {
      const res = await resolveSite(ref)
      expect(res.ok, `producer ${ref.module}#${ref.exportedSymbol}: ${res.reason}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// RED-ON-INJECTION — proves the resolver has teeth (not vacuously green).
// We DON'T mutate a YAML file (that would drift the catalog); we exercise the
// exact predicate the ratchet uses against a synthetic wiring block whose
// consumer names a symbol that does NOT exist. It MUST fail to resolve. If this
// went green, WC-10/WC-12 above would be vacuous.
// ---------------------------------------------------------------------------
describe("wiring — red-on-injection (resolver teeth)", () => {
  test("WC-20: a wired contract with a NON-EXISTENT consumer symbol fails resolution (RED)", async () => {
    const injected = WiringSchema.parse({
      wireStatus: "wired",
      producer: [
        {
          module: "src/tool/factory.ts",
          exportedSymbol: "defineTool", // real → resolves
          role: "builds the tool with the capability",
        },
      ],
      consumer: [
        {
          module: "src/agent/loop/stream-consume.ts",
          exportedSymbol: "streamConsumeXXX_DOES_NOT_EXIST", // fabricated
          role: "would invoke the seam",
        },
      ],
    })
    const prod = await resolveSite(injected.producer[0] as SiteRef)
    const cons = await resolveSite(injected.consumer[0] as SiteRef)
    // producer is real → green; consumer is fabricated → RED (this is the teeth)
    expect(prod.ok).toBe(true)
    expect(cons.ok).toBe(false)
    expect(cons.reason).toContain("does not export")
  })

  test("WC-21: a SiteRef to a non-existent MODULE fails resolution (RED)", async () => {
    const res = await resolveSite({
      module: "src/tool/deferred/no-such-file.ts",
      exportedSymbol: "Whatever",
      role: "x",
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("module not found")
  })

  test("WC-22: a real symbol reached THROUGH a barrel re-export resolves (positive control)", async () => {
    // DeferredResultRegistry is not own-declared in index.ts; it is
    // `export { DeferredResultRegistry } from "./legacy"`. The chain-follower
    // must find it — this guards against a resolver that only checks ownExports.
    const res = await resolveSite({
      module: "src/tool/deferred/index.ts",
      exportedSymbol: "DeferredResultRegistry",
      role: "issues DeferredHandle",
    })
    expect(res.ok, res.reason).toBe(true)
  })
})
