/**
 * `quanta-bench auth (status|login)` — multi-account auth roster + per-label
 * OAuth login (jun-20 multi-auth T-6/T-7), extracted from cli.ts (ADR-0536 P0).
 * Moved verbatim; behaviour-identical. NEVER prints token material.
 */
import { logger } from "@/shared"
import { runBenchLogin } from "../auth-pool"
import { argValue, hasFlag, positionals, printBlock, resolveCliAuthSource } from "./shared"

/**
 * jun-20 multi-auth (T-7): `quanta-bench auth login --auth-label <label>`. Runs
 * the SAME ChatGPT OAuth flow as the main CLI's `/login`, writes the token to a
 * per-label file, and auto-registers the account in the pool manifest — closing
 * the loop the fleet previously lacked (it could consume per-account files but
 * nothing produced the extra ones). OAuth errors propagate to `main().catch` (exit 1).
 */
const cmdAuthLogin = async (): Promise<void> => {
  const label = argValue("--auth-label")
  if (label === undefined || label.trim() === "") {
    logger.info(
      "usage: quanta-bench auth login --auth-label <label> [--auth-file <path>] [--auth-pool <manifest>] [--max-parallel N]",
    )
    process.exit(2)
  }
  const authFile = argValue("--auth-file")
  const manifestPath = argValue("--auth-pool") ?? process.env.QUANTA_BENCH_AUTH_POOL
  const maxParallelRaw = argValue("--max-parallel")
  const res = await runBenchLogin(
    {
      label,
      ...(authFile !== undefined ? { authFile } : {}),
      ...(manifestPath !== undefined && manifestPath.trim() !== "" ? { manifestPath } : {}),
      ...(maxParallelRaw !== undefined ? { maxParallel: Number(maxParallelRaw) } : {}),
    },
    { env: process.env, onLog: (m) => logger.info(m) },
  )
  printBlock(
    [
      `✓ signed in account "${res.label}" (plan: ${res.plan})`,
      `  token:    ${res.authFile}`,
      `  manifest: ${res.manifestPath} (${res.manifestAdded ? "added" : "already present"}; ${res.accountCount} account(s))`,
      `  run with: QUANTA_BENCH_AUTH_POOL=${res.manifestPath} quanta-bench pool --allow-remote-secrets …`,
    ].join("\n"),
  )
}

/**
 * jun-20 multi-auth (T-6): `quanta-bench auth status [--auth-pool m] [--json]`.
 * Shows the operator the resolved auth roster — labels and per-account capacity
 * (maxParallel / maxBoxes / weight / disabled) — so a multi-account fleet can be
 * run without guessing which accounts exist or how much each can take. This is
 * the STATIC allocation view from the manifest; live cooldown/activeSlots surface
 * through the per-box status snapshots (`box ls`). NEVER prints token material:
 * the resolver only ever holds file PATHS, never reads a credential.
 */
export const cmdAuth = async (): Promise<void> => {
  const action = positionals()[0]
  if (action === "login") {
    await cmdAuthLogin()
    return
  }
  if (action !== "status") {
    logger.info(
      "usage: quanta-bench auth (status|login) [--auth-pool <manifest>] [--auth-label <label>] [--json]",
    )
    process.exit(2)
  }
  const src = resolveCliAuthSource()
  const json = hasFlag("--json")
  if (src.kind === "single") {
    printBlock(
      json
        ? JSON.stringify({ mode: "single", authFile: src.authFile })
        : `auth: single account\n  file: ${src.authFile}`,
    )
    return
  }
  const rows = src.accounts.map((a) => ({
    label: a.label,
    maxParallel: a.maxParallel,
    maxBoxes: a.maxBoxes ?? null,
    weight: a.weight ?? 1,
    disabled: a.disabled === true,
  }))
  if (json) {
    printBlock(JSON.stringify({ mode: "pool", accounts: rows }, null, 2))
    return
  }
  printBlock(
    [
      `auth: pool of ${rows.length} account(s)`,
      ...rows.map(
        (r) =>
          `  ${r.disabled ? "✕" : "•"} ${r.label}  maxParallel=${r.maxParallel}  maxBoxes=${
            r.maxBoxes ?? "∞"
          }  weight=${r.weight}${r.disabled ? "  (disabled)" : ""}`,
      ),
    ].join("\n"),
  )
}
