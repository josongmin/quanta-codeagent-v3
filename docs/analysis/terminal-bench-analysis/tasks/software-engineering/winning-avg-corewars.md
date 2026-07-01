---
task: winning-avg-corewars
category: software-engineering
difficulty: medium
tags: [pmars, corewars, gaming]
expert_min: 60
junior_min: 240
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/winning-avg-corewars:20251031
---

# winning-avg-corewars

**Goal** — Write a CoreWars warrior `/app/my_warrior.red` (Redcode, core 8000 / max 80000 cycles) that beats five classic opponents in pMARS batch mode: ≥75/100 wins vs stone, vampire, paper; ≥33/100 vs snake, g2-clear. Don't modify opponent files.

**Solution shape** — Bash heredocs a single ~150-line Redcode program (`my_warrior.red`). It's a hand-authored multi-component warrior combining: a stone bomber (vs paper), a stone/imp "rosebud killer" hybrid, a dedicated multi-phase snake neutralizer (setup-attack + imp-warfare + early-strike + decoy-disrupt), a binary-tree imp spiral, and a Stargate-style endgame clear loop, wired together with `spl` at `org clear-1`. No compilation — pMARS interprets the `.red` directly; the whole task is authoring assembly-level game strategy.

**Verifier** — pytest: opponent `.red` files unchanged (SHA-256); `my_warrior.red` exists; runs `pmars -b -r 100 -f my_warrior.red warriors/<opp>.red` for each of the five and parses the win count, asserting each meets its threshold (75/75/75/33/33).

**Difficulty drivers** — Requires CoreWars/Redcode expertise: understanding bombers, replicators (paper), imps, vampires, and clears, and crafting one warrior that generalizes across five very different strategies with hard win-rate floors. Balancing components so gains vs one opponent don't sink another is the real challenge. Non-deterministic-ish battles mean margins must be comfortable, not marginal.

**quanta attack points** — `container_exec` for edit→`pmars -b -r 100` per opponent, parsing win counts; no interactivity. Main risk: a warrior that clears three thresholds but drops below a floor on snake/g2-clear; strategy tradeoffs are non-obvious and battles have variance. The iterate-until-pass loop is genuinely useful here — pMARS gives numeric win rates per opponent, so the agent can measure and tune components toward the thresholds.
