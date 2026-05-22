# Cursor Rust Engine — Internals & Verification (companion)

> [cursor-rust-engine.md](cursor-rust-engine.md)의 심화 부록. 메인 문서가 "무엇이 있나"(인벤토리·표면)라면, 이 문서는 **"어떻게 동작하나"(검증된 내부 메커니즘)** + **메인 본문 정정 매트릭스**. 라운드2·3 병렬 audit(6 워커) 결과를 *라운드별이 아니라 subsystem별*로 통합. 마킹 ✅verbatim · ≈inferred · 🔒unobservable.

## 0. 범위 + 빌드 provenance ✅
- 대상: `file_service.darwin-universal.node`(29MB Rust napi-rs 2.16.17) + `crepectl`(4.6MB) + `cursorsandbox`(3.2MB). 검증=`strings`/`grep`/`nm`/일부 disasm.
- Cargo workspace 이름 **`everysphere`** (build host `/Users/runner/work/everysphere/everysphere/_work/1/s/`). **GitHub Actions macOS runner** 빌드.
- **gitoxide = vendored fork**, commit `9e8bbba`에 핀(`git checkouts/gitoxide-c5184609f4b57c0c/9e8bbba/`).
- Cursor-owned crate **8개**: `bugbot-util` · `codebase-snapshot` · `crepe` · `cursorignore` · `git_graph` · `gix-snapshot` · `ignore`(자체 fork) · `merkle_tree`. + NAPI 글루 `packages/file-service/src/*`.

---

## 1. crepe 인덱스 포맷 — rkyv 하이브리드 zero-copy ★

### 1.1 on-disk 3-파일 하이브리드 (단일 rkyv blob 아님) ✅
| 파일 | 포맷 | 내용 |
|---|---|---|
| `index.bin` | **커스텀 streaming header/entry + 임베드 rkyv `ArchivedHashTable`** | ngram_hash→posting offset 룩업(swiss-table). **mmap zero-copy 직접 접근**(검증만, copy 0) |
| `postings.bin` | freq-coded posting list | offset 슬라이스 |
| `metadata.json` | **miniserde JSON** (rkyv 아님) | `ngram_count/document_count/has_parent/parent_sha/hasher_id/stale_doc_count/compression_ratio/ngram_table_size_mb/header_size` |
- `.staging/` → `finalize_staging` 원자 rename.
- disasm 근거: rkyv arena `LocalKey::with` 단일 call-site가 `StreamingIndexHeader::write_to` 안 `0x100098aa0`(BufWriter flush 직전).

### 1.2 rkyv 검증 → "rebuild" 경로 ✅
rkyv 0.8.15 + rancor 0.1.1. 검증 enum: `BufferTooSmall/InvalidUsize/VersionMismatch/EndianMismatch/AlignmentMismatch/LabelMismatch`. → `VersionMismatch`/label-mismatch가 `"Unsupported or unrecognized index format ... Please rebuild the index using a current version of crepe"`로 surface. **이게 "mmap-resident, 별도 deserialize 없음"의 정확한 근거.**

### 1.3 trigram 확정 + 추출 ✅
- **ngram size = 3** disasm 확정: `extract_sparse_ngrams` 진입 `cmp x2,#0x3`(len≥3) + `sub x11,x2,#0x2`(n-2 윈도우=폭3).
- **sparse vs covering** 2종: `extract_sparse_ngrams`(해시선택 부분집합, 인덱싱) / `extract_covering_ngrams`(쿼리 커버리지 보장). GitHub blackbird 기법. sparse 임계 상수 `#0xc00`(3072)/`#0x400`(1024)/`#0x60`(96).
- case-insensitive: `case_folding.rs` Unicode 폴딩 + 쿼리시 **case permutations**(`max_case_permutations` 초과 → `query has too many case permutations`), folded-hash 빠른 경로 `hash_folded`.

