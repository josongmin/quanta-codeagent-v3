# Cursor Rust Engine — `file_service.darwin-universal.node` 분석

> **Scope**: Cursor 3.2.16에 번들된 단일 Rust `.node` 바이너리를 strings/심볼 dump 기반으로 리버스 분석.
> **대상**: `@anysphere/file-service/file_service.darwin-universal.node` (Mach-O universal2, x86_64+arm64, ~30 MB).
> **Method**: Static-only — 코드 실행 없음. `strings -a` + 심볼 테이블 + panic-frame leak이 일차 증거. JS 측 NAPI 익스포트 이름은 동적 호출 없이 RTYPEINFO 문자열로 직접 노출되어 있음.
> **Markings**: ✓ verbatim 확인 (코드 펜스 내 문자열은 binary에 그대로 존재) / ≈ panic frame·심볼명에서 합리적 추론 / 🔒 .node strings에서 관측 불가능

---

## Table of Contents

- [§0. 증거 파일 + 검증 방법](#0-증거-파일--검증-방법)
- [§1. 개요 — 하나의 .node가 무엇인가](#1-개요--하나의-node가-무엇인가)
- [§2. NAPI 표면 — 6 클라이언트 인벤토리](#2-napi-표면--6-클라이언트-인벤토리)
- [§3. 내부 crate workspace 구조](#3-내부-crate-workspace-구조)
- [§4. 각 모듈 상세](#4-각-모듈-상세)
  - [§4.1 MerkleClient (file-service retrieval helper)](#41-merkleclient-file-service-retrieval-helper)
  - [§4.2 GrepClient — crates/crepe](#42-grepclient--cratescrepe)
  - [§4.3 CodebaseSnapshotClient — crates/gix-snapshot + codebase-snapshot](#43-codebasesnapshotclient--cratesgix-snapshot--codebase-snapshot)
  - [§4.4 GitClient — gitoxide 직사용](#44-gitclient--gitoxide-직사용)
  - [§4.5 DiffClient + crates/bugbot-util — PR 코드리뷰 백엔드](#45-diffclient--cratesbugbot-util--pr-코드리뷰-백엔드)
  - [§4.6 LocalBugbotContext & 결과 타입](#46-localbugbotcontext--결과-타입)
- [§5. 통합 패턴 — 왜 단일 .node인가](#5-통합-패턴--왜-단일-node인가)
- [§6. 가장 놀라운 발견 3개](#6-가장-놀라운-발견-3개)
- [§7. quanta 흡수 시사 + 베끼면 안 되는 것](#7-quanta-흡수-시사--베끼면-안-되는-것)

---

## §0. 증거 파일 + 검증 방법

**File path** ✓:
```
/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-retrieval/
  node_modules/@anysphere/file-service/file_service.darwin-universal.node
```

**Architecture** ✓ (`file` output):
```
Mach-O universal binary with 2 architectures:
  [x86_64: Mach-O 64-bit dynamically linked shared library]
  [arm64]
```

**Size**: 29,950,912 bytes (≈30 MB).

### Language confirmation — 7 markers

**왜 Rust 단독인가** — C++ markers 0건, Rust markers는 binary 전체에 산재.

1. ✓ napi-rs 시그니처:
   ```
   Failed to convert return value in ThreadsafeFunction callback into Rust value: napi_rs_threadsafe_function
   ```
2. ✓ `std::sync` Rust 표준 라이브러리:
   ```
   PoisonError
   ```
3. ✓ 수백 개의 `crates/<name>/src/<file>.rs:<line>` panic frame leak (§3 트리 참조).
4. ✓ gitoxide crate 이름들 verbatim:
   ```
   gix-actor  gix-attributes  gix-bitmap  gix-chunk  gix-command
   gix-commitgraph  gix-config  gix-config-value  gix-date  gix-diff
   gix-dir  gix-discover  gix-features  gix-filter  gix-fs  gix-glob
   gix-hash  gix-hashtable  gix-ignore  gix-index  gix-lock  gix-object
   gix-odb  gix-pack  gix-packetline  gix-path  gix-pathspec  gix-quote
   gix-ref  gix-refspec  gix-revision
   ```
5. ✓ Rust ecosystem markers: `aho-corasick`, `cargo`, `tracing-subscriber` 메시지, Rust regex enum variants (`CaptureLimitExceeded`, `ClassEscapeInvalid`, 등 30+).
6. ✓ **C++/libstdc++/libc++ 마커 0건**: `__cxa_throw`, `_ZNSt`, `__cxxabiv1`, `libc++`, `libstdc++` 모두 `grep` 결과 없음. C++ 코드 없음.
7. ✓ napi-rs build-target naming: `darwin-universal.node` — Node.js의 universal2 napi-rs convention. (`@napi-rs/cli` 빌드 산출물 표준).

**Build provenance leak** ✓ (GitHub Actions runner path):
```
/Users/runner/work/everysphere/everysphere/_work/1/s/crates/bugbot-util/src/cat_file.rs
```
→ Cargo workspace 이름이 **`everysphere`**, GitHub repo `everysphere/everysphere`. Cursor 3.2 monorepo.

---

## §1. 개요 — 하나의 .node가 무엇인가

`file_service.darwin-universal.node`는 **Cursor의 로컬 코드-인텔리전스 백엔드 전체**를 담은 단일 Rust addon이다. 다섯 개의 독립 책임이 하나의 빌드 산출물로 정적 링크되어 있다.

| 책임 | 내부 crate | 표면 |
| --- | --- | --- |
| Workspace 파일 인벤토리 + Merkle 해시 (retrieval helper용) | `file-service` + Merkle 구현 | `MerkleClient` |
| ngram-인덱스 grep (정규식 포함) | `crates/crepe` | `GrepClient` |
| Cursor-내부 snapshot 시스템 (mini-git) | `crates/gix-snapshot` + `crates/codebase-snapshot` | `CodebaseSnapshotClient` |
| Pure-Rust git 조작 (in-process) | `gix-*` 직접 사용 | `GitClient` |
| PR diff / bugbot 리뷰 컨텍스트 | `crates/bugbot-util` | `DiffClient`, `LocalBugbotContext` |

**왜 단일 .node인가** — 추정 근거 (≈):
- **Cross-crate zero-copy**: snapshot이 commit한 직후 crepe 인덱스를 동일 프로세스에서 갱신 (refs `cursor/crepe` ✓ verbatim — §4.2 참조). FFI 경계가 없어야 mmap된 packfile/posting list를 재해석 없이 공유.
- **단일 OTel tracer**: 한 `BatchSpanProcessor` ✓ 가 다섯 모듈의 span을 묶어 한 endpoint(`OtlpConfig.tracesEndpoint` ✓)로 보낸다.
- **File watcher fanout**: `crates/codebase-snapshot/src/file_watcher.rs` ✓ 하나가 snapshot + crepe 양쪽을 깨운다 (≈ — fanout 라우팅 코드 자체는 strings에서 직접 안 보임).
- **TypeScript Extension 측 단순화**: VS Code extension host에서는 `require('@anysphere/file-service')` 한 번이면 다섯 기능이 전부 풀린다.

---

## §2. NAPI 표면 — 6 클라이언트 인벤토리

NAPI export 이름은 napi-rs `#[napi]` 매크로가 만든 클래스 메타데이터에 verbatim 박혀 있다. 아래는 RTTI-스타일 strings에서 추출.

### 2.1 `MerkleClient` ✓ verbatim
```
build  dispose
getAllDirFilesToEmbed  getAllFiles  getImportantPaths
getNumEmbeddableFiles  getSimhash  getSubtreeHash
onDidChange  onDidCreate  onDidDelete
```

| Method | 역할 (≈) |
| --- | --- |
| `build()` | 워크스페이스 전체 스캔 → Merkle 트리 구축 |
| `dispose()` | 리소스 해제 (file watcher, mmap) |
| `getAllFiles()` | 추적되는 파일 전체 enumerate |
| `getAllDirFilesToEmbed()` | embedding 후보 파일만 (cursorignore + size filter 적용) |
| `getImportantPaths()` | 중요도-스코어링된 경로 subset (≈ — 알고리즘 미관측) |
| `getNumEmbeddableFiles()` | 카운트만 (cheap query) |
| `getSimhash(path)` | 단일 파일 simhash (near-dup 탐지용 ≈) |
| `getSubtreeHash(path)` | 디렉터리 subtree Merkle 노드 해시 |
| `onDidChange / onDidCreate / onDidDelete` | NAPI threadsafe-callback 이벤트 (✓ `napi_rs_threadsafe_function`) |

### 2.2 `GrepClient` ✓ verbatim
```
query  queryWithCallback  warmup
getTrackedState  getWorkspaceStatuses
onTrackedStateInvalidated  offTrackedStateInvalidated
```
세부 옵션 schema도 binary에 그대로:
```
QueryOptions { whole_word, multiline, context_before, context_after,
               max_lines, filter_path }
GrepSearchOptions { caseInsensitive, wholeWord, maxLinesPerFile,
                    context, contextBefore, contextAfter,
                    maxResults, sort, excludes, includes, literal,
                    mode, path, multiline }
GrepClientOptions { searchWorkers, indexWorkers, crepectlPath,
                    maxIndexHoursSinceAccessed, maxIndexHoursSinceCreated,
                    maxIndexRevisionDiff, maxInMemoryDocuments }
GrepWorkspace { path, commitHash, excludes }
```

### 2.3 `CodebaseSnapshotClient` ✓ verbatim
```
addCodebase  removeCodebase
disposeFast  commitAll  recordChanges
markRegistered  markVerified  markVerifiedV2
getBfsPath  inEditorChangedFiles  inEditorContext
getBugbotRules  updateCursorAuthToken
```
옵션:
```
CodebaseSnapshotClientOptions {
  snapshotsBaseDir, enableFileWatcher, otlpConfig, ghostMode
}
OtlpConfig { tracesEndpoint, ghostMode }
PackfileOptions { ready, maxCommits, ... }
```
이벤트 모드:
```
SnapshotReason: Manual | AgentRequestStart | AgentRequestEnd
                (JSON tag:  MANUAL  AGENT_REQUEST_START  AGENT_REQUEST_END)
InEditorSource: workingTree | singleCommit
```

### 2.4 `LocalBugbotContext` ✓ verbatim (returned by `getBugbotRules` / `inEditorContext` ≈)
세부 schema:
```
BugbotContextIncludes {
  fileContentSource, submodules, bugbotRules, untracked
}
ChangedFilesIncludes { filterPaths, untracked, submodules }
InEditorContentSource: context | (other variants — ≈)
```

### 2.5 `GitClient` ✓ verbatim (class name in binary)
공개 메서드는 strings에서 method 리스트로 명확히 군집되어 있진 않지만, 다음 capability가 panic-frame과 에러 메시지로 확인:
- HEAD/branch 디스커버리: `Failed to get HEAD reference`, `Failed to peel to commit`, `Failed to get root SHA`, `Failed to create revwalk`
- Commit graph 탐색: `getTreeStructure`, `getRelevantPaths` ✓
- Diff 계산: `diffLines`, `cleanupPackfile`, `generatePackfileV2` ✓
- 도구: `GitGraph` ✓ (panic 메시지 `Failed to create GitGraph`)

### 2.6 `DiffClient` ✓ verbatim
PR-review 워크플로 전용 진입점. Strings:
```
DiffClient  Starting full rebuild  Rebuild failed in
```
≈ — 정확한 NAPI 메서드 리스트는 RTTI 군집이 명확하지 않음. 그러나 §4.5에서 보듯 내부적으로 `bugbot-util::diff` 함수들을 호출한다.

### 2.7 결과 타입 ✓
```
AdvanceResult: ok | already_at_or_past | not_on_chain | invariant_violation
GeneratePackfileStatus: (enum, variants not all observable — ≈)
SnapshotMetadataWire: struct with 4 elements
```

---

## §3. 내부 crate workspace 구조

panic frame `crates/<crate>/src/<file>.rs:<line>` leak으로 재구성된 트리.

```
packages/file-service/src/          ✓ NAPI 진입
  lib.rs                            (Class 등록, threadsafe callback)
  grep.rs                           (GrepClient NAPI binding → crepe)
  snapshot.rs                       (CodebaseSnapshotClient NAPI binding)
  init.rs                           (tracer init, OtlpConfig 파싱)

crates/
  bugbot-util/src/                  ✓ PR review
    cat_file.rs                     (2-tier git blob loader)
    diff.rs                         (find_changed_files / aggregated_*)
    markdown.rs                     (≈ BUGBOT.md 파싱)
    lib.rs

  codebase-snapshot/src/            ✓ snapshot 매니저 layer
    manager.rs                      (NAPI 호출 진입)
    file_watcher.rs                 (notify-rs based watcher drain thread)
    storage_budget.rs               (operational vs cleanup thresholds)
    types.rs                        (SnapshotMetadataWire, SnapshotReason)
    git_history/
      capture.rs                    (AIMD capture budget)
      pack_capture.rs               (packfile materialization)

  crepe/src/                        ✓ ngram grep 엔진
    lib.rs                          (cursor/crepe ref + bootstrap)
    index.rs                        (in-memory pending docs + ngram index)
    index_builder.rs                (build_with_gix / build_from_repo)
    query.rs                        (literal + regex)
    regex.rs                        (regex → ngram conjunction)
    serialization.rs                (postings.bin / metadata.json / index.bin)
    disk_index.rs                   (mmap'd index reader)
    ngrams.rs  case_folding.rs  freq.rs
    filter.rs                       (no-filter / hidden-file / ripgrep-default)
    git/mod.rs                      (gix 통합 — submodule status)
    ripgrep/{json,util}.rs          (fallback path)

  cursorignore/src/lib.rs           ✓ .cursorignore matcher

  gix-snapshot/src/                 ✓ Cursor-내부 mini-git repo
    io.rs  file_lock.rs  ignore.rs  ignore/{stack,walk}.rs
    engine/
      coordinator.rs
      coordinator/{policy,repack,scan}.rs
      snapshotter/{initialize,change}.rs
      snapshot_writer/{ingest,tree,plan,commit}.rs
      workers/repack.rs
    storage/
      blob_store.rs                 (loose → pack 마이그레이션)
      shadow_repo.rs (≈)
      shared_root.rs (≈)
    objects/
      loose/{enumerate,reader}.rs
      pack/{index,ingest,writer}.rs
    maintenance/
      inventory.rs  repack.rs
    index/secondary.rs              (secondary-index-baseline)
    index/secondary/{diff,patch,slice}.rs

# Cargo dependencies (gitoxide ecosystem — ✓ verbatim)
gix-actor  gix-attributes  gix-bitmap  gix-chunk  gix-command
gix-commitgraph  gix-config  gix-config-value  gix-date  gix-diff
gix-dir  gix-discover  gix-features  gix-filter  gix-fs  gix-glob
gix-hash  gix-hashtable  gix-ignore  gix-index  gix-lock  gix-object
gix-odb  gix-pack  gix-packetline  gix-path  gix-pathspec  gix-quote
gix-ref  gix-refspec  gix-revision
# 그 외 ecosystem
aho-corasick  regex  serde  tracing-subscriber  opentelemetry (BatchSpanProcessor)
crossbeam-channel  notify (file watcher)  napi-rs
```

---

## §4. 각 모듈 상세

각 sub-section은 **모듈 → 설명 → 동작 → 주요 로직 → 유즈케이스 → 근거** 형식.

### §4.1 MerkleClient (file-service retrieval helper)

**모듈**: `packages/file-service/src/lib.rs` + Merkle 구현 (정확한 crate 위치 🔒 — `MerkleClient` panic frame이 lib.rs 외부에서 직접 leak되지 않음).

**설명**: 워크스페이스 파일 인벤토리 + 디렉터리 해시 트리. cursor-retrieval extension이 embedding 업로드 전 "어떤 파일을 보낼지" 결정하는 데 사용.

**동작** (≈):
1. `build()` — 전체 워크스페이스를 한 번 walk, `.cursorignore` 적용, 파일별 simhash + 디렉터리 subtree Merkle 노드 계산.
2. file watcher가 변경 알림 (`onDidChange/Create/Delete`) — 영향받은 subtree만 rehash (≈ — incremental 알고리즘 strings 미관측).
3. JS 쪽이 `getSubtreeHash(dir)`로 dir-level dedup, 변경된 subtree만 embedding 재업로드.

**주요 로직** (≈):
- `cursorignore` crate ✓ — `.cursorignore` 파일 매처 단독 crate로 분리되어 있다.
- `getSimhash` — 파일 단위 LSH (≈ 정확한 알고리즘 미관측). Near-dup 탐지에 쓰일 것.
- 정확한 hash function (SHA-1/blake3 등) 🔒.

**유즈케이스**:
- Cursor의 codebase indexing onboarding ("indexing your codebase" 진행률)
- Embedding 업로드 candidate 선정
- 변경된 디렉터리만 재인덱싱

**근거**:
- NAPI export names ✓ (§2.1)
- `getAllDirFilesToEmbed`, `getNumEmbeddableFiles` 이름이 embedding-pipeline용 임을 강하게 시사

**한계**: Merkle 트리의 fanout, hash 알고리즘, simhash 차원수는 .node strings에서 관측 불가 (🔒). 추가 디깅 필요.

---

### §4.2 GrepClient — `crates/crepe`

**모듈**: `crates/crepe/src/{lib,index,index_builder,query,regex,serialization,disk_index,ngrams,case_folding,freq,filter}.rs`

**설명**: **ngram-인덱스 기반 grep 엔진**. ripgrep wrapper 아님. 디스크에 mmap된 역색인을 두고, query를 ngram 집합으로 변환 → posting list 교집합/합집합 → 후보 라인 검증.

**동작** ✓ (verbatim 추적):

1. **Bootstrap** (`crepe::lib`, `crepe::index_builder::build_with_gix`):
   ```
   bootstrapping repository index at '...' (cache_path=...)
   build_with_gix
   build_from_repo
   indexed submodule  /  failed to index submodule:
   ```
   - gitoxide로 repo HEAD 디스커버, worktree+commit 양쪽 walk.
   - `cursor/crepe` ref ✓ — Cursor가 crepe 인덱스의 git revision tracking을 위한 자체 ref 사용.
2. **Index file format** ✓ — 디렉터리 구조:
   ```
   <cache>/<repo>/
     postings.bin          (posting lists, gzip-style streaming layout)
     metadata.json         (header — ngram_count, document_count, has_parent,
                            stale_doc_count, compression_ratio, ngram_table_size_mb,
                            parent_sha, hasher_id, commit_git_revision)
     index.bin             (ngram → posting-list offset map)
     .staging/             (atomic write staging dir)
   ```
   "streaming serialization complete, finalizing staging directory" ✓ — 빌드는 staging에 쓰고 atomic rename.
3. **Sparse ngram 코덱 4종** ✓:
   ```
   github-sparse-crc32  github-sparse-freq
   github-sparse-freq-tiny  github-sparse-freq-inv
   ```
   GitHub의 code search ngram 압축 기법을 사용 (≈ — github의 sparse ngram + frequency-based codec).
4. **Query** (`crates/crepe/src/query.rs`):
   ```
   query '<...>' (literal=<bool>, case_insensitive=<bool>)
   ngram_hash
   union_sorted_posting_lists
   intersect_sorted_posting_lists
   too many case permutations for literal query
   literal query too short
   ```
   - 쿼리 → ngram 분해 → posting list 교집합으로 후보 문서 추림 → 라인-레벨 검증.
   - case-insensitive는 case-permutation으로 처리하다 너무 많아지면 abort.
5. **Regex** (`crates/crepe/src/regex.rs`):
   - regex를 ngram conjunction으로 분해 (≈ — Russ Cox's "Regular Expression Matching with a Trigram Index" 식 ≈).
   - 한계: "literal query OK, remaining() = ..." → regex residual은 raw scan.
6. **Refresh** (incremental):
   - `crepe::lib` strings:
     ```
     git head changed: marked index change as pending
     reset index to head in ... documents in commit, ... in worktree
     refreshing index (... stale documents detected)
     refreshed ... new documents
     queued background index refresh for '...'
     ```
   - `.git/logs/HEAD` + `.git/index` 변화 감지 → 인덱스 reset/rebuild trigger.
7. **Filter mode** ✓:
   ```
   no-filter  hidden-file-filter  ripgrep-default-filter
   ```
8. **External fallback** ✓:
   ```
   failed to execute 'crepectl build': ...
   using external crepectl binary at '...'
   using in-process index builder
   ```
   in-process Rust 빌더가 디폴트, `crepectl` 외부 바이너리 fallback 가능.
9. **Index limits** ✓ — `IndexLimits { max_in_memory_documents, max_untracked_documents }`:
   - "index is too large to fit in memory (... documents)"
   - "repository has too many untracked files to be kept in sync (... untracked)"

**유즈케이스**:
- Cursor agent의 `grep_search` 툴 백엔드
- 사용자가 ⌘+Shift+F (workspace search)
- `getWorkspaceStatuses` — 인덱스 빌드 진행률 UI

**근거** — 모든 strings ✓ verbatim from binary.

**한계 / 추가 디깅 필요**:
- ngram의 정확한 N값 (trigram? variable?) 🔒 — strings에서 직접 안 드러남
- posting list 압축 알고리즘 (delta + variable-length encoding?) 🔒
- "github-sparse-*" 4종이 어떻게 선택되는지 🔒

---

### §4.3 CodebaseSnapshotClient — `crates/gix-snapshot` + `codebase-snapshot`

**모듈**: `crates/codebase-snapshot/src/{manager,file_watcher,storage_budget,types}.rs` + `crates/gix-snapshot/src/**` (engine, storage, objects, maintenance, index/secondary)

**설명**: **Cursor 내부 mini-git repository**. 사용자의 워크스페이스 변경 이력을 별도 git repo에 packfile로 캡처. agent가 changes를 되돌리거나 diff를 보여줄 때 사용. **사용자의 진짜 `.git/`는 건드리지 않는다** (별도 디렉터리 `snapshotsBaseDir` ✓).

**동작** ✓:

1. **Snapshot refs** ✓ verbatim:
   ```
   refs/cursor/snapshots/head
   refs/cursor/snapshots/last-registered
   refs/cursor/snapshots/last-verified
   ```
   - `head` — 현재 가장 최근 캡처
   - `last-registered` — agent에게 "이 시점부터 변경된 거 추적해" 마킹
   - `last-verified` — agent가 "이 시점은 안전하다고 verify했음" 마킹
2. **Snapshot reasons** ✓:
   ```
   SnapshotReason: Manual | AgentRequestStart | AgentRequestEnd
   ```
   각 agent 요청 시작/끝마다 한 쌍씩 캡처. Manual은 사용자 명시 트리거.
3. **Engine 구조** ✓ (panic frame leak):
   - `engine/coordinator.rs` — top-level 컨트롤러
   - `engine/coordinator/policy.rs` — 워커 timeout/backoff (`Worker exceeded soft timeout, transitioning to TimedOut`)
   - `engine/coordinator/scan.rs` — 워크스페이스 스캔 (`Launching scan worker`)
   - `engine/coordinator/repack.rs` — geometric repack 트리거
   - `engine/snapshotter/{initialize,change}.rs` — 초기화 + 변경 처리
   - `engine/snapshot_writer/{plan,commit,ingest,tree}.rs` — 트리/커밋 생성 4단계
   - `engine/workers/repack.rs` — repack worker 스레드
4. **Storage budget** ✓ (`codebase-snapshot/src/storage_budget.rs`):
   ```
   Storage budget periodic check
   Snapshot storage now exceeds operational budget; pausing operations
   Snapshot storage back within operational budget; resuming operations
   Snapshot storage exceeds cleanup budget, wiping to reclaim space
   ```
   - **Operational threshold**: 초과 → 새 snapshot 일시 정지 (cleanup으로 자가복구 시도)
   - **Cleanup threshold**: 초과 → 디렉터리 전체 wipe + 재시작 (data loss accepted)
   - OTel: `codebase_snapshot.client.storage_budget.{usage_bytes,budget_bytes,disk_bytes,available_bytes,usage_before,usage_after}`
5. **AIMD capture budget** ✓:
   ```
   capture budget AIMD transition
     subsystem=git-history
     previous_max_commits / updated_max_commits
     previous_consecutive_over_budget / updated_consecutive_over_budget
     budget_limit, wall_time, pack_bytes
   ```
   - **Additive Increase / Multiplicative Decrease** — TCP congestion-control 패턴.
   - git-history capture가 wall-time이나 pack-bytes 예산 초과하면 `max_commits`를 multiplicatively 줄이고, 안정되면 additively 늘림.
6. **Maintenance locks** ✓ (file-based mutex on disk):
   ```
   maintenance.lock      — repack/migration 진행 중 다른 프로세스 진입 차단
   init.lock             — 초기화 1회만
   baseline.lock         — secondary-index-baseline 공유시 동기화
   baseline.marker       — baseline 존재 표시
   ```
   "Skipping maintenance: another process holds `maintenance.lock`" ✓
   → 여러 Cursor 인스턴스가 같은 워크스페이스를 열어도 안전.
7. **Geometric repack** ✓:
   ```
   Launching ... repack: ... packs in ...
   ODB refresh refused, duplicate packs kept
   Filtered ... oversized packs (>... bytes) from repack candidates
   applying extended repack cooldown to limit duplicate pack retention
   ```
   - gitoxide의 geometric packfile repack 알고리즘 사용.
   - oversized pack은 repack candidate에서 제외 (cost-bounded).
   - OTel: `codebase_snapshot.client.repack.{duration_ms,attempts,skipped_storage_budget_pause}`
8. **Blob store migration** ✓ (`crates/gix-snapshot/src/storage/blob_store.rs`):
   ```
   Migrating ... legacy loose objects to packfiles
   Skipping corrupt loose object ... during migration
   ```
   - 처음엔 loose object로 캡처, 백그라운드로 packfile로 정리.
9. **Secondary index** ✓ (`index/secondary.rs`):
   ```
   secondary index is corrupt; deleting and starting fresh
   Published shared baseline: ... entries, root_key=...
   Refreshed shared baseline: ...
   ```
   - 메인 gix-index 외 자체 보조 인덱스 (변경 패치 fast-apply용 ≈).
10. **File watcher** ✓ (`file_watcher.rs`):
    ```
    File watcher drain: event processing panicked, continuing loop
    File watcher event channel closed
    Failed to unwatch root during cleanup
    ```
    - `notify` crate ✓ 기반. Drain 스레드가 패닉해도 loop 유지 (resilience).
    - `Change buffer overflowed, clearing and forcing full scan` ✓ — 변경 폭주 시 full-scan fallback.

**유즈케이스**:
- Agent 턴 시작/끝마다 자동 캡처 → "이전 상태로 되돌리기"
- Agent가 만든 변경의 diff 표시
- `inEditorChangedFiles` — 사용자가 에디터에서 직접 만든 변경 vs agent 변경 구분
- `getBugbotRules` — `.cursor/BUGBOT.md` ✓ 위치한 규칙 파일 로딩

**근거** — 모든 strings ✓ verbatim.

**한계**:
- `commitAll`/`recordChanges`/`markVerified` 의 정확한 contract (semantics) 🔒
- secondary-index-baseline의 정확한 포맷 🔒

---

### §4.4 GitClient — gitoxide 직사용

**모듈**: 별도 crate가 아닌, `packages/file-service/src/lib.rs`에서 `gix-*` 직접 사용 (≈ — `GitClient` 전용 crate panic frame 미관측).

**설명**: **Pure-Rust in-process git**. 외부 `git` 바이너리에 shell out 안 함 (대비: §4.5 bugbot은 shell out). gitoxide 30+ 서브크레이트 ✓ 사용.

**동작** (✓ panic-frame + ✓ NAPI 메서드명에서 추출):

| 기능 | 근거 |
| --- | --- |
| HEAD/branch 디스커버리 | `Failed to get HEAD reference`, `Failed to peel to commit`, `<detached HEAD>` ✓ |
| Commit graph walk | `Failed to create revwalk`, `gix-commitgraph` 의존성 ✓ |
| Tree 구조 추출 | `getTreeStructure` ✓, `gix-object` |
| Commit-file status | `CommitFileStatus`, `M A D ?? ` (modified/added/deleted/untracked) ✓ |
| Diff lines | `diffLines` ✓, `gix-diff` |
| Packfile 생성 | `generatePackfile`, `generatePackfileV2`, `cleanupPackfile` ✓ |
| Git graph 시각화 데이터 | `GitGraph`, `Failed to create GitGraph` ✓ |

**Git config 의존 키들** (panic strings에서 leak):
```
branch.<name>.remote / .merge
remote.<name>.fetch / .push / .tagOpt
core.commitGraph  core.bigFileThreshold  protocolFromUser
logAllRefUpdates  ignoreSubmodules  shallow
```

**Reftable 미지원** ✓:
```
reftable ref backend is not supported (checked ...)
```
→ 일반 loose/packed-refs backend만.

**유즈케이스**:
- Cursor의 사이드바 git status, commit graph
- Agent의 git-aware tool (어떤 파일이 stash됐는지 등)
- Packfile 생성은 remote indexing 워크플로용 ≈

**근거** — NAPI export ✓ + gix-* 의존성 ✓ + panic-frame ✓. 단, 정확한 NAPI method 시그니처는 RTTI 군집이 흩어져 있어 ≈.

---

### §4.5 DiffClient + `crates/bugbot-util` — PR 코드리뷰 백엔드

**모듈**: `crates/bugbot-util/src/{cat_file,diff,lib,markdown}.rs`

**설명**: **Cursor의 BugBot (PR review feature) 로컬 컨텍스트 빌더**. PR base/head 두 commit 간 변경 파일 + 본문 + .cursor/BUGBOT.md 규칙을 수집해 LLM에게 보낼 페이로드를 만든다.

**놀라운 특징**: §4.4의 GitClient와 달리 **`git` 외부 바이너리에 shell out한다** ✓ — gitoxide 100%가 아니다.
```
Error when executing 'git':
Failed to execute git diff
Failed to execute git diff --name-only
Failed to execute git cat-file --batch
Failed to execute git check-attr
```
≈ 추정 이유: PR diff의 정확한 semantic (rename detection, submodule recursion, linguist attributes)을 stock `git`과 100% bit-exact 매치하기 위해. Reviewer 신뢰성 > 성능.

**동작** ✓:

1. **변경 파일 발견** (`bugbot_util::diff::find_changed_files`):
   ```
   git diff --name-status -M -z <base>..<head>
   git symbolic-ref --short refs/remotes/origin/HEAD
   → origin/main | origin/master | master (fallback chain)
   ```
2. **Untracked 파일 발견** (`find_untracked_files`):
   ```
   git ls-files --other --exclude-standard
   ```
3. **Blob 로딩 — 2-tier loader** ✓ (`crates/bugbot-util/src/cat_file.rs`):
   - **Primary**: `git cat-file --batch` (single subprocess, multiple blobs)
     - Stream parse: `expected 'blob' in git cat-file output; header: ...`, `Expected newline after file content`
   - **Fallback**: `git cat-file blob <SHA>` (per-blob subprocess, slower 하지만 robust)
     - `retrying git cat-file batch loader after read failure`
     - `falling back to direct git cat-file blob read`
   - 재시도 카운트: `maxRetries` ✓
   → Batch가 한 번 깨지면 (메모리 압박, pipe issue 등) per-blob으로 우아하게 degrade.
4. **Submodule 재귀** ✓:
   ```
   find_changed_files_in_submodule
   process_files_in_submodules
   submodule_count, submodule_path
   ```
   - regex: `(?m)^Submodule (.*?) contains modified content$|Submodule (.*?) ([a-f0-9]+)..[a-f0-9]+`
   - 서브모듈 별로 동일 알고리즘 재귀.
5. **Diff 본문 계산** ✓ (`calculate_git_diff_internal`):
   ```
   git diff -U<n> --no-color --src-prefix=a/ --dst-prefix=b/
            --ignore-submodules=all|none
   ```
   - context_lines (`-U`) NAPI 옵션으로 노출 ≈.
6. **Linguist 처리** ✓:
   ```
   git check-attr --stdin
   linguist-generated
   ```
   - `linguist-generated` 마킹된 파일은 diff에서 제외 (auto-generated 코드 noise filter).
7. **Aggregated metrics** ✓:
   ```
   aggregated_bugbot_rule_count
   aggregated_diff_bytes
   aggregated_file_count
   total_loaded_bytes
   untracked_diff_bytes
   ```
   - 전체 페이로드 size budgeting용.
8. **BUGBOT.md 규칙 파싱** ✓:
   ```
   .cursor/BUGBOT.md
   ```
   - 사용자가 PR 리뷰 시 어떤 규칙 강조할지 정의하는 markdown 파일.

**유즈케이스**:
- Cursor BugBot이 GitHub PR을 자동 리뷰할 때
- 로컬에서 `cursor review` 같은 커맨드 (≈ — 정확한 UI 트리거 미관측)

**근거** — 모든 git CLI invocation strings ✓ verbatim.

**한계**:
- DiffClient NAPI export method 시그니처 정확한 리스트 ≈
- BugbotContextIncludes의 정확한 schema 일부만 leak

---

### §4.6 LocalBugbotContext & 결과 타입

**모듈**: NAPI 레이어 (file-service)에서 returned by `CodebaseSnapshotClient.getBugbotRules` / `inEditorContext` 등.

**Schema** ✓:
```
LocalBugbotContext { ... }
BugbotContextIncludes {
  fileContentSource, submodules, bugbotRules, untracked
}
ChangedFilesIncludes { filterPaths, untracked, submodules }
InEditorSource { kind: workingTree | singleCommit, baseSha, headSha }
InEditorContentSource { context | ... }  ≈
```

**AdvanceResult** ✓ — `markVerifiedV2` / chain advancement 결과:
```
ok | already_at_or_past | not_on_chain | invariant_violation
```
- `already_at_or_past` — 이미 그 시점 또는 더 앞 (no-op)
- `not_on_chain` — 요청된 commit이 우리 snapshot chain 위에 없음
- `invariant_violation` — 내부 무결성 위반 (snapshot이 손상되었을 가능성)

**GeneratePackfileStatus** ✓ — packfile 생성 결과 enum. 정확한 variants 일부만 관측.

**Use cases**:
- agent → snapshot mark/verify advancing chain (snapshot이 일관성을 유지하는지 prove)
- bugbot이 LLM에 보낼 PR context 패키징

---

## §5. 통합 패턴 — 왜 단일 .node인가

다섯 모듈을 별도 .node로 나누지 않은 합리적 이유 추정 (≈, 근거는 strings 패턴):

### 5.1 Cross-crate 동기 갱신
✓ verbatim 근거: `cursor/crepe` ref가 `gix-snapshot`이 관리하는 mini-git repo의 일부 ≈. 한 commit이 끝나면 같은 프로세스에서 crepe의 incremental refresh가 호출되어 mmap된 posting list가 일관 (≈ — 코드 자체는 안 보이지만 데이터 흐름은 분명).

### 5.2 단일 OTel tracer
✓:
```
OtlpConfig { tracesEndpoint, ghostMode }
BatchSpanProcessor { span_sender, message_sender, handle,
                     forceflush_timeout, export_span_message_sent,
                     current_batch_size, dropped_spans_count }
SnapshotSampler { snapshot_ratio }
```
- 한 `BatchSpanProcessor`가 다섯 모듈의 span을 묶어 한 endpoint로 전송.
- `ghostMode` ≈ — telemetry 끌 수 있는 toggle (코드 위치 🔒).
- `SnapshotSampler.snapshot_ratio` — 샘플링 비율.
- OTel attribute 키들 ✓:
  ```
  code.file.path  code.module.name  code.line.number
  thread.name  thread.id  busy_ns  idle_ns
  codebase_snapshot.client.*  (storage_budget, repack, maintenance, dispose, snapshot, scan)
  gitoxide.in_parallel.*  (feed, produce.full_scan)
  ```

### 5.3 File watcher fanout
✓ `crates/codebase-snapshot/src/file_watcher.rs` 하나에서 notify 이벤트 drain. ≈ 추정: 이 drain 스레드가 (1) snapshot recordChanges와 (2) crepe pending docs queue 양쪽에 fan out. 두 .node 분리 시 같은 파일을 두 번 watch하게 됨 (kqueue/FSEvents 리소스 낭비, race condition).

### 5.4 단일 빌드 산출물 = 단일 배포 단위
GitHub Actions build path leak ✓ (`/Users/runner/work/everysphere/everysphere/_work/1/s/`) → monorepo + 단일 napi-rs target. 멀티-아키 (`darwin-universal`) cross-compile 부담을 한 번만.

---

## §6. 가장 놀라운 발견 3개

### 6.1 crepe는 ngram 역색인 grep — ripgrep 래퍼 아님

대부분 사람들은 Cursor의 grep을 "ripgrep을 부르는 거겠지"라고 생각하지만, **실제로는 자체 빌드된 ngram-색인 엔진**이다. ripgrep은 fallback ✓:
```
ripgrep/json.rs  ripgrep/util.rs  ripgrep-default-filter
native grep unavailable (...); falling back to text search fallback
```

진짜 엔진은 GitHub의 code search ([Russ Cox 식 trigram + posting list intersection](https://swtch.com/~rsc/regexp/regexp4.html) 계열 ≈)와 비슷한 아키텍처를 따른다. Sparse ngram 코덱 4종 ✓:
```
github-sparse-crc32      github-sparse-freq
github-sparse-freq-tiny  github-sparse-freq-inv
```
이 이름은 GitHub의 "[Blackbird](https://github.blog/engineering/the-technology-behind-githubs-new-code-search/)" code search 시스템의 코덱 이름과 유사 (≈ 추정 — Cursor가 GitHub의 알고리즘을 참고했거나 동일 학술 lineage).

**왜 중요한가**: `git grep` 또는 ripgrep으로 ~10만 파일 워크스페이스를 5초 안에 검색하기 어렵지만, 인덱스가 있으면 ms 단위. Cursor가 agent에게 빠른 `grep_search` 도구를 줄 수 있는 이유.

### 6.2 Cursor가 사용자 머신에 mini-git repo를 만든다

`refs/cursor/snapshots/{head,last-registered,last-verified}` ✓ — 이건 **사용자의 `.git/`이 아니라 별도 디렉터리에 있는 Cursor 전용 git repo**다. `snapshotsBaseDir` ✓ 옵션으로 위치를 정한다.

이 repo는:
- 사용자 워크스페이스 트리를 packfile로 캡처 (loose object → pack 자동 migration ✓)
- agent 턴 경계마다 자동 commit (`SnapshotReason::AgentRequestStart/End` ✓)
- AIMD 캡처 budget으로 storage 부담 조절 ✓
- Geometric repack으로 storage 압축 ✓
- File-based lock (maintenance.lock, init.lock, baseline.lock ✓)으로 multi-instance 안전

**왜 놀라운가**: "AI agent의 변경을 되돌릴 수 있게" 라는 UX 한 줄이 사실은 본격적인 git infrastructure 한 채를 사용자 디스크에 설치한다는 뜻. gitoxide 30+ crate를 정적 링크하는 비용을 감수했다.

### 6.3 BugBot은 gitoxide를 안 쓴다 — `git` 바이너리에 shell out

§4.4 GitClient는 gitoxide pure-Rust지만, §4.5 bugbot-util은 명시적으로 `git diff`, `git cat-file --batch`, `git check-attr --stdin`을 subprocess로 부른다 ✓. 더 흥미로운 건 **2-tier loader** ✓:

1. Primary: `git cat-file --batch` (효율적 — 한 프로세스로 N개 blob)
2. Fallback: `git cat-file blob <SHA>` per-blob (느리지만 안정)

배치가 실패하면 retry, retry도 실패하면 per-blob으로 우아하게 degrade. PR 리뷰는 사용자가 LLM에 의존하는 high-stakes 워크플로이기 때문에 **퍼포먼스보다 신뢰성** 우선. gitoxide의 gix-diff가 stock `git diff`와 1:1 매칭되지 않을 가능성을 회피.

---

## §7. quanta 흡수 시사 + 베끼면 안 되는 것

### 7.1 빌드 비용 reality check

이 .node 한 채를 흉내내려면:

| 의존 | 비용 |
| --- | --- |
| Rust toolchain | quanta는 현재 TypeScript only |
| napi-rs + node-api | C++ headers, Node-API ABI 안정성 관리 |
| 30+ gitoxide crate 정적 링크 | 빌드시간 ↑, 바이너리 30MB |
| macOS universal2 cross-compile | x86_64 + arm64 두 번 |
| Windows/Linux 분리 빌드 | OS별 .node 따로 |
| GitHub Actions runner matrix | CI 시간 × 6+ |

**결론**: 통째로 흡수는 비현실적. **기능별로 골라서** Rust 도입 없이 흡수.

### 7.2 베낄 만한 것 (pragmatic 대안 포함)

| Cursor 기능 | 흡수 ROI | quanta 대안 |
| --- | --- | --- |
| **ngram-인덱스 grep** (§4.2) | 🔥 매우 높음 | **SQLite FTS5** + trigram tokenizer (Rust 없이 구현 가능). 또는 [@vscode/ripgrep] + 사용자 워크스페이스만 인덱싱. |
| **Agent 턴 경계 snapshot** (§4.3) | 🔥 매우 높음 | `simple-git` Node 라이브러리로 packfile만 만들기. refs/cursor 같은 격리 namespace + storage budget. |
| **AIMD 캡처 budget** (§4.3-5) | 🔥 패턴 자체 | TCP-style multiplicative-decrease는 모든 background task에 적용 가능 (snapshot, indexing, embedding 업로드). |
| **2-tier git blob loader** (§4.5) | ⭐ 중간 | `simple-git`의 `catFile` + `child_process.spawn('git', ['cat-file', 'blob', sha])` fallback. |
| **PR-review용 git CLI shell-out** (§4.5) | ⭐ 중간 | gitoxide 같은 라이브러리 의존성 피하고 stock git 호환성 우선이 맞다. |
| **In-process git (gitoxide)** (§4.4) | ❌ 낮음 | `simple-git` (subprocess wrap)으로 충분. 우리 워크플로는 throughput-bound 아님. |
| **단일 OTel BatchSpanProcessor** (§5.2) | ⭐ 중간 | `@opentelemetry/sdk-node`로 동일 패턴. ghostMode toggle 흡수 가치 있음. |
| **`.cursorignore` 같은 별도 ignore** (§3) | ⭐ 중간 | quanta는 `.gitignore` 재사용해도 됨. 별도 파일 늘리지 말 것. |

### 7.3 베끼면 안 되는 것

- ❌ **단일 .node 통합**: quanta는 **multi-surface** (CLI / Web-Tauri / CLI-embedded browser). Cursor의 "VS Code extension host = 1 process" 가정과 충돌. quanta는 surface 간 wire protocol이 우선.
- ❌ **gitoxide 정적 링크**: 빌드 부담이 surface별로 N배.
- ❌ **사용자 디스크에 mini-git repo**: 일단은 **메모리 + JSONL 로그 + selective git stash** 조합으로 시작. 사용량이 mini-repo를 정당화할 때까지 보류.
- ❌ **Cursor의 BUGBOT.md path 컨벤션**: 우리는 `.quanta/` namespace를 우리 마음대로. Cursor의 `.cursor/BUGBOT.md` 위치를 따라하면 충돌.

### 7.4 즉시 가치 있는 흡수 후보 — 우선순위

1. **AIMD 패턴** (§4.3) — 어떤 background task에든 적용. 코드 ~50줄. **즉시 흡수**.
2. **2-tier git blob loader 회복성 패턴** (§4.5) — `simple-git` wrapper에 retry + fallback 추가. **즉시 흡수**.
3. **OTel `ghostMode` toggle** (§5.2) — telemetry 끌 수 있는 명시적 옵션. **즉시 흡수**.
4. **Snapshot reason taxonomy** (`Manual | AgentRequestStart | AgentRequestEnd`) — quanta의 향후 snapshot 기능에 동일 enum 채택. **즉시 흡수**.
5. **`AdvanceResult` enum 패턴** (`ok | already_at_or_past | not_on_chain | invariant_violation`) — chain advancement contract. quanta의 session/turn chain validation에 적용 가능. **즉시 흡수**.
6. **ngram 인덱스 grep** — SQLite FTS5 prototype부터. ROI 검증 후 본격 구현. **3-7일 spike**.
7. **Storage budget operational vs cleanup 2-tier** — disk-bound 모든 background task에 적용. **흡수**.

### 7.5 명시적 비흡수 결정

- gitoxide 30+ crate 정적 링크 → **거부** (빌드 부담)
- Rust + napi-rs 도입 → **거부 for now** (quanta는 TS-only로 유지)
- 단일 .node 통합 빌드 모델 → **거부** (multi-surface 충돌)

---

## §8. 라운드2 audit — 정정·신규 (3 병렬 검증 워커)

> 본문 초고 작성 후 3개 audit가 가져온 정정·신규. 마킹 ✓/≈/🔒 동일.

### 8.0 빌드 provenance ✓
- Cargo workspace 이름 **`everysphere`** (build host path `/Users/runner/work/everysphere/everysphere/_work/1/s/`) — Cursor 내부 monorepo 명. **GitHub Actions macOS runner**에서 빌드.
- **gitoxide = vendored fork**, 핀: `git checkouts/gitoxide-c5184609f4b57c0c/9e8bbba/...` — Anysphere가 gitoxide를 fork해서 commit `9e8bbba`에 핀(퍼블리시 crate 아님).
- Cursor-owned crate 풀세트(확장): `bugbot-util`, `codebase-snapshot`, `crepe`, `cursorignore`, **`git_graph`**, **`gix-snapshot`**, **`ignore`**(자체 fork), **`merkle_tree`** — 본문 §3엔 6개로 적었지만 **8개**.

### 8.1 crepe 추가 발견 (워커 B)
- **소스 파일 13개 풀세트**: lib.rs / index.rs / index_builder.rs / serialization.rs / disk_index.rs / query.rs / ngrams.rs / regex.rs / freq.rs / filter.rs / case_folding.rs / git/mod.rs / ripgrep/{util,json}.rs. **`spillable_index.rs`+`bin/crepectl.rs`**는 `crepectl` CLI에만 link (`.node` 아님).
- **인덱스 = mmap-resident** ✓ 결정적: verbatim `"ngram table extends beyond mmap bounds"`. 디스크 → mmap → 쿼리.
- **LSM-style segment chaining** ✓: 메타데이터 `parent_sha`/`has_parent`로 세그먼트 체인, `loading parent index for segment` (serialization.rs:966).
- **3개 독립 4 GB cap** ✓ (분리): postings 파일 / 단일 posting list / metadata offset. 각각 verbatim 에러.
- **Ancestor walk + main branch fallback** ✓: `"no candidate indexes found (best is N commits away)"` / `"main branch is N commits away; falling back to current commit"`. **인덱스가 commit SHA로 키잉**되어 가장 가까운 조상 commit 인덱스 재사용.
- **NAPI 옵션** 4개 추가: `maxIndexHoursSinceCreated`, `maxIndexHoursSinceAccessed`, `maxIndexRevisionDiff`, `maxInMemoryDocuments` on GrepClientOptions — staleness 임계.
- **crepectl CLI의 진짜 역할** ✓ 정정: 본문엔 "별도 헬퍼"라고 적었는데, audit 결과 **메모리 바운드된 build 전용 spillable indexer**. 디폴트 메모리 한도 = **시스템 RAM 25%**. 쿼리는 **항상 in-process** (mmap), CLI는 build만. `--memory-limit` flag.
- **Filter 모드 3종** ✓: `no-filter` / `hidden-file-filter` / `ripgrep-default-filter`.
- **Skip 사유 4종** ✓: `skip (glob_matcher)` / `skip (subpath)` / `skip (missing metadata)` / `skip (read error)`.
- **파일 이벤트 분류** ✓: `processing document M A D ??` — git status 그대로 (M=Modified / A=Added / D=Deleted / ??=Untracked).
- **4가지 sparse codec 의미** ≈: `crc32`(integrity) / `freq`(frequency-coded VB) / `freq-tiny`(small-block) / `freq-inv`(inverse-frequency). 정확한 layout 🔒.
- **ngram size 🔒** — 상수 strings 부재. ≈ inferred 3 (GitHub Blackbird 계보 + `literal query too short` 패턴).

### 8.2 gix-snapshot 추가 발견 (워커 C) — 실은 2개 crate
- **본문 정정**: gix-snapshot은 단일 crate가 아니라 **2개**:
  - `crates/gix-snapshot/` — 저수준 엔진 (gitoxide-based)
  - `crates/codebase-snapshot/` — 고수준 client/manager (storage budget, file watcher, AIMD, NAPI wrapper)
  - NAPI 글루: `packages/file-service/src/snapshot.rs`

#### 8.2.1 Shadow repo = 진짜 bare gitoxide repo ✓
- 경로 layout: `{snapshotsBaseDir}/{codebase_uuid}/`
- **bare git repo**: verbatim `[core] / repositoryformatversion = 0 / bare = true` 인라인 config + HEAD ref `ref: refs/heads/main`
- **synthetic author**: `git-native-history <capture@cursor.invalid>` — `cursor.invalid` 도메인으로 유출 방지 ★
- `objects/info` / `hooks` 디렉토리 (정통 git)
- Legacy `snapshots/`→`.snapshots-migrate-…` 마이그레이션 ✓
- NAPI 옵션: `snapshotsBaseDir`, init은 `codebase_uuid`+`base_dir` 필수

#### 8.2.2 SnapshotMetadataWire 4 필드 ✓
verbatim `struct SnapshotMetadataWire with 4 elements` + 필드명 `ignoreBlobId` + `latencySeconds` + `SnapshotReason`(internally tagged). 4번째 ≈ `version` 또는 `agent_request_id`.

#### 8.2.3 Storage budget — operational vs cleanup ✓
- **Operational** (pause): "Snapshot storage exceeds operational budget; pausing operations"
- **Cleanup** (wipe): "Snapshot storage exceeds cleanup budget, wiping to reclaim space" — **전체 폴더 wipe** (LRU 아님). Re-init from scratch.
- OTel: `storage_budget.operational_exceeded` / `.cleanup` / `.usage_ratio` / `.check_error`
- 백그라운드 모니터 thread: `storage-budget-monitor`
- 임계 ratio 🔒 (compiled constant)

#### 8.2.4 3 locks + worker pool ✓
- `maintenance.lock` / `init.lock` / `baseline.lock` — 전부 on-disk file-level → **multi-process safe** ★. Cursor 창 여러 개 동시 OK.
- Worker lane state machine: `{Running → TimedOut → Backoff}`. Soft timeout 안 죽임, lane만 stale 마킹.

#### 8.2.5 Geometric repack — 2 kind ✓
- 2종: **`shadow_repack`** + **`blob_repack`**
- Trigger: `"Launching {kind} repack: N packs in Ms"`
- Skip: `"Skipping geometric repack: storage budget pause flag set"`, `"applying extended repack cooldown to limit duplicate pack retention"`
- 입력 pack 크기 cap: `"Filtered N oversized packs (> bytes) from repack candidates"` — 큰 pack은 안 건드림
- 기하 ratio 🔒

#### 8.2.6 BlobStore = legacy loose→pack 마이그레이션 ✓
시작 시: `"Migrating N legacy loose objects to packfiles"`. 비-blob skip, corrupt skip. 원자 쓰기: `NamedTempFile` + `PackWriter dropped without finish()` (abort path).

#### 8.2.7 4-phase write (실은 5 sub-span) ✓
1. `snapshot_writer.plan` — 변경 path gather (secondary index diff)
2. `snapshot_writer.ingest` — blob 읽기+패킹
3. `snapshot_writer.commit.build_tree` — tree 업서트 (**incremental by default**, full fallback)
4. `snapshot_writer.commit.create_commit` — snapshot commit 생성
5. `snapshot_writer.commit.finalize_index` — secondary index + ref 이동

verbatim 요약: `"Snapshot created in N ms: commit=, reused=, written=, skipped=, removed=, tree= (removals=, upserts=), index_written="`

#### 8.2.8 4 worker class ✓
**scan / diff / discover / ingest** (gitoxide `in_parallel`). panic harness가 `gix-snapshot-{worker_kind}` thread name으로 격리.

#### 8.2.9 Cross-process shared baseline ✓
- 파일: `baseline.marker` + `secondary-index-baseline`
- Pub: `"Published shared baseline: N entries, root_key=..."`
- Adopt 시: warm restart (`"running warm restart"`), 실패 시 full init (`"falling back to full init"`)
- 조건: `ignore_config_hash` 매칭 필요 (불일치 → `"Skipping baseline refresh: config mismatch"`)
- **여러 Cursor 프로세스/창이 한 워크스페이스 빠르게 공유** ★

#### 8.2.10 AIMD capture budget — 별도 파이프라인 ★
- **본문 정정**: AIMD는 *snapshot 엔진*과 별개. 사용자의 *진짜 .git* 히스토리를 슬라이스 떠서 packfile 업로드 (`cursor.codebaseTelemetry.triggerGitHistoryCapture` 명령 백엔드).
- NAPI 구조 `CaptureBudget` 5필드: `maxCommits` / `maxWallTimeMs` / `maxPackBytes` / `targetDurationMs` / `consecutiveOverBudget`
- 로직 ≈: under budget → additive increase `maxCommits`; over → counter++ → 임계 시 multiplicative decrease
- 캡처 stage 4단: `RefStore → CommitPack → TreePack → BlobPack` (`GitHistoryStage` ✓)
- DeferredBlobReason 5종: `StageCeiling` / `ExceedsSizeLimit` / `MissingInSource` / `ModeOnlyChange` / `PreimageNotRequested`

#### 8.2.11 Time-travel API ✓ 정정
- **`getBfsPaths`** (plural, 본문엔 `getBfsPath` 잘못) — Breadth-First-Search paths. `gix-traverse/src/tree/breadthfirst.rs` 사용.
- `inEditorChangedFiles` / `inEditorContext` — shadow-repo HEAD vs 워킹트리 diff
- `disposeFast` vs `dispose`: fast는 OTel detach (background drain), 일반은 flush 완료까지 block

#### 8.2.12 Chain walk 안전장치 ✓
- `"Chain walk exceeded depth limit: walked N commits"` — 무한루프/손상 ref 방어
- **first-parent chain 엄격** ✓: `markRegistered`/`markVerified` 시 strict linear chain. 위반 시 `AdvanceResult::NotOnChain`/`InvariantViolation`.
- `AdvanceResult` 4 variant: `Advanced` / `AlreadyAtOrPast` / `NotOnChain` / `InvariantViolation`

#### 8.2.13 GeneratePackfileStatus ✓
5 variant: `Ready / NoWork / TooManyPending / Corrupt / IoError` — 외부 cloud upload 사전체크.

### 8.3 GitClient — 큰 정정 ★ (워커 D)
**본문은 GitClient를 "generic git facade"로 묘사했는데 audit 결과 NO.** 실제 NAPI 메서드:
```
getCommitChain · getCommitVerifyData · getRepoHeadSha ·
getTotalCommitCount · getVerifyCommit · throwIfCommitDoesntExist
```
→ **commit-verification + chain-walking 전용**. 시그니처 검증·체인 enumeration. `getBfsPath` 같은 거 *없음* (그건 `CodebaseSnapshotClient`).

호출자 분리: **bugbot-util은 `git` 셸**(NOT gix). **GitClient는 gix 직접**. 같은 바이너리 내 *2개 git 경로* 공존 — 의도적 분리.

### 8.4 DiffClient — imara-diff Myers+Histogram ✓
- 알고리즘: **imara-diff 0.1.8** (gix-diff의 엔진)
- Myers AND Histogram 둘 다 구현
- **Patience 명시적 미구현** ✓ verbatim: `"'patience' diff is not implemented and can default to 'histogram' if lenient config is used, and defaults to histogram if unset for fastest and best results"`
- Rename detection: `core.renames`/`renameLimit` 존중, `"renameLimit ... actually squared, so 1000 stands for up to 1 million diffs"`

### 8.5 bugbot-util — 큰 정정 ★
- **본문 정정**: gitoxide 쓰는 게 아니라 **`git` 바이너리 셸 호출**. CLI args 인벤토리:
  ```
  diff -U<N> --no-color --src-prefix=a/ --dst-prefix=b/
       --ignore-submodules={all,none} --name-status -M -z
       --find-renames --diff-filter=RAMD --first-parent
  cat-file --batch / cat-file blob <SHA>
  check-attr --stdin     (linguist-generated 체크)
  ls-files --other --exclude-standard
  config --get-regexp / merge-base / rev-parse / symbolic-ref --short
  ```
- **`.cursor/BUGBOT.md`** ✓ — bugbot 룰 매니페스트 파일.
- NAPI 클래스: **`LocalBugbotContext`**. 메서드 `getBugbotRules` / `inEditorChangedFiles` / `inEditorContext`.
- TS enum: `InEditorSourceKind` = `workingTree | singleCommit`
- "Agent Review" = bugbot 유저-페이싱 이름. 같은 파이프라인.
- 호출 계층 (line numbers verbatim): `gather:492` → `gather_changed_files:1243` → `{find_changed_files:1048, find_untracked_files:1089, find_changed_files_in_submodule:794}` → `{process_files_in_repo:688, process_files_in_submodules:373, gather_context_for_untracked_files:312}` → `calculate_git_diff_internal:638` → aggregated rollup
- Submodule regex verbatim: `(?m)^Submodule (.*?) contains modified content$|Submodule (.*?) ([a-f0-9]+)..[a-f0-9]+`

### 8.6 Hash 알고리즘 — 결정적 (워커 D)
- **SHA-1만** ✓: verbatim `"gix::ObjectId should always be 20 bytes"` + `" is not a lowercase 40-hex SHA-1"`
- **`sha1-checked` 스타일** ✓: verbatim `"Detected SHA-1 collision attack with digest"` — SHAttered-class 공격 방어.
- **SHA-256 git repo** ✓: variant 있지만 verbatim `"Support for SHA256 is prepared but not fully implemented yet. For now we abort when encountered"` — **만나면 abort**. 실용상 미지원.
- **xxhash / blake3 / blake2 / siphash / farmhash / cityhash / murmur / wyhash / metro / t1ha / twox-hash / ahash 모두 부재** ✓ — 전 binary scan 0 hit.
- `filebuf_hash` 토큰 ≈ 파일 버퍼 SHA-1 추정.
- Tree-node 결합 해시 ≈ 자식 해시 concat SHA-1 (verbatim `"Updated branch hashes"` + `"<root>"` sentinel).

### 8.7 simhash — 실제론 거의 black box 🔒
- 본문에서 `≈ Charikar 64-bit`라고 추정했는데, audit 결과 strings에 **dimension/algorithm 흔적 0**:
  - ❌ `Datasketches` / `charikar` / `hamming` / `LSH` 부재
  - ❌ 인접 numeric constant `64/128/256` 부재
  - ❌ `f32`/`f64` 컨텍스트 부재
- verbatim만: `"SimHash for"` / `"failed to compute SimHash for tree:"` / `"Error in get_subtree_hash"` / NAPI `getSimhash`
- 호출 context 2곳: per-tree (NAPI) + `git_history::capture` (역사 트리 simhash)
- → **본문 §4.1 MerkleClient의 simhash 단락은 🔒 강화 표기 필요** (Charikar 추정은 너무 강했음)

### 8.8 Ignore layer — 5단 ✓ (본문보다 1단 더)
실제 우선순위 (위→아래):
1. `globalCursorIgnorePatterns` (user/global)
2. `unifiedJsonBlocklistPath` (admin policy, JSON)
3. `blocklistPath` (admin policy, legacy plain)
4. `.cursorindexingignore` (repo, indexing-specific)
5. `.cursorignore` (repo, general)
6. `.gitignore` 계층 (standard `ignore` Rust crate)

**ignore 파일 변경 → 풀 rebuild 강제** ✓: `"cannot perform incremental update on an ignore file (root hash cannot be None) → Starting full rebuild for roots:"`

본문에서 `ignore_config_hash` 키워드 언급했는데 **binary에 부재** ✓ — 본문 §4.1 해당 줄 ⚠️ 삭제 권장.

### 8.9 종합 — 본문에서 고쳐야 할 12 항목
| 항목 | 본문 (틀린/약한) | audit 정정 |
|---|---|---|
| GitClient 역할 | "generic git facade" | **commit-verification 전용** (6 메서드) |
| `getBfsPath` 위치/이름 | (모호) | **`getBfsPaths`(plural)**, CodebaseSnapshotClient 소유, BFS over tree |
| gix-snapshot crate 수 | 1개 | **2개** (gix-snapshot + codebase-snapshot) |
| simhash 차원/알고리즘 | "≈ Charikar 64-bit" | 🔒 (증거 부재) |
| `ignore_config_hash` 키워드 | 언급 | **binary 부재**, 삭제 |
| crepectl 역할 | "별도 helper" | **메모리바운드 build 전용 spillable**, 쿼리 안 함 |
| bugbot-util git 호출 방식 | (모호) | **셸 `git` 바이너리** (NOT gix) |
| 인덱스 storage | "디스크 영속" | **mmap-resident**, 3개 4GB cap, LSM chain |
| ignore layer 단수 | 4단 | **5단** (unifiedJson + legacy 분리) |
| `disposeFast` vs `dispose` | (없음) | fast = OTel detach, full = flush block |
| AIMD 범위 | "snapshot 엔진" | **별도 파이프라인** (사용자 .git 캡처용) |
| Cursor-owned crate 수 | 6개 | **8개** (+`git_graph`, `ignore`, `merkle_tree`) |

---

## Appendix: ✓ verbatim vs ≈ inferred 요약

| Section | ✓ 비중 | ≈/🔒 부분 |
| --- | --- | --- |
| §0 file path, arch, language | 100% ✓ | — |
| §1 통합 모델 | 50% ✓ | 통합 이유 자체는 ≈ |
| §2 NAPI 인벤토리 | 95% ✓ | DiffClient methods ≈ |
| §3 crate workspace | 90% ✓ | 일부 .rs 파일 경로 🔒 |
| §4.1 MerkleClient | 60% ✓ | 알고리즘 디테일 🔒 |
| §4.2 GrepClient (crepe) | 95% ✓ | ngram N값, 압축 상세 🔒 |
| §4.3 CodebaseSnapshotClient | 95% ✓ | secondary-index 포맷 🔒 |
| §4.4 GitClient | 70% ✓ | 정확한 method 시그니처 ≈ |
| §4.5 DiffClient + bugbot | 95% ✓ | DiffClient NAPI export ≈ |
| §4.6 결과 타입 | 90% ✓ | GeneratePackfileStatus variants 일부 🔒 |
| §5 통합 패턴 | 60% ✓ | 통합 이유 ≈ |
| §6 놀라운 발견 | 95% ✓ | "왜"는 ≈ |
| §7 흡수 시사 | quanta 측 ✓ (우리 자료) | — |

**전체적으로**: 핵심 사실(refs/cursor/snapshots, AIMD, 2-tier loader, sparse-ngram 코덱, gitoxide 사용, NAPI 클래스명/메서드명)은 strings에서 verbatim ✓. 통합 이유와 일부 알고리즘 내부 디테일은 ≈/🔒. **추측으로 분량 채우지 않음** — 모르는 건 명시.

---

*End of document.*
