---
task: pytorch-model-recovery
category: model-training
difficulty: medium
tags: [coding, pytorch, machine-learning]
expert_min: 15
junior_min: 70
skill_class: ML-TRAIN
terminal_native: low
docker_image: alexgshaw/pytorch-model-recovery:20251031
---

# pytorch-model-recovery

**Goal** — Given a PyTorch `state_dict` (`/app/weights.pt`) and a dataset (`/app/dataset.pt`), reverse-engineer the model architecture into a `RecoveredModel` class that loads those weights exactly, then fine-tune **only** the `output_layer` (all else frozen) to lower MSE, and save the result as TorchScript to `/app/model.pt`. Must not modify `weights.pt`.

**Solution shape** — `solve.sh`: (1) `inspect_weights.py` prints each key + shape to infer structure; (2) `model.py` defines `RecoveredModel` = Linear embedding → sinusoidal PositionalEncoding → `TransformerEncoder` (3 layers) → `TransformerDecoder` (1 layer) → Linear output_layer (input_dim=64, d_model=128, nhead=4, ff=256), loads the state dict; (3) appends a training loop: Adam over `model.output_layer.parameters()` only, 10 epochs of MSE on the dataset, then `torch.jit.script` + save. ~2 files; the crux is deducing exact hyperparameters (nhead, layer counts, dims) from tensor shapes.

**Verifier** — pytest: `weights.pt` byte-for-byte unchanged vs ground truth; `model.pt` exists and TorchScript-loads; state dict keys match and every non-`output_layer` tensor is `allclose` to original; agent model's MSE on the dataset is strictly lower than the original weights' MSE. Binary 0/1.

**Difficulty drivers** — Medium: requires reading a state_dict and correctly reconstructing a transformer's exact architecture (wrong nhead/dim → weights won't load), plus knowing how to freeze layers and script to TorchScript. Short expert time (15 min) — it's a focused PyTorch idiom exercise, not a systems or long-running task. Main trap is the frozen-layer / TorchScript-round-trip requirement.

**quanta attack points** — `container_exec`: inspect weights, write model, run training, verify load. No interactivity. Very SWE-flavored, low terminal-native. The iterate-until-tests-pass loop works well: the agent can locally load `weights.pt` into its class to confirm the architecture matches before scripting, and check that MSE dropped — deterministic signals that map directly onto the grader.
