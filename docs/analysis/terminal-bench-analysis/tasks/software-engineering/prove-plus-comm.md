---
task: prove-plus-comm
category: software-engineering
difficulty: easy
tags: [coding]
expert_min: 5
junior_min: 120
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/prove-plus-comm:20251031
---

# prove-plus-comm

**Goal** — Complete an incomplete Coq proof of addition commutativity (`forall n m : nat, n + m = m + n`) in `plus_comm.v`. The partial proof (`environment/partial_proof.v`) sets up induction on `n` but leaves both the base and inductive cases as `admit.` Fill in the tactics and compile with `coqc` to produce `plus_comm.vo`.

**Solution shape** — Bash: `printf` the finished proof to `plus_comm.v` and run `coqc plus_comm.v`. The proof: `intros n m; induction n`; base case `simpl; rewrite <- plus_n_O; reflexivity`; inductive case `simpl; rewrite IHn'; rewrite plus_n_Sm; reflexivity`. Uses stdlib `Arith` lemmas (`plus_n_O`, `plus_n_Sm`). One file authored + one compiled `.vo`.

**Verifier** — pytest: `plus_comm.v` exists; `plus_comm.vo` exists; source contains the theorem statement, `Proof.`, `Qed.`, and **no `admit`**; and `coqc plus_comm.v` recompiles with return code 0. reward binary 0/1.

**Difficulty drivers** — Small but needs Coq fluency: knowing the right stdlib rewrite lemmas (`plus_n_O`, `plus_n_Sm`) and induction structure to discharge both goals without `admit`. Trivial for someone who knows Coq (5-min expert), a wall for those who don't (120-min junior) — the gap is domain knowledge, not steps or environment.

**quanta attack points** — `container_exec` iterate: edit `.v`, run `coqc`, read the error, adjust tactics — a tight feedback loop where the compiler's exit code and error messages directly guide convergence, so the "iterate until tests pass" loop is very effective (Coq tells you exactly which goal remains). Main risk is fumbling lemma names / tactic order. Could use `pty_*` for an interactive `coqtop` session but not required. No long-running process.
