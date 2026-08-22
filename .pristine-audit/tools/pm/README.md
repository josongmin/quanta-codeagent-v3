# tools/pm — Project Management & Definition of Done

This is the **process** home for shipping features in quanta. It exists to make
ONE rule impossible to forget.

---

## 🚨 THE RULE — every feature, no exceptions

> **기능을 만들었으면, 끝난 게 아니다. 아래 3개를 *반드시* 같이 끝내야 "완료"다.**
>
> **A feature is NOT done when the code compiles. It is done only when ALL THREE
> of the following are also done — every time, no exceptions:**

1. **📒 Feature catalog — register OR update.**
   New feature → add a `tools/feature-catalog/features/<section>/<id>.yaml`
   entry. Touched/extended/wired an existing one → **update** its entry
   (`maturity`, `status`, `evidence.code`, `evidence.tests`, drop any
   `deliberate_hold` that is now resolved). The catalog is the SSOT of what
   exists; an unregistered feature is an invisible feature.
   - Validate: `bun tools/feature-catalog/cli.ts validate`

2. **🧪 TDD — tests first, then green.**
   Write the failing test that pins the contract BEFORE the implementation, then
   wire to green. Every feature ships with `evidence.tests.unit` populated. No
   "I'll add tests later." Later never comes.

3. **🔥 e2e hellgate-difficulty test — MANDATORY.**
   A unit test is not enough. Ship at least one **hellgate-grade** test that
   drives the feature through the REAL composition path (the production wiring,
   only the leaf I/O faked) and pins the FULL lifecycle + the adversarial /
   gate-OFF / failure paths — not just the happy path. This is the test that
   proves the feature is *actually wired*, not just *seam-present*.
   - Name it `*-hellgate.test.ts` (or `*-e2e-hellgate.test.ts`) and list it under
     `evidence.tests.integration` (or `unit`) in the catalog entry.

**모두 끝났으면**: `bun tools/pm/check.ts <feature-id>` 가 초록불이어야 한다.
**Only when all three are done** does `bun tools/pm/check.ts <feature-id>` go green.

> 코드 한 줄 단위의 prod-safety 바닥선(silent-failure / prod-unsafe coding rules + enforcement matrix)은 [prod-code-rules.md](./prod-code-rules.md) — feature가 아니라 모든 `src/` prod 코드에 적용.

---

## Why these three (the "왜")

- **Catalog** — without it, the next person (or the next you) re-discovers,
  re-implements, or audits a feature that already exists. The catalog is how a
  100k-LOC agent stays knowable. Drift here is the most expensive drift.
- **TDD** — the test written first defines the contract; the test written after
  rationalizes whatever the code happened to do. Only the former catches the bug
  you didn't think of.
- **e2e hellgate** — "default-OFF seam present" ≠ "feature works". A seam with no
  end-to-end proof is dead code that *looks* shipped. The hellgate is the
  difference between "wired" and "wired-on-paper". It is also the regression net:
  the adversarial cases are what break when someone refactors the hot path.

These are not bureaucracy — they are the three failure modes this repo has
actually hit (stale catalog, after-the-fact tests, unwired seams), turned into a
checklist that a tool enforces.

## Usage

```sh
# Check ONE feature meets the Definition of Done:
bun tools/pm/check.ts skill-mcp-deps

# Check several:
bun tools/pm/check.ts skill-mcp-deps edit-repair-loop

# Check EVERY catalog feature (CI-style sweep; non-zero exit on any FAIL):
bun tools/pm/check.ts --all

# Only features at maturity L3+ are held to the full bar by default; pass
# --strict to hold every feature (including L1/L2 seams) to it.
bun tools/pm/check.ts --all --strict
```

See [definition-of-done.ts](./definition-of-done.ts) for the exact, executable
definition of each check.
