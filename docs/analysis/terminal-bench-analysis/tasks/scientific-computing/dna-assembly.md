---
task: dna-assembly
category: scientific-computing
difficulty: hard
tags: [biology, cloning]
expert_min: 60
junior_min: 180
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/dna-assembly:20251031
---

# dna-assembly

**Goal** — Given `sequences.fasta` (circular input plasmid, egfp/flag/snap inserts, desired output plasmid), design the minimal set of PCR primers that add BsaI Golden-Gate cut-sites so the four fragments assemble into the output plasmid. Write `primers.fasta` (headers `>TEMPLATE_DIR`).

**Solution shape** — Installs EMBOSS + primer3 (`apt-get install emboss primer3`). Uses `needle` global alignment to locate where each insert maps into the output and what to excise from the input vector. Extracts annealing regions with `sed`/`cut`, computes reverse complements with a `tr|rev` helper, derives 4-nt Golden-Gate overhangs from neighboring fragments' junctions (chained so egfp.left = rc(vector.right), etc.), and prepends a BsaI recognition sequence (`ggtctc`) + clamp to each primer. Verifies Tm of each annealing region with `oligotm` (exact flags `-tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500`). 8 primers, 1 fasta.

**Verifier** — pytest: exactly 16 lines, valid ATCG, all 8 named primers present. It parses each primer's BsaI site/overhang/binding, simulates PCR against each template, asserts annealing tracts are 15–45 nt, Tm∈[58,72] and each pair within 5°C (via real `oligotm`), overhangs chain correctly and are unique, and the assembled fragments concatenate to the output plasmid. Binary 0/1.

**Difficulty drivers** — Deep molecular-cloning domain knowledge: Golden Gate / BsaI cut-site rules, directional 4-nt overhang design for scarless one-pot assembly, reverse-complement bookkeeping, and Tm tuning under exact primer3 flags. Excise start/stop codons correctly. Very unforgiving multi-constraint verifier.

**quanta attack points** — `container_exec` for `needle`/`oligotm`/shell string ops. No TUI. Main risk is the biology: wrong overhang orientation or off-by-one annealing bounds fails assembly or Tm bands. The exit-code loop helps moderately — the agent can run `oligotm` locally for Tm feedback, but the full assembly-match check requires correctly reasoning about the whole junction graph, not just trial-and-error.
