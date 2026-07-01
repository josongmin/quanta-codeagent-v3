---
task: torch-tensor-parallelism
category: software-engineering
difficulty: hard
tags: [system]
expert_min: 240
junior_min: 1200
skill_class: ML-TRAIN
terminal_native: low
docker_image: alexgshaw/torch-tensor-parallelism:20251031
---

# torch-tensor-parallelism

**Goal** — Implement `ColumnParallelLinear` and `RowParallelLinear` (`torch.nn.Module`) in `/app/parallel_linear.py`: given a full `master_weight`, shard it across ranks (columns vs rows), gather/all-reduce outputs, shard/replicate bias accordingly, and produce correct forward outputs AND gradients for world_size 1/2/4.

**Solution shape** — ~130-line Python via heredoc. Column variant shards `out_features` (weight rows `[start:end,:]`, bias sharded), forward = copy-to-region → `F.linear` → all-gather along last dim. Row variant shards `in_features` (weight cols `[:,start:end]`, bias full), forward = `F.linear` → all-reduce → add full bias. Four `torch.autograd.Function` helpers (`_CopyToModelParallelRegion`, `_ReduceFromModelParallelRegion`, `_GatherFromModelParallelRegion`, and reduce) implement the correct forward/backward collective pairs (gather↔split, all-reduce↔identity) so gradients match a reference `nn.Linear`.

**Verifier** — pytest with `torch.multiprocessing.spawn` over the gloo backend, parametrized world_size {1,2,4} × bias {True,False}. Each rank checks: weight/bias slices equal the reference layer's partition; forward output `allclose` to a single-process `nn.Linear`; and backward — weight.grad and bias.grad slices `allclose` to the reference grads (atol 1e-5). reward binary 0/1. The gradient checks are the hard part — the autograd collective pairing must be exactly right.

**Difficulty drivers** — Requires real Megatron-style tensor-parallel knowledge: which dim to shard, the forward/backward collective duals (all-gather's backward is split, copy-region's backward is all-reduce), and bias sharding rules — all verified numerically including gradients across multiple world sizes. A forward-only-correct implementation still fails the grad asserts. Runs a live multi-process distributed group.

**quanta attack points** — Authoring task: `container_exec` to write the module and run pytest (which spawns the process group internally); no interactive session needed. Main failure risk: incorrect autograd backward collectives (gradients wrong even when forward is right) or off-by-one weight slicing that only shows at world_size 2/4. The exit-code loop helps — the parametrized suite reports which world_size/bias/direction combo fails, giving targeted signal to fix the collective pairing.
