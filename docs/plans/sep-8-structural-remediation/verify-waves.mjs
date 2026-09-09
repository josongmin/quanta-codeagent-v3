// Read-only coverage/write-set verifier. Run with Bun; no product files are edited.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const planDir = "docs/plans/sep-8-structural-remediation/"
const read = (path) => readFileSync(join(root, path), "utf8")
const manifest = JSON.parse(read(`${planDir}waves.json`))
const errors = []
const check = (ok, message) => {
  if (!ok) errors.push(message)
}
const contains = (scope, path) => (scope.endsWith("/") ? path.startsWith(scope) : path === scope)
const reserved = (path) =>
  manifest.reservedBasenames.includes(basename(path)) ||
  manifest.reservedScopes.some((scope) => contains(scope, path))
const scopesFor = (g) => [
  ...g.sourceScopes,
  ...g.existingTests,
  ...g.newTestScopes,
  g.artifactScope,
]
const owns = (g, path) => !reserved(path) && scopesFor(g).some((scope) => contains(scope, path))
const overlap = (a, b) => (a === b ? a : contains(a, b) ? b : contains(b, a) ? a : null)
const duplicates = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i)
const actionIds = [
  ...read(`${planDir}ACTIONS.md`).matchAll(/^- \[[ x]\] \*\*([A-Z0-9.-]+)\*\*/gm),
].map((m) => m[1])
const uncheckedActionIds = [
  ...read(`${planDir}ACTIONS.md`).matchAll(/^- \[ \] \*\*([A-Z0-9.-]+)\*\*/gm),
].map((m) => m[1])
const coverage = new Map(
  [...read(`${planDir}README.md`).matchAll(/^\| ([A-Z][A-Z0-9-]*) \| P[123] \| (R\d+) \|/gm)].map(
    (m) => [m[1], m[2]],
  ),
)
const assignedActions = [
  ...manifest.preflight.actions,
  ...manifest.groups.flatMap((g) => g.actions),
  ...manifest.closeout.actions,
]
check(
  coverage.size === 39 && manifest.groups.length === 16,
  "anti-vacuity: expected 39 findings/16 groups",
)
check(
  actionIds.length === 172 && assignedActions.length === 172,
  "anti-vacuity: expected 172 actions",
)
check(duplicates(assignedActions).length === 0, "duplicate action assignments")
check(
  duplicates(manifest.groups.flatMap((g) => g.findings)).length === 0,
  "duplicate finding assignments",
)
check(duplicates(manifest.groups.map((g) => g.id)).length === 0, "duplicate group ids")
check(duplicates(manifest.groups.map((g) => g.lane)).length === 0, "duplicate lane ids")
for (const id of actionIds) check(assignedActions.includes(id), `unassigned action: ${id}`)
for (const id of assignedActions) check(actionIds.includes(id), `unknown action: ${id}`)
for (const [id, owner] of coverage)
  check(
    manifest.groups.find((g) => g.id === owner)?.findings.includes(id),
    `finding owner drift: ${id}`,
  )
for (const g of manifest.groups) {
  for (const id of g.findings) {
    check(coverage.get(id) === g.id, `unknown/wrong finding: ${g.id}/${id}`)
    for (let n = 1; n <= 4; n++)
      check(g.actions.includes(`${id}.${n}`), `action missing: ${id}.${n}`)
  }
  for (const id of g.actions)
    check(
      g.findings.some((f) => [1, 2, 3, 4].some((n) => id === `${f}.${n}`)),
      `cross-group action: ${id}`,
    )
  for (const scope of scopesFor(g)) {
    check(
      !scope.startsWith("/") && !scope.split("/").includes("..") && !/[*?\\]/.test(scope),
      `invalid scope: ${scope}`,
    )
    if (!scope.endsWith("/")) check(existsSync(join(root, scope)), `missing exact file: ${scope}`)
    check(!reserved(scope), `worker scope is reserved: ${g.id}/${scope}`)
  }
  for (const scope of g.integrationScopes)
    check(reserved(scope), `integration scope not reserved: ${g.id}/${scope}`)
}

