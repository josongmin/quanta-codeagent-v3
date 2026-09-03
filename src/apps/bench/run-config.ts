/**
 * Typed bench run-config SSOT (jun-30 T2).
 *
 * The bench composition root (`runMain`, `cmdGrade`, `cmdPool`) parses the
 * dataset-family selector (argv `--dataset-family` wins, then
 * `QUANTA_SWEBENCH_DATASET_FAMILY`) EXACTLY ONCE into the typed
 * `BenchRunConfig.datasetFamily` field, then threads that typed field into
 * local-run / full-remote / pool / chunk consumers. No in-process env mutation
 * is used as an authority channel: env may only SERIALIZE the resolved family
 * across a REAL subprocess/SSH boundary (`serializeFamilyForSubprocess`), where
 * the child re-resolves it from its inherited env.
 *
 * Fail-closed split (the load-bearing behavior change, RFC jun-30):
 *  - ABSENT selector (no argv flag AND no env var) ⇒ "verified" (byte-identical
 *    to the legacy default path).
 *  - EXPLICIT but unknown/blank selector ⇒ THROW. The old
 *    `resolveDatasetFamily` silently mapped unknown → verified, which let a
 *    typo'd `--dataset-family prow` grade Pro predictions as Verified. That
 *    fail-safe-to-default is now refused: an operator who explicitly named a
 *    family gets an error, not a silent Verified fallback.
 */
import {
  type DatasetFamily,
  knownDatasetFamilyTokens,
  normalizeDatasetFamilyToken,
} from "./dataset-family-token"
import { type ProMaxSettings, resolveProMaxSettings } from "./promax/settings"

/**
 * The ONE owner of the ABSENT-selector default (aug-22 re-audit R4).
 *
 * "No selector at all" is a DECISION, and it used to be re-made by every layer
 * that had to materialize an optional family field: `?? "verified"` appeared
 * privately in `ec2-lifecycle` (twice), `pool/worker`, `remote/ssh`,
 * `run-main`'s preset seeder and the lenient `resolveDatasetFamily`. Six copies
 * of one policy is six places to drift — and a family whose profile later
 * changes what "no selector" should mean would have had to be edited in all of
 * them. Every consumer now routes through {@link datasetFamilyOrDefault}, so
 * changing THIS binding changes all of them (proved behaviourally in
 * `absent-family-default-owner.test.ts`, which swaps the owner out from under
 * the real consumers and watches every one of them move).
 */
export const ABSENT_SELECTOR_DATASET_FAMILY: DatasetFamily = "verified"

/**
 * Materialize a family field that may be ABSENT. The ONLY sanctioned way to
 * turn "the operator selected nothing" into a concrete family — never a private
 * `?? "verified"` at the consumer.
 */
export const datasetFamilyOrDefault = (family: DatasetFamily | undefined): DatasetFamily =>
  family ?? ABSENT_SELECTOR_DATASET_FAMILY

/**
 * Did the operator actually NAME a family (argv flag or env var), or is this the
 * absent default? This is NOT derivable from `datasetFamily` alone — an explicit
 * `--dataset-family verified` and no selector at all both resolve to "verified"
 * yet have DIFFERENT subprocess wire shapes (aug-22 re-audit R3): HEAD emitted
 * no `QUANTA_SWEBENCH_DATASET_FAMILY` key whatsoever for an absent selector, and
 * collapsing the two made every box command carry a fabricated `='verified'`.
 */
export type DatasetFamilySelector = "explicit" | "absent"

/**
 * The ONE resolved bench run config produced at the composition root. Today it
 * carries the typed `datasetFamily` (the T2 seam) plus the selector PROVENANCE
 * needed to reproduce the wire shape; T4 plugs a per-family profile registry
 * onto this field, and BFND-01 later nests it under a `benchmarkSuite`
 * discriminator. Consumers read `cfg.datasetFamily`, never a fresh
 * `process.env` read.
 */
export interface BenchRunConfig {
  readonly datasetFamily: DatasetFamily
  /** Whether `datasetFamily` was NAMED by the operator or is the absent default.
   *  Read ONLY by the subprocess wire encoder — every behavioural decision keys
   *  off `datasetFamily`, which is identical either way. */
  readonly familySelector: DatasetFamilySelector
  /**
   * PMX-01 — the ProMax family's typed settings (frozen upstream pin + the two
   * operator knobs), resolved as part of THIS one generic resolution.
   *
   * Deliberately NOT a second resolver under `promax/`: the packet's integration
   * authority forbids one. It is also deliberately resolved for EVERY family
   * rather than behind a `datasetFamily === "promax"` branch — resolution is
   * generic, only the ProMax PROFILE consumes the value. That keeps the
   * "one typed config owner" property intact and means an operator who typo'd a
   * ProMax knob learns about it at the composition root instead of three layers
   * down inside a launch.
   */
  readonly promax: ProMaxSettings
}

