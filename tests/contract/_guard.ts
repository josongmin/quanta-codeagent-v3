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
 *    then throws at module load, erroring the whole file.
 *
 * This closes the "broken integration looks identical to 'tool not
 * installed'" hole that plain `skipIf` leaves open.
 */
const warned = new Set<string>()

export const requireContract = (name: string, available: boolean): boolean => {
  if (!available && process.env.REQUIRE_CONTRACT) {
    throw new Error(
      `[contract] "${name}" is unavailable but REQUIRE_CONTRACT is set. ` +
        "CI must provision this dependency; failing instead of skipping silently.",
    )
  }
  if (!available && !warned.has(name)) {
    warned.add(name)
    console.warn(
      `[contract] skipping "${name}" — runtime unavailable. ` +
        "Set REQUIRE_CONTRACT=1 to fail instead of skip.",
    )
  }
  return available
}
