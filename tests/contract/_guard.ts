/**
 * Contract-tier gate (RFC §10.3, ADR-0003).
 *
 * Contract tests exercise REAL external processes (Docker daemon, language
 * servers). Their availability is environment-dependent, so two behaviours
 * are needed:
 *
 *  - Locally: a missing dependency must NOT fail the suite. The caller keeps
 *    its `test.skipIf`/`test.skip` path; this helper just returns the flag.
 *  - In CI: the dependency is provisioned on purpose, so "absent" means the
 *    provisioning (or the integration) is broken — that must be a loud
 *    failure, never a silent skip. CI sets `REQUIRE_CONTRACT=1`; this helper
 *    then registers a failing test naming the dependency (see below).
 *
 * This closes the "broken integration looks identical to 'tool not
 * installed'" hole that plain `skipIf` leaves open.
 */
import { test } from "bun:test"

const warned = new Set<string>()

/**
 * The same grammar as `QUANTA_REQUIRE_CAPABILITIES`: unset, empty and `0` are
 * off. A bare truthiness test made `REQUIRE_CONTRACT=0` the strict mode.
 */
export const contractRequired = (value: string | undefined): boolean => {
  const raw = (value ?? "").trim()
  return raw !== "" && raw !== "0"
}

/**
 * Loud as a REGISTERED FAILING TEST, not a module-scope throw.
 *
 * The throw "erroring the whole file" is what ADR-0003 asked for. MEASURED with a
 * two-file fixture, the dependency absent and `REQUIRE_CONTRACT=1`:
 *
 *   | form               | flags           | junit      | same file's other cases |
 *   | module-scope throw | --bail=1        | NOT WRITTEN | lost                   |
 *   | module-scope throw | (none)          | written    | lost                    |
 *   | registered failure | --bail=1        | written    | stopped by bail         |
 *   | registered failure | (none)          | written    | still run               |
 *
 * The shard runner passes `--bail=1 --reporter=junit`, so the throw left its junit
 * reducer nothing to read. Bail still stops the rest of the run either way — that
 * is bail's job, not this helper's. If registration is impossible (called from
 * inside a running test) it throws.
 */
export const requireContract = (name: string, available: boolean): boolean => {
  if (!available && contractRequired(process.env.REQUIRE_CONTRACT)) {
    const message =
      `[contract] "${name}" is unavailable but REQUIRE_CONTRACT is set. ` +
      "CI must provision this dependency; failing instead of skipping silently."
    try {
      test(`[contract] REQUIRED ${name} is unavailable`, () => {
        throw new Error(message)
      })
    } catch {
      throw new Error(message)
    }
  }
  if (!available && !warned.has(name)) {
    warned.add(name)
    // Restored. A `biome --unsafe` sweep deleted the `console.warn` that was
    // here and left the set it fed, so a local skip said nothing while
    // `tests/README.md` still promised one line per dependency.
    process.stderr.write(
      `[contract] skipping "${name}" — runtime unavailable. ` +
        "Set REQUIRE_CONTRACT=1 to fail instead of skip.\n",
    )
  }
  return available
}