/** The wire encoder's ROLE VIEW of the config: it needs the resolved family and
 *  its provenance, and must not grow an appetite for anything else. Keeping the
 *  parameter narrow is also what lets the encoder be exercised with a two-field
 *  literal in tests without minting a whole run config. */
export type SubprocessFamilyWireConfig = Pick<BenchRunConfig, "datasetFamily" | "familySelector">

/**
 * Parse an EXPLICIT family selector, fail-closed. Blank or unknown ⇒ throw
 * (with the offending token in the message). Case-insensitive. This is the
 * ONLY place explicit-invalid becomes an error — the lenient
 * `resolveDatasetFamily` keeps its byte-identical absent-default contract for
 * internal helpers downstream of an already-validated config.
 */
export const parseDatasetFamilyOrThrow = (raw: string): DatasetFamily => {
  // HIGH-3 (aug-22): the token→family decision delegates to the ONE normalization
  // owner that the lenient `resolveDatasetFamily` also uses, so the two resolvers
  // CANNOT disagree about which token names which family. This function only adds
  // the fail-closed posture for the tokens the owner rejects.
  if (raw.trim() === "") {
    throw new Error(
      "bench: --dataset-family / QUANTA_SWEBENCH_DATASET_FAMILY is blank. " +
        `Pass one of ${knownDatasetFamilyTokens().join(", ")}, or omit it entirely for the Verified default.`,
    )
  }
  const match = normalizeDatasetFamilyToken(raw)
  if (match === undefined) {
    throw new Error(
      `bench: unknown dataset family "${raw}". ` +
        `Expected one of ${knownDatasetFamilyTokens().join(", ")} (or omit --dataset-family for Verified). ` +
        "REFUSING to fall back to Verified for an explicit selector — that silently mis-grades.",
    )
  }
  return match
}

/** The ONE spelling of the family selector flag. Every composition root reads
 *  it through `readDatasetFamilySelector` below, so the flag name exists once. */
export const DATASET_FAMILY_FLAG = "--dataset-family"

/**
 * Read the family selector out of an argv vector, distinguishing ABSENT from
 * PRESENT-BUT-VALUELESS. Pure (argv in, token out) so it is testable without a
 * process.
 *
 * LOW-10 follow-on (aug-22): the composition roots used the generic
 * `argValue("--dataset-family")`, which returns `argv[i + 1]` blindly. When the
 * flag is the LAST token — `quanta-bench run --swebench ds --dataset-family` —
 * that is `undefined`, so an EXPLICIT selector read back as ABSENT and the
 * fail-closed resolver defaulted it to Verified. Every root (run, no-subcommand,
 * grade, grade --mode full, pool, bestk-passk, terminal) was fail-OPEN on that
 * spelling: the Pro/Live operator got a silent Verified run, and `terminal`'s
 * "family is a SWE-only axis" refusal was bypassed entirely. A selector the
 * operator TYPED must never be silently discarded.
 *
 * Rules (`--flag value` precedence matches the generic `argValue` reader):
 *  - flag absent entirely ⇒ `undefined` (the legacy Verified default).
 *  - `--dataset-family <token>` ⇒ that token (blank/unknown is then the
 *    fail-closed parser's business, not this reader's).
 *  - `--dataset-family=<token>` ⇒ that token (including the empty `=` form,
 *    which is an explicit-blank selector and errors downstream).
 *  - flag present with NO following token, or followed by another `-`-prefixed
 *    flag ⇒ THROW. No dataset family starts with `-`, so a flag in the value
 *    slot is always a swallowed value, never a family.
 */
export const readDatasetFamilySelector = (argv: readonly string[]): string | undefined => {
  const spaceForm = argv.indexOf(DATASET_FAMILY_FLAG)
  if (spaceForm >= 0) {
    const next = argv[spaceForm + 1]
    if (next === undefined || next.startsWith("-")) {
      throw new Error(
        `bench: ${DATASET_FAMILY_FLAG} requires a value (${next === undefined ? "the flag was the last argument" : `the next argument was the flag "${next}"`}). ` +
          `Pass ${DATASET_FAMILY_FLAG} <${knownDatasetFamilyTokens().join("|")}>, or omit the flag entirely for the Verified default. ` +
          "REFUSING to treat a typed-but-valueless selector as absent — that silently runs Verified.",
      )
    }
    return next
  }
  const eqPrefix = `${DATASET_FAMILY_FLAG}=`
  const eq = argv.find((a) => a.startsWith(eqPrefix))
  return eq === undefined ? undefined : eq.slice(eqPrefix.length)
}

/**
 * Resolve the typed run config ONCE. `argvFamily` is the raw `--dataset-family`
 * value (pass `undefined` when the flag is absent — NOT an empty string, which
 * is treated as an explicit-blank error). `env` supplies the fallback
 * `QUANTA_SWEBENCH_DATASET_FAMILY`. Absent (both undefined) ⇒ verified; any
 * present-but-invalid selector ⇒ throw (fail-closed).
 */