### 1.4 posting 압축 4 codec ≈
`github-sparse-{crc32,freq,freq-tiny,freq-inv}` — `hasher_id`로 선택, mismatch `unrecognized hasher:`. per-list codec tag `Unknown compression type:`. crc32=integrity / freq=frequency-coded / freq-tiny=small-block / freq-inv=inverse-freq. precomputed `crepe::freq::frequency_table`. **varint/delta 명시 심볼 부재**(custom freq-table 방식 ≈). **posting-list SIMD 없음** 🔒 — Neon SIMD(`SlimNeon`)는 regex-automata Teddy prefilter 전용, intersection은 scalar sorted-merge(`union_sorted_posting_lists`/`intersect_sorted_posting_lists`).

### 1.5 LSM-style segment chaining ✅
- `parent_sha`+`has_parent`로 세그먼트 체인, `serialize_streaming_with_parent`, `loading parent index for segment`.
- 신 세그먼트는 parent 대비 delta만, `stale_doc_count`로 superseded 추적.
- 쿼리시 ancestor walk: `looking for best possible index (current_sha=)` / `no candidate indexes found (best is N commits away)` / `main branch is N commits away; falling back to current commit`. **인덱스가 commit SHA로 키잉** → 가장 가까운 조상 인덱스 재사용. age 컷오프 `old/stale index detected with age`.

### 1.6 encoding + symbol ✅
- **encoding_rs 0.8.35 풀 WHATWG 테이블**: Shift_JIS/EUC-JP/EUC-KR/GBK/Big5/KOI8/ISO-8859-1~16/windows-125x. **비-UTF8 소스를 UTF-8 디코드 후 trigram** → 인덱스 encoding-정규화.
- **symbol_path = path-level, tree-sitter 아님** 🔒(crepe에 tree-sitter/ctags 0). crepe는 `symbol_path`+`SymbolU16` 필드만. **AST 심볼은 외부 IsolatedTreesitter 서버 RPC**.

### 1.7 caps + dispatch ✅
- **3개 독립 4GB cap**: postings 파일 / 단일 posting list / metadata offset.
- crepectl = **build 전용 single subcommand**, 출력 miniserde JSON, `--memory-limit` 디폴트 25% RAM(미만 clamp), disk-spill(`spillable_index.rs`).
- 모듈 분할: build(`spillable_index/index_builder/bin/crepectl.rs`)=crepectl만, query(`query/regex/case_folding/ripgrep/json.rs`+live `on_file_event`)=`.node`만.
- dispatch: `"using in-process index builder"`(작은 repo) vs `"using external crepectl binary at '...'"`(OOM-safe).

---

## 2. gix-snapshot 엔진 — shadow git ODB ★

실은 **2 crate**: `gix-snapshot`(저수준 엔진) + `codebase-snapshot`(client/manager/budget/watcher/AIMD). NAPI 글루 `packages/file-service/src/snapshot.rs`.

### 2.1 shadow repo = bare gitoxide repo ✅
- 경로 `{snapshotsBaseDir}/{codebase_uuid}/`. **bare**: `[core] repositoryformatversion=0 bare=true` + HEAD `ref: refs/heads/main`.
- synthetic author **`git-native-history <capture@cursor.invalid>`** — `cursor.invalid` 도메인 유출방지 ★.
- ref namespace `refs/cursor/snapshots/{head,last-registered,last-verified}`.
- legacy `snapshots/`→`.snapshots-migrate-…` 마이그레이션.

### 2.2 metadata + reason ✅
- `SnapshotMetadataWire` 4 필드: `ignoreBlobId`+`latencySeconds`+`SnapshotReason`(internally tagged)+1(≈version/agent_request_id).
- `SnapshotReason`: `Manual`/`AgentRequestStart`/`AgentRequestEnd` (각 JSON `MANUAL`/`AGENT_REQUEST_START`/`AGENT_REQUEST_END`).

### 2.3 storage budget — operational vs cleanup ✅
- operational(pause): `"exceeds operational budget; pausing operations"`.
- cleanup(wipe): `"exceeds cleanup budget, wiping to reclaim space"` — **전체 폴더 wipe**(LRU 아님), re-init.
- 백그라운드 thread `storage-budget-monitor`. OTel `storage_budget.{operational_exceeded,cleanup,usage_ratio,check_error}`. 임계 ratio 🔒.

