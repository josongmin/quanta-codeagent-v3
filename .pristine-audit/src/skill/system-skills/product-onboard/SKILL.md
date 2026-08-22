---
name: product-onboard
description: "Guided first-run for a NEW USER of Quanta — the get-started flow. Triggers on \"onboard me\", \"get started\", \"first task\", \"new user\", \"how do I use this\", \"help me begin\". Drives a 5-step update_plan checklist (pick a role → connect context → scope a first task → ship a first artifact → recap) so a newcomer reaches a real result. This is USER onboarding, NOT repo reconnaissance — for cold-starting an unfamiliar codebase use the `onboard` skill instead."
userInvocable: true
allowedTools: ["update_plan", "Read", "Glob", "Edit", "Bash"]
category: skill
stability: experimental
---

# Product onboarding — get a new user to their first result

You are meeting a **new user** who is starting with Quanta for the first time.
The goal is NOT to document the tool — it is to walk them, hands-on, from "I
just opened this" to "I shipped one real thing and I know what to do next."

This is a HELPING flow: be explicit, explain trade-offs in one line each, and
**ask before mutating** anything in their project. Never assume prior context.

> Disambiguation: this skill is for onboarding a **person to the product**. If
> the user instead wants to understand an **unfamiliar repository** (layout,
> entry points, conventions), that is the separate `onboard` skill — do not
> confuse the two. Their triggers are non-overlapping by design.

## When this skill activates

Any one of these is enough:

- The user says "onboard me" / "get started" / "first task" / "new user" /
  "how do I use this" / "help me begin".
- It is clearly a first session and the user has not stated a concrete task.

Do NOT activate for "낯선 레포" / "repo 파악" / "explain this codebase" — those
route to the `onboard` (repo-recon) skill.

## The contract — drive it with `update_plan`

Open a plan with `update_plan` containing EXACTLY these five steps, in order,
then work them one at a time (mark each `in_progress` before you start it and
`completed` when its exit-check passes). Do not invent extra plan tools — the
shared `update_plan` seam is the whole mechanism.

1. **role-picker** — Ask one question: what are they here to do (e.g. fix a
   bug, add a feature, understand code, review a PR)? Offer 3-4 concrete
   options, each one line. Their answer sets the posture for everything after.
   Exit-check: a single chosen role is recorded in the plan.

2. **connect-context** — Read-only. Use `Read` / `Glob` to locate the project
   root, its rules file (`AGENTS.md` / `CLAUDE.md` / `README.md`), and the
   manifest (`package.json` / `Cargo.toml` / `pyproject.toml`). Report the
   stack + how to run tests in 3 bullets. Do NOT edit anything here.
   Exit-check: stack + test command surfaced back to the user.

3. **first-task** — Turn the chosen role into ONE small, reversible, concrete
   task that fits in a single session (e.g. "add a test for X", "fix the typo
   in Y"). Confirm scope with the user before proceeding. Keep it tiny — the
   point is a win, not a milestone.
   Exit-check: user has agreed to a single, narrowly-scoped task.

4. **first-artifact** — Do the task. Produce ONE real artifact (a passing
   test, a small diff, a committed file). Ask before any write. Show the exact
   change and how you verified it. This is the moment the user sees Quanta
   actually deliver.
   Exit-check: one concrete artifact exists and was verified.

5. **recap** — Summarise in 4 lines: what they picked, what got connected,
   what shipped, and the single most useful next action. Point them at the
   `/onboard` (repo-recon) skill if they now want to go deeper on the codebase.
   Exit-check: the plan is fully `completed` and a next action is stated.

## What NOT to do

- Do NOT skip `update_plan` — the five-step plan IS the user-visible contract.
- Do NOT mutate the project before the **first-artifact** step, and never
  without asking.
- Do NOT balloon the first task into a large change; a small guaranteed win
  beats an ambitious stall.
- Do NOT overlap with the repo-recon `onboard` skill's job (cold-start
  repomap of an unfamiliar codebase) — hand off to it instead.

## Output

A completed 5-step plan (via `update_plan`) plus the recap: role chosen,
context connected, one shipped artifact, and the single best next step.
