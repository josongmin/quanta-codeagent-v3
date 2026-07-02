---
task: caffe-cifar-10
category: machine-learning
difficulty: medium
tags: [cnn, caffe]
expert_min: null
junior_min: null
skill_class: ML-TRAIN
terminal_native: high
docker_image: alexgshaw/caffe-cifar-10:20251031
---

# caffe-cifar-10

**Goal** — Install BVLC Caffe 1.0.0 (CPU-only) at `/app/caffe`, build it, and train the CIFAR-10 "quick" CNN for exactly 500 iterations, logging to `/app/caffe/training_output.txt`. Final `cifar10_quick_iter_500.caffemodel` must exist and test accuracy (100 iters) must be >45% and within 5% of train accuracy.

**Solution shape** — `solve.sh` is a full SYSADMIN/build recipe: `apt-get` installs the Caffe C++ dep stack (protobuf, leveldb, opencv, hdf5, atlas, boost, glog, lmdb), creates `.so`/include symlinks for arch, clones Caffe, checks out `9b89154`, enables `CPU_ONLY`, patches legacy OpenCV constants (`CV_LOAD_IMAGE_*` → `cv::IMREAD_*`) and a protobuf `SetTotalBytesLimit` API break so it compiles on modern toolchains, `make all -j4`, edits solver prototxt (GPU→CPU, max_iter 4000→500), fetches CIFAR-10, builds the LMDB, runs `train_quick.sh` teeing output. ~40 lines of shell, no authored app code.

**Verifier** — pytest (no expert/junior times in toml): runs `caffe.bin --version` (must say 1.0.0), checks the `.caffemodel` exists and >100KB, checks solver prototxt says CPU + max_iter 500, checks Makefile.config `CPU_ONLY:=1`, checks training log reached "Iteration 500" (not 501) with realistic loss/accuracy lines, then invokes `caffe test -iterations 100` and asserts test acc >0.45 and within 5% of final train acc. reward 0/1.

**Difficulty drivers** — Compiling a decade-old C++ framework against modern libs is the real challenge: the API-break patches (OpenCV, protobuf) are non-obvious and build failures are cryptic. Long-running (build + train, 1200s timeout). Then a genuine ML accuracy gate that depends on correct data-prep + training completing. Heavy env/dep + build state, not app authoring.

**quanta attack points** — Almost entirely `container_exec` one-shot steps (apt, make, train) driven by exit codes; compilation errors surface via non-zero exit and stderr, so the iterate-until-build-passes loop is a strong fit. No TUI/`pty_*` need. Main risk: guessing the exact set of source patches to get `make all` to link, and the training actually clearing the 45%/5% accuracy bar within the time budget.