### 2.4 3 locks + worker lane ✅
- `maintenance.lock`/`init.lock`/`baseline.lock` 전부 on-disk → **multi-process safe**(여러 Cursor 창 동시).
- worker lane state machine `{Running→TimedOut→Backoff}`. soft timeout 안 죽이고 lane만 stale.

### 2.5 geometric repack ✅
- 2종 `shadow_repack`/`blob_repack`. trigger `"Launching {kind} repack: N packs in Ms"`. skip `"storage budget pause flag set"`/cooldown. 입력 pack cap `"Filtered N oversized packs (> bytes)"`. 기하 ratio 🔒.

### 2.6 BlobStore + 4-phase write ✅
- 시작시 loose→pack 마이그레이션(`Migrating N legacy loose objects`). 원자 `NamedTempFile`+`PackWriter dropped without finish()`.
- write span 5단: `snapshot_writer.plan`→`.ingest`→`.commit.build_tree`(incremental, full fallback)→`.commit.create_commit`→`.commit.finalize_index`. 요약 `"Snapshot created in N ms: commit=, reused=, written=, skipped=, removed=, tree=(removals=,upserts=), index_written="`.
- worker 4종 `scan/diff/discover/ingest`(gitoxide `in_parallel`), harness thread `gix-snapshot-{kind}`.

### 2.7 cross-process baseline ✅
`baseline.marker`+`secondary-index-baseline`. pub `"Published shared baseline: N entries, root_key="`. adopt 시 warm restart, 실패 시 full init. `ignore_config_hash` 매칭 필요.

### 2.8 time-travel API + chain walk ✅
- `getBfsPaths`(plural) — `gix-traverse/tree/breadthfirst.rs` BFS, ranked path. `inEditorChangedFiles`/`inEditorContext` — shadow-repo HEAD vs 워킹트리.
- `disposeFast`(OTel detach, background drain) vs `dispose`(flush block).
- chain walk depth limit `"Chain walk exceeded depth limit"`. **first-parent chain 엄격** — `AdvanceResult`: `Advanced`/`AlreadyAtOrPast`/`NotOnChain`/`InvariantViolation`.
- `GeneratePackfileStatus`: `Ready`/`NoWork`/`TooManyPending`/`Corrupt`/`IoError`.

---

## 3. git backends + diff ★

### 3.1 두 backend 분담 ✅(scope)/≈(trigger)
- **libgit2(git2 0.19/libgit2-sys 0.17) = narrow island**: 링크 소스 `call/commit/diff/lib/object/oid/panic/signature/tree.rs`만. `repo/revwalk/index/status/remote/reference.rs` **부재** → commit-object 읽기 + object/tree diff + signature 전용. 런타임 `couldn't initialize the libgit2 library`.
- **gitoxide(gix-*)** = status/dirwalk/refs/config/traverse/blame/pathspec/attributes/submodules/snapshot 전부.

### 3.2 diff 엔진 3개 ✅
1. **imara-diff 0.1.8** — gitoxide line/Myers+histogram. `imara-diff only supports up to N tokens`. **Patience 명시 미구현**(`'patience' ... defaults to 'histogram'`).
2. **dissimilar 1.0.11**(Google) — char-level `Chunk{Equal,Delete,Insert}`. GitGraph diffText/bugbot 렌더링.
3. **git2 diff** — libgit2 섬의 object-level.

### 3.3 GitGraph + GitClient ✅
- `GitGraph`(`git_graph` crate) = packfile 생성+diff surface: `generatePackfileV2`/`cleanupPackfile`/`diffLines`/`diffText`/`treeHash`/`treeHashAdvanced`/`logLines`, `base_sha→head_sha`+`includes`/`excludes`+`limitHit`. blame 아님. cloud/agent 컨텍스트용.
- `GitClient` = commit-verification + chain-walking 전용(generic facade 아님): `getCommitChain`/`getCommitVerifyData`/`getRepoHeadSha`/`getTotalCommitCount`/`getVerifyCommit`/`throwIfCommitDoesntExist`. GitGraph와 형제(gix object DB 위).