const hash = createHash("sha256")
for (let i = 1; i <= 7; i++) {
  const path = `docs/bugbash/sep-8-se-audit/agent-${i}.md`
  hash
    .update(`${path}\0`)
    .update(readFileSync(join(root, path)))
    .update("\0")
}
check(hash.digest("hex") === manifest.auditDigest, "audit input digest changed: refresh plan")
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
check(/^[0-9a-f]{40}$/.test(manifest.sourceHead), "invalid audit source HEAD")
try {
  execFileSync("git", ["cat-file", "-e", `${manifest.sourceHead}^{commit}`], { cwd: root })
} catch {
  check(false, "audit source HEAD is not available in this repository")
}
const files = execFileSync("rg", ["--files", "src", "tests", "tools", planDir], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
check(files.length > 100, "anti-vacuity: source inventory is empty or incomplete")
const snapshots = []
const scheduledGroups = []
check(manifest.waves.length === 6, "expected six implementation waves")
for (const [i, wave] of manifest.waves.entries()) {
  check(
    wave.id === `W${i + 1}` && wave.dependsOn.length === 1 && wave.dependsOn[0] === `W${i}`,
    `dependency drift: ${wave.id}`,
  )
  check(
    wave.groups.length > 0 && wave.groups.length <= manifest.maxParallelWriters,
    `writer limit: ${wave.id}`,
  )
  check(
    JSON.stringify(wave.integrationOrder) === JSON.stringify(wave.groups),
    `integration order mismatch: ${wave.id}`,
  )
  const groups = wave.groups.map((id) => manifest.groups.find((g) => g.id === id)).filter(Boolean)
  check(groups.length === wave.groups.length, `unknown group: ${wave.id}`)
  scheduledGroups.push(...wave.groups)
  for (const g of groups) check(g.wave === wave.id, `wave owner drift: ${g.id}`)
  for (let a = 0; a < groups.length; a++)
    for (let b = a + 1; b < groups.length; b++) {
      for (const x of scopesFor(groups[a]))
        for (const y of scopesFor(groups[b])) {
          const common = overlap(x, y)
          check(
            common === null || reserved(common),
            `symbolic collision: ${wave.id} ${groups[a].id}/${groups[b].id} ${common}`,
          )
        }
    }
  const owned = new Map(groups.map((g) => [g.id, files.filter((path) => owns(g, path))]))
  for (const path of files)
    check(groups.filter((g) => owns(g, path)).length <= 1, `concrete collision: ${wave.id}/${path}`)
  snapshots.push({
    wave: wave.id,
    groups: groups.map((g) => ({
      id: g.id,
      findings: g.findings.length,
      actions: g.actions.length,
      currentOwnedFiles: owned.get(g.id).length,
    })),
  })
}
check(
  duplicates(scheduledGroups).length === 0 && scheduledGroups.length === 16,
  "group scheduling duplicate/gap",
)
check(
  manifest.preflight.wave === "W0" && manifest.preflight.mode === "serial",
  "preflight must be serial",
)
check(
  manifest.closeout.wave === "W7" &&
    manifest.closeout.mode === "serial" &&
    manifest.closeout.dependsOn.join() === "W6",
  "closeout must follow W6 serially",
)

// Completion is a separate claim from plan integrity. A frozen audit HEAD is
// expected to differ after implementation lands; the exact CURRENT tree must
// instead be clean, every action must be checked, and the manifest must opt in
// to the terminal `verified` state.
const sourceTruthScopes = [
  "src",
  "tests",
  "tools",
  "package.json",
  "bun.lock",
  "biome.json",
  "biome.jsonc",
  "tsconfig.json",
  "tsconfig.tests.json",
  "docs/10.feature-catalog.md",
]
const git = (args, encoding = "utf8") =>
  execFileSync("git", args, { cwd: root, ...(encoding === null ? {} : { encoding }) })
const dirtyRaw = git(["status", "--porcelain=v1", "-z", "--", ...sourceTruthScopes], null)
const dirtyEntries = dirtyRaw.toString("utf8").split("\0").filter(Boolean)
const treeHash = createHash("sha256")
treeHash.update(
  git(["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...sourceTruthScopes], null),
)
const untrackedRaw = git(
  ["ls-files", "--others", "--exclude-standard", "-z", "--", ...sourceTruthScopes],
  null,
)
for (const path of untrackedRaw.toString("utf8").split("\0").filter(Boolean).sort()) {
  treeHash.update(`untracked\0${path}\0`)
  treeHash.update(readFileSync(join(root, path)))
  treeHash.update("\0")
}
const worktreeDigest = treeHash.digest("hex")
const completionBlockersFor = ({ dirtyCount, uncheckedCount, status }) => [
  ...(dirtyCount > 0 ? [`source truth tree has ${dirtyCount} dirty entries`] : []),
  ...(uncheckedCount > 0 ? [`${uncheckedCount} actions remain unchecked`] : []),
  ...(status !== "verified"
    ? [`manifest status is ${JSON.stringify(status)}, not "verified"`]
    : []),
]
const completionBlockers = completionBlockersFor({
  dirtyCount: dirtyEntries.length,
  uncheckedCount: uncheckedActionIds.length,
  status: manifest.status,
})

// Checker self-tests: overlapping future directories, reserved roots, unknown paths.
check(overlap("src/x/", "src/x/new/") === "src/x/new/", "self-test: future-prefix collision missed")
check(overlap("src/x/", "src/y/") === null, "self-test: unrelated scopes overlap")
check(
  reserved("src/shared/future.ts") && reserved("src/mcp/index.ts"),
  "self-test: reserved exclusion broken",
)
const syntheticA = {
  sourceScopes: ["src/example/"],
  existingTests: [],
  newTestScopes: [],
  artifactScope: "docs/example/A/",
}
const syntheticB = { ...syntheticA, sourceScopes: ["src/example/nested/"] }
const injected = ["src/example/nested/new.ts"].filter(
  (p) => owns(syntheticA, p) && owns(syntheticB, p),
)
check(
  injected.join() === "src/example/nested/new.ts",
  "self-test: injected conflict not attributed",
)
check(!owns(syntheticA, "src/elsewhere/new.ts"), "self-test: undeclared write allowed")
check(
  completionBlockersFor({ dirtyCount: 1, uncheckedCount: 0, status: "verified" }).length === 1,
  "self-test: dirty completion was not blocked",
)
check(
  completionBlockersFor({ dirtyCount: 0, uncheckedCount: 1, status: "verified" }).length === 1,
  "self-test: unchecked completion was not blocked",
)
check(
  completionBlockersFor({ dirtyCount: 0, uncheckedCount: 0, status: "verified" }).length === 0,
  "self-test: clean verified completion was blocked",
)

const groupArg = process.argv.indexOf("--group")
if (groupArg !== -1) {
  const group = manifest.groups.find((g) => g.id === process.argv[groupArg + 1])
  const paths = process.argv.slice(groupArg + 2)
  check(Boolean(group) && paths.length > 0, "usage: --group R01 repo-relative-path [...]")
  if (group)
    for (const path of paths) {
      check(
        !path.startsWith("/") && !path.split("/").includes("..") && owns(group, path),
        `unauthorized worker write: ${group.id}/${path}`,
      )
    }
}
const requireCloseout = process.argv.includes("--require-closeout")
const closeoutErrors = requireCloseout ? completionBlockers : []
// biome-ignore lint/suspicious/noConsole: CLI verifier emits one JSON result.
console.log(
  JSON.stringify(
    {
      status: errors.length ? "PLAN_FAIL" : "PLAN_PASS",
      auditSourceHead: manifest.sourceHead,
      currentHead: head,
      findings: coverage.size,
      actions: assignedActions.length,
      uncheckedActionIds,
      groups: manifest.groups.length,
      disjointScopeSelfTests: "executed",
      snapshots,
      completion: {
        eligible: completionBlockers.length === 0,
        manifestStatus: manifest.status,
        sourceTruthDirtyEntries: dirtyEntries,
        worktreeDigest,
        blockers: completionBlockers,
      },
      errors: [...errors, ...closeoutErrors],
    },
    null,
    2,
  ),
)
if (errors.length || closeoutErrors.length) process.exitCode = 1
