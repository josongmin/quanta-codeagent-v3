---
task: dna-insert
category: scientific-computing
difficulty: medium
tags: [biology, cloning]
expert_min: 30
junior_min: 120
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/dna-insert:20251031
---

# dna-insert

**Goal** — Given `sequences.fasta` (a circular input plasmid + a desired output plasmid), design the minimum number of PCR primer pairs for NEB's Q5 site-directed mutagenesis kit that convert input→output. Primers must obey annealing-length (15–45 nt), Tm 58–72 °C (per primer3 `oligotm` with specific flags), and ≤5 °C Tm difference within a pair. Output `primers.fasta` (forward first).

**Solution shape** — `solve.sh` installs EMBOSS + primer3, `cat`s the fasta, uses EMBOSS `needle` to align input vs output and finds the difference is a single 39 bp contiguous insert. Then with `sed`/`cut` it slices annealing regions from the input template (fwd cols 214–228, rev cols 173–213 reverse-complemented via a `tr|rev` function) and prepends the insert-encoding overhangs, writing a single primer pair to `primers.fasta`. Validates each annealing region's Tm with `oligotm`. ~30 lines of bioinformatics shell — one output file, one primer pair.

**Verifier** — pytest: `primers.fasta` has exactly 4 lines (one pair); sequences are pure ATCG; concatenating `rc(rev)+fwd` contains the exact 39 bp insert; the residual annealing parts overlap the known vector flanks and are 15–45 nt; both annealing Tms (via subprocess `oligotm` with the exact flags) are 58–72 °C and within 5 °C of each other. Binary 0/1.

**Difficulty drivers** — Domain knowledge is the gate: understanding site-directed mutagenesis primer design (back-to-back primers around an insertion, overhangs carrying the new bases, Tm computed only on the annealing portion). Requires the right tools (EMBOSS `needle`, primer3 `oligotm`) and precise index/reverse-complement arithmetic. "Minimum number of pairs" adds an optimality constraint. Medium: mechanically small once the biology is understood.

**quanta attack points** — `container_exec`: install EMBOSS/primer3, align, compute Tm, write fasta. No interactivity. Terminal-native med because the reference solution is genuinely shell-tool-driven (needle/oligotm/sed/cut), not pure code. The exit-code loop helps for the Tm-window constraints (agent can call `oligotm` itself and iterate primer boundaries), but discovering the correct annealing offsets requires actually reading the alignment.