---

## 4. MerkleClient ✅
- `merkle_tree` crate 4파일(lib/async/incremental/local_construction). 증분 `before_hash`/`after_hash`, `Updated branch hashes`, 변경 branch만 rehash 전파(`missing parent branch for path`).
- `getImportantPaths` = **score 기반 랭킹**(`score` 필드, 단순 필터 아님). `getAllDirFilesToEmbed`=embeddable 필터 vs `getAllFiles`=전체 tracked.
- **in-memory 영속, rkyv 아님**(rkyv는 crepe 전용 확정). multi-root: `MULTI_ROOT_ABSOLUTE_PATH` 가상 root sentinel(여러 폴더→단일 multi-root Merkle tree, `failed to create multi-root Merkle tree:`).
- **simhash 🔒**: strings에 dimension/algorithm 흔적 0(`Datasketches`/`charikar`/`hamming`/`LSH`/`64,128,256`/`f32,f64` 부재). verbatim만 `"SimHash for"`/`"failed to compute SimHash for tree:"`/`getSimhash`. context 2곳(per-tree NAPI + git_history capture). **Charikar 추정은 근거부족**.

---

## 5. bugbot-util ✅
- `crates/bugbot-util/src/{lib,attr_file,cat_file,diff,markdown}.rs`.
- **gitoxide 안 씀 — `git` 바이너리 셸 호출**. args: `diff -U<N> --no-color --src-prefix=a/ --dst-prefix=b/ --ignore-submodules={all,none} --name-status -M -z --find-renames --diff-filter=RAMD --first-parent`, `cat-file --batch`/`cat-file blob <SHA>`, `check-attr --stdin`, `ls-files --other --exclude-standard`, `config --get-regexp`, `merge-base`, `rev-parse`, `symbolic-ref --short`.
- **cat_file 2-tier**: `--batch` 장수명 프로세스(`load_from_sha`) → 실패 시 `cat-file blob SHA` per-blob(`load_directly`), `falling back to direct git cat-file blob read`. wire 파서 엄격(`missing SHA1/expected 'blob'/missing file size; header:`).
- **markdown(pulldown-cmark 0.13.3)이 `BUGBOT.md` 룰 파싱** — bugbot 룰을 Markdown 작성.
- **attr_file** = `.gitattributes`/`linguist-generated` 처리(`git diff --name-only`로 생성파일 제외).
- 호출 계층: `gather:492`→`gather_changed_files:1243`→`{find_changed_files:1048,find_untracked_files:1089,find_changed_files_in_submodule:794}`→`{process_files_in_repo:688,process_files_in_submodules:373,gather_context_for_untracked_files:312}`→`calculate_git_diff_internal:638`→aggregated. submodule regex `(?m)^Submodule (.*?) contains modified content$|Submodule (.*?) ([a-f0-9]+)..[a-f0-9]+`.
- "Agent Review" = bugbot 유저-페이싱 이름. NAPI `LocalBugbotContext{getBugbotRules,inEditorChangedFiles,inEditorContext}`, `InEditorSourceKind=workingTree|singleCommit`.

---

## 6. captureGitHistory ✅
- 별도 파이프라인(snapshot 엔진과 별개): 사용자 *진짜 .git* 히스토리 슬라이스 → packfile 업로드(`cursor.codebaseTelemetry.triggerGitHistoryCapture` 백엔드).
- **GitHistoryStage**: `RefStore → Commit → PackTree → PackBlob → Pack`.
- **DeferredBlobReason 5종**: `StageCeiling`(스테이지 예산소진)/`ExceedsSizeLimit`(per-blob cap)/`MissingInSource`(ODB 없음)/`ModeOnlyChange`(모드만 변경, blob 불필요)/`PreimageNotRequested`(diff before-side 미요청).
- AIMD: 노브=`max_commits`. span attrs `previous_/updated_max_commits`+`consecutive_over_budget`+`budget_limit`. under budget→additive increase, over→counter++→임계시 multiplicative decrease. `CaptureBudget{maxCommits,maxWallTimeMs,maxPackBytes,targetDurationMs,consecutiveOverBudget}`.

