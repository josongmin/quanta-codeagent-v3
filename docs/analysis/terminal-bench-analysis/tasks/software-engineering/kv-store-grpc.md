---
task: kv-store-grpc
category: software-engineering
difficulty: medium
tags: [coding, file-operations, system]
expert_min: 15
junior_min: 120
skill_class: CODE-AUTHOR
terminal_native: high
docker_image: alexgshaw/kv-store-grpc:20251031
---

# kv-store-grpc

**Goal** — Build a gRPC key→int KV store. Install `grpcio`/`grpcio-tools` 1.73.0, write `/app/kv-store.proto` defining a `KVStore` service with `GetVal(GetValRequest{key})→GetValResponse{val}` and `SetVal(SetValRequest{key,value})→SetValResponse{val}`, generate the `*_pb2.py`/`*_pb2_grpc.py` stubs into `/app`, implement `/app/server.py` (class `Server`, backed by a dict, port 5328), and keep the server running in the background.

**Solution shape** — Bash. `pip install grpcio==1.73.0 grpcio-tools==1.73.0`; heredoc the proto3 file; `python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=.` to generate bindings (note: `kv-store.proto` → `kv_store_pb2*`); heredoc `server.py` implementing `KVStoreServicer` (GetVal returns stored-or-0, SetVal writes dict and echoes value), served via `grpc.server(ThreadPoolExecutor)` on `[::]:5328`; launch with `setsid python server.py &` so it persists. Several files produced (proto + 2 generated + server).

**Verifier** — pytest: proto file exists with the required service/RPC/message names; `grpcio` importable; both generated `kv_store_pb2*.py` exist; `server.py` exists with `class Server`; **anti-cheat** — port 5328 is actually listening (TCP connect), and a real gRPC handshake works: `SetVal(key,42)` then `GetVal(key)==42`, update to 100 and re-read, all over a live channel (fails against a mock/HTTP server). reward binary 0/1.

**Difficulty drivers** — Requires the full protobuf/gRPC toolchain flow: writing a valid proto, running `protoc` with correct out-dirs, importing the generated modules (the hyphen→underscore filename mangling trips people), implementing the servicer, AND leaving a live background server the harness can dial. The "keep it running" requirement plus the live-handshake anti-cheat make it a real runtime/process task, not just code authoring.

**quanta attack points** — Mostly `container_exec` for install/gen/write, but the crux is a **persistent background process** the verifier connects to — the agent must launch the server detached and confirm the port is listening (a place where naive foreground execution or premature exit fails). The exit-code iterate loop helps for proto/codegen errors; the live-server requirement is where a scaffold that doesn't manage background processes cleanly can lose. Not a TUI, so no `pty_*`, but process lifecycle matters — `terminal_native` high.
