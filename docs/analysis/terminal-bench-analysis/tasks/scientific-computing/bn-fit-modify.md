---
task: bn-fit-modify
category: scientific-computing
difficulty: hard
tags: [bayesian-network, stats]
expert_min: 480
junior_min: 1000
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/bn-fit-modify:20251031
---

# bn-fit-modify

**Goal** — From a 10k-row sample (`/app/bn_sample_10k.csv`) of a linear-Gaussian Bayesian Network, (1) recover the true DAG (given: U has no parents, exactly 6 edges, tie-break directionality alphabetically) → `/app/learned_dag.csv` (`to,from`); (2) fit a BN; (3) do a causal intervention `do(Y=0.0)`; (4) save intervened DAG → `/app/intervened_dag.csv`; (5) sample 10k points from the intervened BN → `/app/final_bn_sample.csv`.

**Solution shape** — `solve.sh` installs R's `bnlearn` (v4.9) via `remotes`, then runs `modify_bn.R`: reads CSV, hill-climbs structure (`hc`), re-orients arcs by the prompt's rules (U as root, else later-alphabet letter is parent), fits a linear-Gaussian BN (`bn.fit`), writes arcs; for the intervention it `drop.arc`s U→Y, zeroes Y's coefficients/intercept and sets sd≈1e-9 (`custom.fit`), then `rbn` samples 10k rows. One R script (~90 lines) + CSV outputs.

**Verifier** — pytest (with scipy): checks all output files/columns exist; asserts learned edge set == the exact true DAG `{U→M,U→Y,U→D,U→R,Y→D,R→M}`; asserts intervened edge set == true DAG minus `U→Y`; asserts final sample has 10k rows/5 cols and that column D passes a KS test against a hand-derived Normal(mean,std) at p≥0.001. reward 0/1.

**Difficulty drivers** — Real statistical modeling: structure learning from data, resolving Markov-equivalence-class ambiguity using the given rules to land the EXACT edge set, and correctly implementing a do-operator (sever incoming arcs + fix the node's distribution) so the downstream node D's distribution matches an analytically-derived target under a KS test. Long expert estimate (8h). Env: R + specific bnlearn version.

**quanta attack points** — `container_exec` to install R packages and run Rscript, iterating on the recovered edge set. No interactivity. The exit-code loop is only partly helpful: DAG-exactness is checkable if the agent reconstructs the true structure, but the KS distribution test on D is statistical and its parameters are hidden — the agent must get the causal-intervention semantics right by reasoning, not by fitting the grader. Main risk: wrong arc orientation (fails exact-set) or a mis-specified intervention that shifts D's distribution off the KS target.