---

## 7. Concurrency ✅
- **orx-* = crepe 인덱스 빌드 전용 ★**: `orx-{parallel 3.4,concurrent-iter 3.3,fixed-vec 3.23,pinned-concurrent-col 2.18}`의 유일 caller `crates/crepe/src/index_builder.rs`. rayon-대체, `fixed_chunk_executor`+work-stealing+pinned append-only col. panic `"a shard can only be inserted by the thread that owns it"`. Merkle/snapshot엔 안 씀.
- **TSFN 패턴**: Rust file_service가 자체 native thread + `ThreadsafeFunction`(`napi_create_threadsafe_function`)으로 host JS 콜백. → JS worker_thread 불필요.
- **notify 8.2.0** thread `notify-rs fsevents loop`, **3 consumer**: merkle(NAPI cb) / crepe(`on_file_event`, debounce 소유, `.git/logs/HEAD`+`.git/index` 특수처리) / snapshot(scan worker). `events.rs` 중앙 dispatcher. 디렉토리 이벤트 `expanded N directories into M file events`.
- worker pool 튜닝: `indexWorkers`+`searchWorkers` GrepClientOptions.

---

## 8. OTLP telemetry ✅
- `service.name = cursor_retrieval`. NAPI `OtlpConfig{tracesEndpoint, ghostMode}` — **ghostMode**=privacy/ghost-mode export 게이팅.
- 표준 `OTEL_*` env 전부 honor + BatchSpanProcessor(`OTEL_BSP_{MAX_QUEUE_SIZE,SCHEDULE_DELAY,MAX_EXPORT_BATCH_SIZE,EXPORT_TIMEOUT,MAX_CONCURRENT_EXPORTS}`). 메트릭 counter×24/meter×19/histogram×7/gauge×2.
- `codebase_snapshot.client.*` 전체키: `init.{duration_ms,attempts,outcome}` / `scan.{attempts,duration_ms,stale_patch_dropped}` / `snapshot.{blobs_written,blobs_skipped,bytes_written,pending_changes,attempts,duration_ms,buffer_overflowed,tree_strategy}` / `repack.{duration_ms,attempts,shadow_refresh_abort_long_backoff,skipped_storage_budget_pause}` / `storage_budget.{usage_ratio,check_error,cleanup,operational_exceeded}` / `maintenance.{lock_contention,worker_timeout}` / `file_watcher.drain_panic` / `dispose.tracer_shutdown.duration_ms`.
- crepe는 `crepe.{query,index,regex,serialization,git}` tracing target. merkle/grep 전용 namespace 없음(generic span).

---

## 9. 비-Rust 네이티브 모듈 ✅
- **Cursor-custom C++ N-API 딱 2개**:
  - **`cursor-proclist`**(Anysphere 원본) — `getDescendantPids`/`getProcessInformation`, libproc(`proc_listpids`)+`sysctl`. 프로세스 서브트리 PID+CPU/mem+`extensionId` 열거 = agent/terminal/extension 자식 리소스 회계. `out/main.js` 소비.
  - **`@anysphere/policy-watcher`**(VS Code fork, MS/João Moreno, `1.3.2-cursor.2`) — `CFPreferencesCopyAppValue`+`/Library/Managed Preferences/` 감시 = MDM/디바이스관리 정책.
  - 그 외 `.node`(keytar/node-pty/native-keymap/@parcel/watcher/@vscode/{spdlog,sqlite3,deviceid}/kerberos) = stock VS Code.
- **NAPI worker-thread**: `cursor-retrieval/worker/dist/main.js`는 file-service **로드 안 함** — 유일 요청 `computeLinesDiff`(diff CPU offload). file_service는 extension-host 1회 로드, 인덱싱은 Rust 자체 thread+TSFN.
- **cursorsandbox spawn**: `cursor-agent-exec/dist/main.js`가 `join(resourcesPath|execDir,"helpers","cursorsandbox[.exe]")` spawn. env `CURSOR_SANDBOX`/`CURSOR_ORIG_{UID,GID}`/`CURSOR_AGENT`/`CURSOR_ASKPASS*`. policy `--policy <JSON>`/`--policy-json`. (sandbox 상세=메인 §3)