export const resolveBenchRunConfig = (input: {
  readonly argvFamily: string | undefined
  readonly env: NodeJS.ProcessEnv
}): BenchRunConfig => {
  const explicit = input.argvFamily ?? input.env.QUANTA_SWEBENCH_DATASET_FAMILY
  // PMX-01 — family-agnostic settings resolution, done ONCE alongside the family
  // parse. Fail-closed on an explicitly-set-but-unusable ProMax knob.
  const promax = resolveProMaxSettings(input.env)
  // R4: the absent branch does NOT spell its own default — it delegates to the
  // ONE owner, exactly like every downstream consumer does.
  return explicit === undefined
    ? { datasetFamily: datasetFamilyOrDefault(undefined), familySelector: "absent", promax }
    : { datasetFamily: parseDatasetFamilyOrThrow(explicit), familySelector: "explicit", promax }
}

/**
 * BOUNDARY SERIALIZER — the ONLY sanctioned write of the family env var. It
 * encodes an ALREADY-RESOLVED, ALREADY-VALIDATED `DatasetFamily` into the env
 * envelope handed to a real subprocess/SSH child (which re-resolves it from its
 * inherited env via `resolveBenchRunConfig` with no argv on that side). This is
 * a wire encoder, NOT an in-process authority: nothing in-process should read
 * this back as its source of truth — the typed `BenchRunConfig` is.
 */
export const serializeFamilyForSubprocess = (
  family: DatasetFamily,
  env: Record<string, string | undefined>,
): void => {
  // HIGH-1 (aug-22) STRUCTURAL RAIL: refuse the AMBIENT env object. Writing the
  // family there re-establishes exactly the in-process authority channel this
  // module exists to abolish — preset seeding, the local grade refusal and the
  // launching-side remote builders would read their decision back out of ambient
  // env instead of the typed config, lines after it was written. The envelope
  // must be a FRESH Record built for one specific subprocess/SSH invocation (a
  // spread copy of the parent env is exactly that). This is an IDENTITY check on
  // the object, never a value read, so an aliased binding is refused too.
  // Read `process.env` HERE, at call time, never from a module-load capture.
  // A capture (`const ambientEnv = process.env`) is correct only until something
  // REPLACES the binding — `process.env = { ...saved }`, which ten test files in
  // this repo do in afterEach and call "restore". That swaps the binding, not
  // the object, so a capture is left pointing at a dead one, this comparison is
  // false forever, and the rail silently stops refusing while the family gets
  // written straight into the live ambient env. Per-file isolation hid that for
  // as long as it held; `wireRuntimePorts` takes its env the same way for the
  // same reason (see `context-binding/base.ts`).
  if (env === (process.env as Record<string, string | undefined>)) {
    throw new Error(
      "bench: serializeFamilyForSubprocess REFUSES to write into the ambient env object — " +
        "that is an in-process authority channel, not a subprocess wire. Build a per-call env " +
        "envelope with buildSubprocessFamilyEnv() and hand THAT to the subprocess/SSH " +
        "invocation. In-process consumers must take the typed " +
        "BenchRunConfig.datasetFamily instead.",
    )
  }
  env.QUANTA_SWEBENCH_DATASET_FAMILY = family
}

/**
 * Build the env ENVELOPE for a real subprocess/SSH child: a COPY of the parent
 * env, with the resolved family encoded on it IFF the operator actually selected
 * one. The copy is a fresh Record, so the wire encoding never leaks back into
 * the launching process as an authority channel. `parentEnv` is EXPLICIT (no
 * ambient default) — the caller has to name the env it is forwarding.
 *
 * WIRE SHAPE (aug-22 re-audit R3 — a byte-identity regression this repair
 * introduced and this function now owns):
 *  - ABSENT selector ⇒ NO `QUANTA_SWEBENCH_DATASET_FAMILY` key at all, exactly
 *    what HEAD forwarded. The pre-repair pool bridge wrote the env var only for
 *    a non-empty argv value, and the full-remote path forwarded ambient env
 *    verbatim, so a default run's box command carried no family assignment.
 *    Taking a bare `DatasetFamily` here collapsed absent into explicit-verified
 *    and stamped `QUANTA_SWEBENCH_DATASET_FAMILY='verified'` onto EVERY box
 *    command — a live wire-shape change on the default (i.e. every) run.
 *  - EXPLICIT selector ⇒ the CANONICALIZED family, so the child re-resolves the
 *    same family the parent admitted (`" PRO "` reaches the box as `pro`).
 *
 * It takes the whole `BenchRunConfig` rather than a family + boolean precisely
 * so a caller cannot supply the family and forget the provenance.
 */
export const buildSubprocessFamilyEnv = (
  cfg: SubprocessFamilyWireConfig,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const envelope: NodeJS.ProcessEnv = { ...parentEnv }
  if (cfg.familySelector === "absent") return envelope
  serializeFamilyForSubprocess(cfg.datasetFamily, envelope as Record<string, string | undefined>)
  return envelope
}
