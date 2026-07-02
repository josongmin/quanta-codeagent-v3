---
task: mteb-retrieve
category: data-science
difficulty: medium
tags: [data-processing, data-science, mteb]
expert_min: 15
junior_min: 45
skill_class: ML-TRAIN
terminal_native: med
docker_image: alexgshaw/mteb-retrieve:20251031
---

# mteb-retrieve

**Goal** — Given the query "terminal-bench", embed it and every line of `/app/data.txt` with the `bge-small-zh-v1.5` model (pinned revision `7999e1d3...`) via the `mteb` package (v1.36.8), rank documents by cosine similarity, and write the document with the **5th highest** similarity to `/app/result.txt`.

**Solution shape** — ~15-line Python heredoc. `mteb.get_model(..., revision=...)`, encode query with `PromptType.query` and docs with `PromptType.passage` (task_name="SciFact"), `model.similarity(...)`, assert similarities are unique, `torch.topk(k=5)` and take index [4] (the 5th). Writes the stripped line. Single script; relies on model download + mteb/torch already installed in image.

**Verifier** — pytest: `result.txt` exists, has exactly one line, and equals the fixed string `MTEB: Massive Text Embedding Benchmark`. Exact-match. reward binary 0/1.

**Difficulty drivers** — Mostly API-fluency: correct prompt_type per query/passage, the exact revision pin (embeddings differ across revisions), and "5th highest" indexing (off-by-one on topk). Determinism depends on pinned model weights. Low compute, no long-running process.

**quanta attack points** — `container_exec` one-shot: write script, run, read `result.txt`. Main risk is a wrong prompt_type or topk indexing producing a plausible-but-wrong line. The exit-code loop is unhelpful — the expected string is hidden, so the agent can't fit to it; it must get the embedding pipeline right on semantics.
