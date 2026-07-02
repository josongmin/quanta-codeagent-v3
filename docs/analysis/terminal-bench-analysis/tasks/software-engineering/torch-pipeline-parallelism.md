---
task: torch-pipeline-parallelism
category: software-engineering
difficulty: hard
tags: [system]
expert_min: 240
junior_min: 1200
skill_class: ML-TRAIN
terminal_native: low
docker_image: alexgshaw/torch-pipeline-parallelism:20251031
---

# torch-pipeline-parallelism

**Goal** — Implement `/app/pipeline_parallel.py` with `train_step_pipeline_afab(model, inputs, targets, device, dtype)` that runs one **pipeline-parallel** training step over a LLaMA model using all-forward-all-backward (AFAB) scheduling: partition layers across ranks, run all microbatch forwards, then all backwards, using `torch.distributed` P2P for inter-stage hidden-state/gradient transfer. Last rank computes cross-entropy scaled by #microbatches. No hooks allowed in the implementation.

**Solution shape** — `solve.sh` writes one `pipeline_parallel.py` (~120 lines). A `p2p_comm` helper builds `dist.P2POp` isend/irecv lists (prev/next rank guarded by bounds) and runs `batch_isend_irecv`. `train_step_pipeline_afab` computes a balanced layer split by rank, slices `model.model.layers` and replaces embed/norm/lm_head with `nn.Identity` on non-boundary ranks; forward loop receives hidden states (or raw inputs on rank 0), sends to next; backward loop receives grad from next rank, `torch.autograd.backward` with `grad_tensors`, sends input grad to prev. Uses `retain_grad`. One substantive distributed-systems file.

**Verifier** — pytest spawns `world_size` ∈ {1,2} via `torch.multiprocessing` with a gloo process group, registers forward/backward **hooks in the test** to capture per-layer activations, and compares the agent's pipelined forward *and* backward activations against a reference non-pipelined model. Also greps the file to forbid `register_forward_hook`/`register_full_backward_hook`, and checks each rank runs a reasonable layer count. Binary 0/1.

**Difficulty drivers** — Hard distributed-systems + autograd: correct layer partitioning, exact tensor shapes across stages, non-deadlocking batched P2P (isend/irecv ordering), gradient plumbing through `autograd.backward(grad_tensors=…)`, and loss scaling — all matching a reference to activation precision. Multi-process gloo debugging is painful, and the no-hooks rule blocks the easy instrumentation path. Longest expert time in batch (240 min).

**quanta attack points** — `container_exec`: write file, run the distributed pytest. Low terminal-native (a coding task; the multiprocessing is inside the grader). Main risk: deadlocks/shape mismatches in P2P that hang or crash under world_size=2, which the agent must reproduce locally to debug. The exit-code loop helps only if the agent can run a matching multi-rank harness itself; otherwise it's flying blind against activation-level comparison. Correctness is subtle and hard to self-verify.