---

## 10. Hash 알고리즘 ✅
- **SHA-1만**: `"gix::ObjectId should always be 20 bytes"`+`" is not a lowercase 40-hex SHA-1"`.
- **`sha1-checked` 스타일**: `"Detected SHA-1 collision attack with digest"` — SHAttered 방어.
- **SHA-256**: variant 있으나 `"Support for SHA256 is prepared but not fully implemented yet. For now we abort when encountered"` — 만나면 abort, 실용 미지원.
- xxhash/blake/siphash/farmhash/cityhash/murmur/wyhash/metro/ahash 전부 **부재**(전 binary scan 0).
- `filebuf_hash`≈파일버퍼 SHA-1. tree-node 결합≈자식해시 concat SHA-1(`Updated branch hashes`+`<root>` sentinel).

---

## 11. 메인 본문 정정 매트릭스 (audit가 뒤집은 것)
| 항목 | 초기 본문(틀린/약한) | 검증 결과 |
|---|---|---|
| GitClient 역할 | "generic git facade" | **commit-verification 전용**(6 메서드) |
| `getBfsPath` | (모호) | **`getBfsPaths`**(plural), CodebaseSnapshotClient, BFS over tree |
| gix-snapshot crate 수 | 1개 | **2개**(+codebase-snapshot) |
| simhash 차원/알고리즘 | "≈ Charikar 64-bit" | 🔒 (증거 부재) |
| `ignore_config_hash` 키워드 | 언급 | binary 부재 |
| crepectl 역할 | "별도 helper" | **build 전용 spillable**(쿼리 안 함) |
| bugbot git 호출 | (모호) | **셸 `git`**(NOT gix) |
| 인덱스 storage | "디스크 영속" | **mmap-resident**(rkyv swiss-table), 3×4GB cap, LSM chain |
| ignore layer | 4단 | **5단**(unifiedJson+legacy 분리) |
| AIMD 범위 | "snapshot 엔진" | **별도 파이프라인**(.git 캡처용) |
| Cursor-owned crate 수 | 6개 | **8개**(+git_graph/ignore/merkle_tree) |
| diff 엔진 수 | 2개 | **3개**(imara line/dissimilar char/git2 object) |
| libgit2 위치 | "fallback" | **narrow island**(commit/diff/signature만) |
| orx-* 용도 | (불명) | **crepe 빌드 전용** |
| worker thread | "indexing offload" | **diff offload만**(Rust는 TSFN) |
| ngram size | "≈3" | **3 disasm 확정**(trigram) |
| Merkle 영속 | (모호) | **in-memory 확정**(rkyv 아님) |
| symbol 추출 | (모호) | **path-level**(AST는 외부 treesitter 서버) |

---

## 12. 명시적 부재 / 🔒 미관측
- 🔒 simhash 차원·알고리즘 (numeric constant만, strings 부재)
- 🔒 Merkle/tree-node 해시 정확한 결합 방식 (SHA-1 family 추정)
- 🔒 4 sparse codec 바이트 layout (discriminator 문자열만)
- 🔒 storage budget / geometric repack 임계 ratio (compiled constant)
- 🔒 `getImportantPaths` score 공식 / `MULTI_ROOT_ABSOLUTE_PATH` 리터럴 값
- 🔒 git2 vs gix 라우팅 정확한 call-site predicate (링크 소스셋으로 scope만 추론)
- ❌ posting-list SIMD (Neon은 regex prefilter 전용)
- ❌ tree-sitter in crepe (외부 서버 RPC)

---

**메인 문서**: [cursor-rust-engine.md](cursor-rust-engine.md) · **자매**: [cursor.md](cursor.md) / [cursor-localization.md](cursor-localization.md)
