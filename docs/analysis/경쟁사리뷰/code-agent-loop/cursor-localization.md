# Cursor 3.2.16 — 코드 로컬라이제이션 파이프라인 (청킹·tree-sitter·프롬프트까지)

> 사용자가 묻는 질문에 대한 **검증된** 답: "Cursor는 코드 로컬라이제이션을 어떻게 하나? LSP? 자체 tree-sitter? 그냥 전체?" — 셋 다 부분적으로 맞지만 가장 큰 발견은 **tree-sitter도 LSP도 클라 retrieval에서 안 쓴다는 것**. 클라는 Merkle+simhash+grep만 하고, **청킹·심볼·임베딩·LspSubgraphChunk까지 전부 서버**. 동봉된 tree-sitter wasm 4개(css/typescript/ini/regex)는 *에디터 syntax highlighting 전용*. 마킹: ✓ verbatim 확인 · ≈ 의미 추론 · 🔒 서버측 미관측.

---

## 0. 증거 파일

| 약어 | 경로 |
|---|---|
| `RETRIEVAL` | `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-retrieval/dist/main.js` (4.03 MB, minified) |
| `RETRIEVAL_WORKER` | `…/extensions/cursor-retrieval/worker/dist/main.js` (230 KB, thin RPC stub) |
| `FILESVC_NAPI` | `…/extensions/cursor-retrieval/node_modules/@anysphere/file-service/file_service.darwin-universal.node` (Rust; exports `MerkleClient/GrepClient/CodebaseSnapshotClient/GitClient/DiffClient/...`) |
| `CREPECTL` | `/Applications/Cursor.app/Contents/Resources/app/resources/helpers/crepectl` (Rust ripgrep-derived 로컬 데몬) |
| `IDE` | `…/out/vs/workbench/workbench.desktop.main.js` (50.2 MB, ContextItem/StreamUnifiedChatRequest/chat UI) |
| `TS_WASM` | `…/node_modules/@vscode/tree-sitter-wasm/wasm/` (VS Code core용; css/typescript/ini/regex 4개만) |
| `WS_STATE` | `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/anysphere.cursor-retrieval/` |

---

## 1. 큰 정정: tree-sitter는 클라에서 안 돌린다 ✓

### 1.1 동봉된 tree-sitter wasm은 *에디터 highlighting 전용*
`TS_WASM`에는 `tree-sitter.wasm`(런타임) + `tree-sitter-{css,typescript,ini,regex}.wasm` **4개뿐**. Python/Go/Rust/Java 등 통상의 코드언어 grammar 0개. 로더는 IDE의 `K7b._getTreeSitterImport()`(`g0s="editor.experimental.preferTreeSitter"`)로, VS Code core syntax highlighting이 쓴다. **`RETRIEVAL`에서 wasm/tree-sitter 모듈 참조 0회.** ✓

### 1.2 `treesitter.*` 3개 호출은 실은 서버 RPC ✓
```js
// RETRIEVAL 내부
const sa = {
  GetReferencedSymbols:         "treesitter.getReferencedSymbols",
  GetDefinedSymbols:            "treesitter.getDefinedSymbols",
  GetImportantDefinitionNames:  "treesitter.getImportantDefinitionNames"
};
const n = async (e, t) => {
  const commandId = e.split(".").slice(1).join(".");
  const r = this.getAIClient();
  return await r?.isolatedTreesitter({
    commandId, fileContent: t.fileContent, languageId: t.languageId
  });
};
```
proto `aiserver.v1.IsolatedTreesitterRequest{file_content, language_id, command_id}` → `IsolatedTreesitterResponse{items:TreesitterSymbolNameItem[]}`.
`TreesitterSymbolNameItem{symbol_name, start_position, end_position}` — **flat 심볼명+좌표**만, kind/scope/type 없음. 서버가 파싱해서 평탄한 배열로 돌려줌. ✓

### 1.3 클라 chunker는 없다 ✓
- `Rechunker` = enum `aiserver.v1.RechunkerChoice{UNSPECIFIED, IDENTITY, 600_TOKS, 2400_TOKS, 4000_TOKS}` — **서버 선택지를 클라가 그냥 패스**.
- `chunkFile`, `Chunker`(클래스), `splitIntoChunks` 검색 **0건**.
- `getAvailableChunkingStrategies` RPC로 서버가 어떤 chunking 옵션을 지원하는지 받아옴.
- `.scm` tree-sitter 쿼리 파일도 0개 동봉 (`find … -name '*.scm'` 빈 결과).
- `Symbol*`류 클래스들(`SymbolKind/Type/Range/Match/Dependencies/Link/Action/With/...`)은 **`SEARCH_SYMBOLS` 도구** + `TreesitterSymbolNameItem`용 proto, retrieval chunker 아님. ✓

### 1.4 LSP도 retrieval에서 안 쓴다 ✓
`vscode.execute{Workspace,Document}SymbolProvider`, `executeDefinitionProvider`, `executeReferencesProvider` 등 LSP 명령 — **`RETRIEVAL`에 0건**. `lsp_subgraph_chunk`는 ContextItem 변종(서버 결과) ≈ 서버가 자체 corpus + IsolatedTreesitter로 만들어 보냄.

LSP가 IDE에서 쓰이는 곳은 별개:
- `linter_errors`/`multi_file_linter_errors` (StreamUnifiedChatRequest field 6/14) — VS Code `MarkerService`에서 수집
- `go_to_definition` 도구 호출 시 `executeDefinitionProvider` (도구 경로, retrieval 아님)

---

## 2. 실제 아키텍처 — 클라가 *실제로 하는 일* 5가지

**전부 합쳐 이게 다다:**

1. **Merkle 파일트리 빌드** (`FILESVC_NAPI` Rust binding)
   - `merkleClient.build({incremental, maxNumFiles, blocklistPath, unifiedJsonBlocklistPath, globalCursorIgnorePatterns, logFilePath})`
   - 파일 해시 트리; subtree 단위 비교용
2. **simhash 계산** — `merkleClient.getSimhash()` → float 벡터
   - "다른 사용자가 이미 인덱싱한 같은 코드베이스인가" 서버 판정용 (`do_copy:true` 트리거)
3. **`crepectl` 로컬 grep 데몬 띄움 + 인덱싱**
   - 자체 file watcher, in-memory 인덱스, ripgrep-derived
   - `grep_search` / `ripgrep_search` / `glob_file_search` 도구 백엔드
   - retrieval/임베딩 *완전 무관*, 순수 on-demand grep
4. **FS watcher 2개** (둘 다 `**` glob — 모든 파일)
   - merkle용: `merkleClient.onDidCreate/Change/Delete`
   - GrepClient용: `crepectl.onDidCreate/Change/Delete`
5. **턴마다 *통째* 파일을 prompt 봉투에 담아 서버에 올림**
   - @-멘션 / 보이는 / AI-편집한 / 컴포저 파일은 **전체** 파일 전송 (chunk 아님)
   - 현재 파일은 `truncateCurrentFile(contents, cursorLine, EOL, uri)`로 커서 근처만

**서버가 다 한다 🔒:**
- 청킹 (`RechunkerChoice` 옵션 선택)
- 임베딩 (`TEXT_EMBEDDINGS_LARGE_3` 등)
- 벡터 스토어
- tree-sitter 심볼 추출 (`IsolatedTreesitter`)
- `ContextItem` 분류 선택 (FileChunk / OutlineChunk / SparseFileChunk / LspSubgraphChunk / Lints / …)
- Outline / 의존 그래프

**클라 디스크 상태** (`WS_STATE`):
- `embeddable_files.txt` — 인덱싱 대상 파일 라인-per-청크 (디버그/감사 로그)
- `high_level_folder_description.txt` — 서버 생성 워크스페이스 요약 (`merkleClient.getImportantPaths(100)`이 input)
- **SQLite/벡터/embedding 캐시 0** — 임베딩은 100% 서버

---

## 3. `cursor-retrieval` 확장 — 컴포넌트 매핑

### 3.1 `RepoIndexWatcher` (`sFe`) — incremental 인덱스 폴러
```js
if (n.incremental) {
  const e = ca.workspace.createFileSystemWatcher("**");
  e.onDidChange(e => this.merkleClient.onDidChange(e.fsPath));
  e.onDidCreate(...);
  e.onDidDelete(...);
}
setInterval(doUpdate, max(indexingConfig.indexingPeriodSeconds, 60) * 1000);
// 최소 60초 주기, 시작 시 즉시 1회
```
타임아웃: `HANDSHAKE_TIMEOUT_MS=1_800_000` (30분), `SYNC_MERKLE_TIMEOUT_MS=1_800_000`, `SYNC_DELETES_TIMEOUT_MS=180_000` (3분). ✓

### 3.2 `MerkleClient` (`FILESVC_NAPI`) — Rust NAPI
`merkleClient.{build, getSubtreeHash, getNumEmbeddableFiles, getSimhash, getImportantPaths, onDidChange/Create/Delete}`. 메모리 보관, on-disk 영속 경로 미관측. ≈

### 3.3 `GrepClient` (`FILESVC_NAPI`) — 별도 Rust NAPI
```js
grepClient.{query(roots, pattern, {literal, caseInsensitive}),
            warmup(roots),
            getTrackedState(roots),
            onDidChange/Create/Delete}
```
- 자체 file watcher (merkle와 *별개* 구독)
- `warmup`이 있으니 in-memory 인덱스 ≈
- 결과 shape (로그 포맷에서): `{<pattern>: {byFile:[{file,matches}], totalLines, totalMatchedLines, truncated}}`
- `cursor.grepClient.debug` 디버그 명령 (dev mode quick-pick: TrackedState/Warmup/Search)

### 3.4 `AiClient` — gRPC stub (`RETRIEVAL`+`IDE`)
138개 RPC; 로컬라이제이션 관련 핵심만:
- **RepositoryService**: `fastRepoInitHandshake(V2)`, `syncMerkleSubtree(V2)`, `fastUpdateFile(V2)`, `searchRepositoryV2`, `removeRepositoryV2`, `fastRepoSyncComplete`, `semSearchFast`(stream), `semSearch`(stream), `ensureIndexCreated`, `getHighLevelFolderDescription`, `getEmbeddings`, `getUploadLimits`, `getNumFilesToSend`, `getAvailableChunkingStrategies`, `getLineNumberClassifications`(stream), `getCopyStatus`
- **CodebaseSnapshotService**: `registerCodebase`, `registerCodebaseSnapshot`, `getCodebaseSnapshotStatus`, `createPackfileUpload`, `completePackfileUpload`, `uploadPackfileChunk`
- **AiService (one-off)**: `isolatedTreesitter`, `bulkEmbed`, `rerankResults`, `chooseCodeReferences`, `extractPaths`, `summarizeWithReferences`, `documentationQuery`, `streamPotentialLocs(Underneath/InitialQueries)`, `getContextScores`, `checkLongFilesFit`, `streamChat{Deep,}Context`, `taskStreamChatContext`
- **ChatService**: `streamUnifiedChat{,WithTools[SSE/Poll/Idempotent…]}`, `getConversationSummary` (BiDi/SSE/Poll 변종)

### 3.5 `RETRIEVAL_WORKER`
230 KB thin stub — tree-sitter/chunking 참조 0개. RPC 위임 워커.

---

## 4. `crepectl` — 로컬 grep 데몬 (retrieval과 분리)

### 4.1 Spawn (`RETRIEVAL` _getCrepectlPath)
```js
const t = "crepectl" + (win ? ".exe" : "");
const n = path.join(appRoot, "resources", "helpers", t);                  // prod
const r = path.join(appRoot, "..", "packages", "crepectl", "bin", t);     // dev
// 없으면: "crepectl binary not found in production build; disabling grep service"
```

### 4.2 역할
- 도구 `RIPGREP_SEARCH`(#3) / `RIPGREP_RAW_SEARCH`(#41) / `GLOB_FILE_SEARCH`(#42) 백엔드
- **인덱싱·임베딩 무관** — 순수 on-demand 검색
- `getTrackedState(roots)`로 git branch/root 정보 제공 (handshake 메타)
- ripgrep-derived (aho-corasick + regex-automata + gitoxide)

---

## 5. 인덱싱 파이프라인 — simhash dedup + Merkle 증분 (꼼꼼하게)

### 5.0 검증된 상수 매트릭스 (모두 ✓ verbatim)
| 상수 | 값 | 의미 |
|---|---|---|
| `HANDSHAKE_TIMEOUT_MS = 18e5` | **1,800,000 ms = 30 min** | 핸드셰이크 hard timeout |
| `SYNC_MERKLE_TIMEOUT_MS = 18e5` | **30 min** | subtree sync walk hard timeout |
| `SYNC_DELETES_TIMEOUT_MS = 18e4` | **180,000 ms = 3 min** | deletes-only sync hard timeout |
| `BATCH_SIZE = 5e3` | **5,000** | sync subtree 배치 크기 |
| `FLUSH_BATCH_SIZE = 5e3` | **5,000** | 업로드 flush 임계 |
| `indexingPeriodSeconds : 600` (default), floored `Math.max(period, 60)` | **default 10분 / 최소 1분** | doUpdate 폴링 주기 |
| `copyStatusCheckPeriodSeconds : 1` | **1 초** | `GetCopyStatus` 폴링 주기 (서버 카피 진행 중) |
| `absoluteMaxNumberFiles : 1e5` | **100,000** | 인덱싱 hard cap (초과 시 인덱싱 자체 거부) |
| `autoIndexingMaxNumFiles : 1e4` | **10,000** | 자동 인덱싱 임계 (초과 시 `"not-auto-indexing"`, 수동 트리거만) |
| `maxRetries : a ?? 5` | **default 5** | handshake/sync 재시도 횟수 |
| 상태 enum 문자열 | `aborted, busy, cancelled, completed, disabled, failed, indexing, not-auto-indexing, paused, ready` | `RepoIndexWatcher.status`/`indexingStatus` |

### 5.1 wire types (참조용)
```
FastRepoInitHandshakeV2Request {
  repository, root_hash, similarity_metric_type, similarity_metric[],
  path_key_hash, path_key_hash_type, do_copy, path_key,
  local_codebase_root_info, return_after_background_copy_started
}
SyncMerkleSubtreeV2Request {
  client_repository_info, codebase_id,
  local_partial_path: PartialPath,           // single
  local_partial_paths: PartialPath[]         // batched
}
SyncMerkleSubtreeV2Response {
  oneof result { match:bool | mismatch:{children:PartialPath[]} }
  results[]: per-path results
}
FastUpdateFileV2Request {
  client_repository_info, codebase_id,
  directory | local_file,                    // oneof partial_path
  ancestor_spline: PartialPath[],            // path proof
  update_type: ADD|DELETE|MODIFY|BATCH,
  file_updates: FileUpdate[]                 // batched
}
LocalFile { file, hash, unencrypted_relative_workspace_path }
```

`MerkleClient` Rust NAPI 메서드 풀세트 (verbatim from `.node` 바이너리):
`build · dispose · getAllDirFilesToEmbed · getAllFiles · getImportantPaths · getNumEmbeddableFiles · getSimhash · getSubtreeHash · onDidChange · onDidCreate · onDidDelete`

`GrepClient` 메서드: `getTrackedState · getWorkspaceStatuses · offTrackedStateInvalidated · onTrackedStateInvalidated · query · queryWithCallback · warmup`. **별개 인스턴스, 별개 watcher**.

`CodebaseSnapshotClient` 메서드: `getBugbotRules · inEditorChangedFiles · inEditorContext · addCodebase · disposeFast · removeCodebase · updateCursorAuthToken · commitAll · recordChanges · getBfsPath · markRegistered · markVerified · markVerifiedV2`. — packfile 경로용 별도 클라이언트.

---

### 5A. 최초 인덱싱 (cold start) — 새 워크스페이스 첫 열기

```
[VS Code activate]
       │
       ▼
RepoIndexWatcher 생성 (cursor-retrieval/dist/main.js sFe)
   ├── createFileSystemWatcher("**")  ← 즉시 등록 (모든 파일 감시)
   │     onDidChange/Create/Delete → merkleClient.onDidChange/Create/Delete
   ├── GrepClient watcher 별도 구독 (crepectl용 — merkle와 무관)
   └── setInterval(doUpdate, max(indexingPeriodSeconds:600, 60)*1000)
       │
       ▼ 첫 doUpdate() 즉시 호출 (대기 없이)
   ┌──────────────────────────────────────────────────────────┐
   │ Step 1. 사전 검증                                         │
   │   • workspaceUris 안에 os.homedir() 있으면 즉시 abort     │
   │     → "We currently do not allow indexing the home directory."│
   │     → status = "disabled" (혹은 "home-directory")        │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 2. constructMerkleTree (Rust NAPI 호출, 동기 차단)   │
   │   merkleClient.build({                                    │
   │     incremental: false,        ← 첫 호출은 false (=풀빌드)│
   │     maxNumFiles: absoluteMaxNumberFiles (=1e5),           │
   │     blocklistPath: adminBlocklist?,                       │
   │     unifiedJsonBlocklistPath: adminJsonBlocklist?,        │
   │     globalCursorIgnorePatterns:                           │
   │       cursor.general.globalCursorIgnoreList.join("\n"),   │
   │     logFilePath: <workspaceStorage>/anysphere.cursor-     │
   │                  retrieval/embeddable_files.txt           │
   │       (먼저 truncate: writeFile(path, new Uint8Array()))   │
   │   })                                                      │
   │   Rust 내부:                                              │
   │     • workspace 트리 walk, .gitignore + 4-layer ignore   │
   │     • 각 파일 해시 (xxhash/blake/sha 중 하나, 정확히는 미관측)│
   │     • Merkle subtree 계산 → in-memory 보관 (디스크 영속 X) │
   │     • embeddable_files.txt에 인덱싱 대상 라인 누적         │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 3. 파일 수 게이트                                    │
   │   const num = await merkleClient.getNumEmbeddableFiles()  │
   │   if (num > absoluteMaxNumberFiles=1e5):                 │
   │       status="disabled" ("too-many-files"), 종료         │
   │   if (num > autoIndexingMaxNumFiles=1e4):                │
   │       status="not-auto-indexing"                          │
   │       → 사용자가 cursor.indexer.incremental 수동 트리거   │
   │         할 때까지 sync 안 함                              │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 4. simhash + subtreeHash + pathKey 계산              │
   │   const rootHash = await merkleClient.getSubtreeHash(".") │
   │   const simhash  = await merkleClient.getSimhash()        │
   │     → Float vector. workspace leaf 해시들에서 계산        │
   │       (정확한 차원/알고리즘은 Rust 내부, ≈ SimHash 변종)  │
   │   const pathKeyHash = sha256(pathEncryptionKey)           │
   │     (privacy mode off일 때만 실제 키 전송)                │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 5. FastRepoInitHandshakeV2 송신 (30분 timeout)       │
   │   await repoClient.handshakeWithRetry({                   │
   │     repository: {...repoInfo.export(),                    │
   │                  isLocal:true, numFiles:num,              │
   │                  remoteNames, remoteUrls, workspaceUri},  │
   │     rootHash,                                             │
   │     similarityMetricType: SIMHASH,                        │
   │     similarityMetric: Array.from(simhash),                │
   │     pathKeyHash,                                          │
   │     pathKeyHashType: SHA256,                              │
   │     doCopy: true,           ← ★ "기존 인덱스 재활용 허용" │
   │     pathKey: privacyMode==0 ? pathEncryptionKey : "",     │
   │     localCodebaseRootInfo, returnAfterBackgroundCopyStarted│
   │   })                                                      │
   │   재시도: maxRetries??5, per-codebase backoffState Map     │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌─ 서버 응답 분기 ──────────────────────────────────────────┐
   │                                                           │
   │ A) DO_COPY 매칭 (다른 사용자 같은 코드베이스 이미 인덱싱)  │
   │    → 서버가 기존 인덱스 카피 중                            │
   │    → 클라: setInterval(getCopyStatus,                     │
   │              copyStatusCheckPeriodSeconds=1*1000)          │
   │    → "copying" 상태로 폴링                                │
   │    → 완료되면 indexed status, sync 단계 skip              │
   │                                                           │
   │ B) 신규 — 업로드 필요                                      │
   │    → Step 6로 진행                                        │
   │                                                           │
   │ 분기 결정 신호: returnAfterBackgroundCopyStarted=true면    │
   │ 핸드셰이크 즉시 리턴, 카피 백그라운드 — 클라가 폴링       │
   └───────────────────────────────────────────────────────────┘
       │ (B 경우만)
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 6. SyncMerkleSubtreeV2 재귀 walk (30분 timeout)     │
   │   root부터 시작, 각 subtree에 대해:                       │
   │     req.local_partial_path = {hash, ...}                  │
   │     OR batch:                                             │
   │     req.local_partial_paths = [...]  (BATCH_SIZE=5000)    │
   │   응답:                                                   │
   │     match=true   → 이 subtree skip (서버 이미 가짐)       │
   │     mismatch{children:[]} → 자식들로 재귀                  │
   │   leaf 도달 시 → Step 7                                   │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 7. FastUpdateFileV2 업로드 (leaf 파일들)             │
   │   update_type: ADD (최초) / BATCH(여러 파일 묶음)         │
   │   file_updates: FileUpdate[] (FLUSH_BATCH_SIZE=5000)      │
   │   LocalFile{file, hash, unencrypted_relative_workspace_path}│
   │   getUploadLimits → {soft_limit, hard_limit} 협상         │
   │   → 서버: 청킹 + 임베딩 + 인덱스 저장 (RechunkerChoice)   │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Step 8. fastRepoSyncComplete                              │
   │   await chatClient.fastRepoSyncComplete({                 │
   │     codebases: [...]                                      │
   │   })                                                      │
   │   → 서버에 "이 코드베이스 sync 끝났음" 알림                │
   │   → 서버가 high_level_folder_description 생성 가능        │
   └──────────────────────────────────────────────────────────┘
       │
       ▼
   status = "ready" / "indexed"
   high_level_folder_description.txt 다운로드/생성
```

**최초 인덱싱 실패 시**:
- handshake 실패 → `handshakeWithRetry` 5회 백오프(`backoffState=new Map()`, per-codebase keyed) → 그래도 실패 시 status="failed"
- HANDSHAKE_TIMEOUT_MS(30분) 초과 → AbortController로 강제 취소, status="failed"
- SyncMerkleSubtree mid-walk 타임아웃 → 다음 doUpdate(10분 후) 재시도 (resume 아닌 처음부터)
- 100K 초과 → `"disabled"`(too-many-files), 다신 시도 안 함

---

### 5B. 델타 인덱싱 (steady state) — 워크스페이스 변경 후

```
[파일 시스템 이벤트] (VS Code FileSystemWatcher("**"))
       │
       ▼
   ┌──── 두 watcher가 *동시에* 받음 (별개 인스턴스) ────────┐
   │                                                       │
   │ ① merkleClient.onDidChange/Create/Delete(fsPath)      │
   │     Rust 내부:                                         │
   │       • 파일 재해시                                    │
   │       • Merkle subtree 부분 갱신 (in-memory)           │
   │       • 변경 누적 (큐, 디바운스는 Rust 내부 ≈)         │
   │       • 다음 doUpdate에서 sync 대상으로 마킹          │
   │                                                       │
   │ ② grepClient.onDidChange/Create/Delete(fsPath)        │
   │     crepectl Rust 데몬:                                │
   │       • in-memory grep 인덱스 부분 갱신                │
   │       • retrieval과 무관, 즉시 search 가능 상태 유지   │
   └────────────────────────────────────────────────────────┘
       │
       ▼ (다음 폴링까지 대기)
   ┌──────────────────────────────────────────────────────┐
   │ setInterval timer (period = max(600s, 60s) = default│
   │   10분, floor 1분) → doUpdate() 호출                 │
   └──────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────┐
   │ Step 1. constructMerkleTree({incremental:true})      │
   │   • Rust가 변경 누적분만 반영해 트리 부분 갱신       │
   │   • embeddable_files.txt 갱신 (truncate 안 함)        │
   │   • 새 simhash, 새 rootHash 계산                      │
   └──────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────┐
   │ Step 2. SyncMerkleSubtreeV2 재귀 (30분 timeout)      │
   │   • 거의 모든 subtree가 match=true (변경 없음)        │
   │   • 변경된 가지만 mismatch → 재귀 내려가 leaf 도달    │
   │   • 변경된 leaves만 식별                              │
   └──────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────┐
   │ Step 3. FastUpdateFileV2 (변경분만)                   │
   │   update_type:                                        │
   │     ADD     — 새 파일                                 │
   │     MODIFY  — 내용 변경                               │
   │     DELETE  — 삭제 (3분 timeout, 별도 흐름)           │
   │     BATCH   — 위 셋을 묶음                            │
   │   file_updates[] (FLUSH_BATCH_SIZE=5000)              │
   │   ancestor_spline = path proof (트리 위치 증명)        │
   └──────────────────────────────────────────────────────┘
       │
       ▼
   다음 doUpdate까지 대기 (10분 후, 또는 사용자 트리거)
```

**델타 인덱싱 특성**:
- **debounce**: FS 이벤트 → 즉시 sync 아님. **폴링 주기(default 10분)에 묶여서 처리**. 즉 클라가 *큐잉*만 하고, 10분에 한 번 묶어서 서버에 보냄. ≈ Rust binding에 내부 debounce가 있을 가능성 있으나 JS 레벨에선 미관측.
- **삭제 별도**: SYNC_DELETES_TIMEOUT_MS=3분 (sync보다 짧음) — 삭제는 별도 RPC 경로 또는 별도 timeout. 정확한 구분은 wire trace 필요.
- **branch switch**: git branch 전환 시 별도 트리거 미관측 — 다음 polling에서 변경된 파일들이 일괄 감지 ≈
- **워크스페이스 폴더 추가/제거**: `onDidChangeWorkspaceFolders`이 GrepClient 재구성 트리거 (cursor-retrieval 코드 확인), MerkleClient도 build 재호출 ≈
- **재시도**: `backoffState=new Map()`로 codebase별 backoff. 실패한 sync는 다음 주기에 재시도, 성공 시 `backoffState.delete(codebaseId)`.
- **busy 처리**: Rust 바이너리 문자열 `"is waiting on pending index work; returning busy"` 확인 — 동시 인덱싱 작업 거부, status="busy"로 리턴

---

### 5C. simhash dedup — *왜* 서버가 안 터지는가의 핵심

검증된 사실:
- `merkleClient.getSimhash()` → float 벡터 (차원 미관측, ≈ SimHash 변종)
- input: workspace의 leaf 해시들 (파일 단위)
- 핸드셰이크 `similarityMetric[]`에 그대로 직렬화 (`Array.from(simhash)`)
- `similarity_metric_type: SIMHASH` (다른 타입은 enum에 미관측, 향후 확장 여지)
- `do_copy: true`로 보내면 서버가 "이 simhash + rootHash 조합 이미 알아?" → 매칭 시 기존 인덱스 카피

**dedup 효과** (≈ 서버 동작 추론):
- 같은 OSS 레포(react/django/lodash…)는 simhash가 동일/유사 → 서버가 첫 번째 사용자의 인덱스를 *공유*
- 사용자별로 임베딩 재계산 안 함 → 컴퓨트 0
- `pathKey: privacyModeOff ? pathEncryptionKey : ""` — privacy mode off일 때만 path-decryption key 공유 (path 평문 dedup), on이면 path encrypted로 별도 인덱스 (≈)

**dedup 미스 시**:
- simhash 매칭 실패 또는 `doCopy:false` → 신규 인덱싱 전체 진행 (위 5A Step 6~8)

**privacy mode** (`privacyModeStatus=0` default off ✓):
- off → pathEncryptionKey 공유 → 서버가 평문 경로로 dedup 가능
- on → 키 공유 안 함 → 서버는 path hash만 봄, 코드베이스 매칭 정밀도 떨어짐 (사용자별 별도 인덱스 ≈)

---

### 5D. 사용자 트리거 명령 (verbatim ✓)
- `cursor.indexer.incremental` — 수동 incremental 인덱싱 트리거 (특히 autoIndexingMaxNumFiles 초과 시 유일한 진입점)
- `cursor.codebaseTelemetry.triggerSnapshot` — packfile 스냅샷 강제 트리거 (CodebaseSnapshotService 경로)
- `cursor.codebaseTelemetry.triggerGitHistoryCapture` — git 히스토리 캡처
- `cursor.grepClient.debug` — GrepClient 디버그 quick-pick (TrackedState/Warmup/Search)
- `cursor.runEditorBugbot` — bugbot 트리거 (간접 인덱싱 의존)

### 5E. CodebaseSnapshotService — packfile 대안 경로 (≈)
서비스: `CodebaseRegistrationService` / `CodebaseSnapshotManager` / `PackfileService` / `SnapshotUploader`.
RPC: `RegisterCodebase`, `RegisterCodebaseSnapshot`, `GetCodebaseSnapshotStatus`, `CreatePackfileUpload`, `UploadPackfileChunk`, `CompletePackfileUpload`, `triggerSnapshot`, `ReportAgentSnapshot`.
사용 시점: 대용량 일괄 업로드 / agent 작업 결과 스냅샷 / commit-based 인덱싱(`recordChanges`/`commitAll` NAPI 메서드와 결합) ≈. 일반 FastUpdateFileV2 경로와 *대안 관계*로 보이며, 정확한 분기 조건은 wire trace로만 확정 가능.

---

## 6. Ignore 규칙 layering

`merkleClient.build()` 입력 우선순위 (위→아래):
1. **admin blocklist** (`cursor.adminBlocklistPath()` 파일)
2. **admin unified JSON blocklist** (`cursor.adminUnifiedJsonBlocklistPath()`)
3. **`cursor.general.globalCursorIgnoreList`** 사용자 설정
4. **`.cursorignore`** / **`.cursorindexingignore`** — `package.json`에 `"id":"ignore"` 언어로 등록, Rust merkle builder 내부 적용

**홈 디렉토리 인덱싱 거부**:
```
if (workspaceUris.some(e => e.fsPath === os.homedir()))
  → "We currently do not allow indexing the home directory."
```

---

## 7. 클라 디스크 상태 (`WS_STATE`)

`~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/anysphere.cursor-retrieval/`:

| 파일 | 내용 | 출처 |
|---|---|---|
| `embeddable_files.txt` | 인덱싱 대상 파일 목록 (line per chunk, 중복=청크 다중) | Rust merkle `build({logFilePath})` 가 append; 비-incremental 시 truncate |
| `high_level_folder_description.txt` | 서버 생성 워크스페이스 요약 | `JQe="high_level_folder_description.txt"`, input은 `merkleClient.getImportantPaths(100)` |

**없는 것들** (명시적 부재):
- `.bin` / `.sqlite` 임베딩 캐시 — 0
- FAISS/HNSW/sqlite-vec — 0
- on-disk merkle persistence — 0 (in-memory only)
- `.scm` tree-sitter query — 0

---

## 8. 턴별 `StreamUnifiedChatRequest` 조립 (실제로 prompt에 뭐 담기나)

### 8.1 핵심 필드 producer 매핑

| 필드 | 누가 채우나 | 언제 |
|---|---|---|
| 1 `conversation` | ChatComposer 상태 | 매 턴 |
| 3 `explicit_context` (ExplicitContext) | 사용자 chat input + 시스템 prompt 슬롯 | 매 턴 |
| 6 `linter_errors` / 14 `multi_file_linter_errors` | VS Code `MarkerService` (`getRecentAndNearLocationLinterErrors`) | 마커 있을 때마다 |
| 10 `project_context: ConversationMessage` | 세션 시작 시 1회 (≈ `high_level_folder_description`) | 세션당 1회 ≈ |
| 15 `current_file: CurrentFileInfo` | `fastCurrentFileInfo()` + `truncateCurrentFile(...)` | 에디터 포커스 시 |
| 16 `recent_edits: RecentEdits` | composer-internal AI-edit 원장 | AI 편집 있을 때 |
| 18 `file_diff_histories: ComposerFileDiffHistory[]` | `cachedDiffHistories` (LRU 10) | 수락된 편집마다 |
| 20 `additional_ranked_context` | 서버가 후속 턴에 echo | 후속 턴 |
| 21 `quotes: ChatQuote[]` | UI 텍스트 selection 인용 | 사용자 인용 시 |
| 26 `environment_info` | OS/shell/VSCode version | 매 턴 |
| 29 `supported_tools` | mode별 도구 enum 리스트 | 매 턴 |
| 34 `mcp_tools` | MCP 서버 설정시만 | 조건부 |
| 42 `uses_codebase_results` | 서버 retrieval 돌릴지 플래그 | 조건부 |
| 46 `unified_mode` | UnifiedMode enum | 매 턴 |
| 49 `thinking_level` | ThinkingLevel enum | 조건부 |
| 66 `subagent_info` | subagent 턴이면 | subagent만 |
| 89 `current_plan` | plan 활성 시 | 조건부 |

### 8.2 `ConversationMessage` 안의 코드 컨테이너 4종 (`IDE`)

| 필드 | 이름 | 채우는 시나리오 |
|---|---|---|
| 3 | `attached_code_chunks: CodeChunk[]` | 사용자 @-멘션 / 가시 / AI-편집 / 컴포저 파일 |
| 4 | `codebase_context_chunks: CodeChunk[]` | 자동 retrieval 결과 |
| 18 | `tool_results` | 도구 호출 결과(READ_FILE/GREP 등) |
| 27 | `recently_viewed_files: CodeChunk[]` | 최근 연 파일 |
| 44 | `context_pieces: ContextPiece[]` | 신규 컨텍스트 타입 catch-all |

### 8.3 `CodeChunk`
```
{ relative_workspace_path, start_line_number, lines:string[],
  summarization_strategy?, language_identifier, intent?,
  is_final_version?, is_first_version?, contents_are_missing?,
  is_only_included_from_folder?, code_chunk_git_context? }
```

### 8.4 `CodeChunk.Intent` enum (9값) ✓
```
0 INTENT_UNSPECIFIED
1 INTENT_COMPOSER_FILE          (composer 모드 일반)
2 INTENT_COMPRESSED_COMPOSER_FILE (composer 모드 압축)
3 INTENT_RECENTLY_VIEWED_FILE
4 INTENT_OUTLINE                (심볼 outline만)
5 INTENT_MENTIONED_FILE          (@-멘션)
6 INTENT_CODE_SELECTION
7 INTENT_AI_EDITED_FILE
8 INTENT_VISIBLE_FILE
9 INTENT_TERMINAL_SELECTION
```

### 8.5 ★ `getCodeChunksFromFileSelections` — 통째 파일 전송 verbatim
```js
async getCodeChunksFromFileSelections(e, t) {
  await new Promise(i => cursorIgnoreService.addOnCursorIgnoreLoadedCallback(...));
  return (await mAv(e, async r => {
    const s = URI.revive(r.uri);
    if (cursorIgnoreService.shouldBlockUriFromReading(URI.revive(s))) return;
    const o = t?.context ? getMentions(t.context, "fileSelections", r) : [];
    let a;
    if      (o.length > 0)          a = Nve.MENTIONED_FILE;
    else if (r.isFromAIEdited)      a = Nve.AI_EDITED_FILE;
    else if (r.isFromVisibleFiles)  a = Nve.VISIBLE_FILE;
    else                            a = Nve.COMPOSER_FILE;
    let l = [];
    const u = modelService.getModel(s);
    if (u) l = u.getLinesContent();                      // 열린 버퍼면 전체
    else   l = (await fileService.readFile(s)).value.toString().split('\n');
    if (l.length !== 0)
      return new CodeChunk({
        relativeWorkspacePath: workspaceContextService.asRelativePath(s),
        startLineNumber: 1,                              // ★ line 1부터 전체
        lines: l,
        intent: a,
        isOnlyIncludedFromFolder: t?.isFromFolder ?? false
      });
  }, { max: 16 })).filter(...).map(...).filter(Qf);
}
```
**핵심**: IDE는 @-멘션·가시·AI-편집·컴포저 파일을 **chunk 안 함 — 전체 파일** 그대로 `CodeChunk{startLineNumber:1, lines: 전체}`로 보냄. 동시 max 16개 병렬 read. `.cursorignore` 적용. ✓

### 8.6 `current_file` 트렁케이션
`fastCurrentFileInfo` + `truncateCurrentFile(h.contents, cursorPos.line, eol, uri)` — 커서 위치 근처로 자름. 구체 알고리즘 미관측 (호출만 보임). ≈

### 8.7 긴 파일 처리
- `allow_long_file_scan: bool` (request field 2)
- `checkLongFilesFit(StreamUnifiedChatRequest → CheckLongFilesFitResponse)` RPC — *서버*가 컨텍스트 윈도우 fit 판정, 안 맞는 파일 드롭/요약 결정
- 즉 클라는 일단 보내고 서버가 거른다 ≈

---

## 9. 서버→클라 `ContextItem` (22-member, 모두 서버 producer)

`aiserver.v1.ContextItem` 는 **서버 → 클라** payload. 서버가 어떤 청크를 골랐는지 + `ContextItemStatus`(아래)를 같이 보내서 클라 UI가 "shown to model" 오버레이로 표시. **요청에 안 들어감**.

```
ContextItemStatus {
  context_item_hash, shown_to_the_model:bool, score:float,
  percentage_of_available_space:float, post_generation_evaluation:enum
}
```

22 멤버 (`IDE` offset 3710941):

| no | field | 설명 | producer |
|---|---|---|---|
| 2 | `file_chunk{relative_workspace_path, chunk_contents, start_line_number}` | 일반 청크 | 🔒 서버 |
| 3 | `outline_chunk{relative_workspace_path, contents, full_range}` | signature/declaration만 | 🔒 서버 (IsolatedTreesitter 결과 가공) |
| 17 | `sparse_file_chunk{lines:[{line,line_number}], total_number_of_lines_in_file, cell_number?}` | 선택 라인만 | 🔒 서버 |
| 18 | `lsp_subgraph_chunk` | call/import 이웃 | 🔒 서버 (LSP-client 아님!) |
| 4–7,15,16,21 | `cmd_k_*` | Cmd-K 전용 | 🔒 |
| 8 | `custom_instructions` | 사용자 instructions echo | 🔒 |
| 9 | `go_to_definition_result` | 서버 fanout | 🔒 |
| 10 | `documentation_chunk` | `documentationQuery` 히트 | 🔒 |
| 11 | `lints` | 클라 업로드 `linter_errors` echo | 🔒 |
| 12 | `chat_history` | 대화 요약 | 🔒 |
| 13 | `notebook_cell_output` | 노트북 셀 | 🔒 |
| 14 | `terminal_history` | 터미널 | 🔒 |
| 19 | `commit_note_chunk` | `takeNotesOnCommitDiff` | 🔒 |
| 20 | `file_diff_history` | 클라 업로드 `RecentEdits` 변환 | 🔒 |
| 22 | `project_rule` | 클라 `cursor_rules` echo | 🔒 |

클라 사용처는 **렌더러 1곳뿐**: `IDE` offset 32741881 `jQc`/`sfS`/`ofS` — "shown to model" 오버레이.

---

## 10. `ChunkType` enum — 서버 rerank 풀 3종 ✓
```
ChunkType:  UNSPECIFIED | CODEBASE | LONG_FILE | DOCS
```
서버가 retrieval 시 끌어올 3가지 pool 구분 (`IDE` offset 3414114).

---

## 11. 두 가지 시맨틱 서치 경로

### 11.1 인덱싱 path (백그라운드)
`RepositoryService` (`semSearchFast`/`semSearch` server-stream, `searchRepositoryV2` unary):
```
SearchRepositoryRequest {
  query, repository, top_k, model_details, rerank,
  context_cache_request?, glob_filter?, not_glob_filter?,
  race_n_requests?, query_only_repo_access?
}
SemSearchRequest { request: SearchRepositoryRequest }
```

### 11.2 도구 path (모델이 호출)
```
SemanticSearchParams {
  query, include_pattern?, exclude_pattern?, top_k,
  index_id?, grab_whole_file:bool   // ★ true면 전체 파일 반환
}
SemanticSearchResult { results: Item[], files: map<string,string> }
Item {
  relative_workspace_path, score, content, range,
  original_content?, detailed_lines[]
}

SemanticSearchFullParams {
  repository_info, query, include_pattern?, exclude_pattern?, top_k,
  pr_references[], pr_search_on?, explanation?, code_results[]
}
SemanticSearchFullResult {
  code_results[], all_files[], missing_files[],
  knowledge_results[], pr_results[]
}

MissingFile.MissingReason { UNSPECIFIED, TOO_LARGE, NOT_FOUND }
```

### 11.3 ★ 2-step 패턴: 검색 → 선택 → hydrate
모델 흐름:
1. `codebase_search`(`SEMANTIC_SEARCH_CODEBASE`) 호출 → top-K 후보 받음
2. 후보 중 골라서 **`read_semsearch_files`**(`READ_SEMSEARCH_FILES`, enum #1) 호출 → 본문 hydrate
```
ReadSemsearchFilesParams {
  repository_info, code_results[], query,
  pr_references[], pr_search_on?
}
ReadSemsearchFilesResult {
  code_results[], all_files[], missing_files[],
  knowledge_results[], pr_results[],
  git_remote_url?, pr_hydration_timed_out?
}
```

**왜 2-step?** top-K 메타로 컨텍스트 절약, 모델이 진짜 필요한 것만 풀 본문 받음. quanta 흡수 가치 있음 (현재 retrieval 안 함).

---

## 12. `read_file` 도구 vs retrieval — 두 분리된 경로

### 12.1 `read_file` (도구) — bytes range 그대로, NOT chunked ✓
```
ReadFileV2Params {
  target_file, offset?, limit?, chars_limit,
  effective_uri, enable_line_numbers?
}
ReadFileV2Result {
  contents?, num_characters_in_requested_range,
  offset_is_bigger_than_number_of_lines_in_file?,
  total_lines_in_file?,
  matching_cursor_rules[],    // ★ glob 매칭되는 .cursor/rules/*.mdc 자동 첨부
  images[]                    // ★ PDF/이미지 파일이면 이미지 같이 반환
}
```
- 청킹 안 함 — offset/limit/chars_limit 범위 그대로
- 다음 턴 `ConversationMessage.tool_results`(field 18)로 전달 (ContextItem 아님!)
- `matching_cursor_rules`: 읽은 파일 glob에 매칭되는 .mdc rule 자동 첨부
- `images`: PDF 페이지/이미지 파일 추출

### 12.2 retrieval auto-attach — `ContextItem` 경로
서버가 알아서 청크 골라 보냄, 클라는 `ContextItemStatus` 렌더만.

### 12.3 같은 파일 중복?
- @-멘션 (whole, `attached_code_chunks` field 3)
- + `read_file` 도구 (range, `tool_results` field 18 다음 턴)
- + 서버 retrieval (chunk, `codebase_context_chunks` field 4 후속 턴 echo)

→ **클라 dedup 없음**, 서버측 `context_item_hash`로만. ≈

---

## 13. End-to-end ASCII 파이프라인

```
                                  Workspace files (FS)
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │                             │                             │
            ▼                             ▼                             ▼
  createFileSystemWatcher("**")  createFileSystemWatcher("**")    crepectl helper
  (RepoIndexWatcher.sFe)         (GrepClient 별도 구독)           (Rust ripgrep)
            │                             │                             │
            ▼                             ▼                             │ warmup(roots)
  merkleClient.onDidChange/Create/Delete   GrepClient.onDidChange         │ in-memory index
  (Rust NAPI @anysphere/file-service)                                    │
            │                                                            │
            │ setInterval(doUpdate, max(period,60s)) ─ 시작 시 즉시      │
            ▼                                                            │
  ┌──────────────────────────┐                                           │
  │ merkleClient.build({     │ ◀── globalCursorIgnoreList               │
  │  incremental,            │      admin blocklistPath                  │
  │  maxNumFiles,            │      admin unifiedJsonBlocklistPath       │
  │  blocklistPath,          │      .cursorignore/.cursorindexingignore  │
  │  globalCursorIgnore,     │                                           │
  │  logFilePath })          │ ──▶  embeddable_files.txt                 │
  └──────────────────────────┘      (WS_STATE)                           │
            │                                                            │
            │ getSubtreeHash(".") / getNumEmbeddableFiles() /             │
            │ getSimhash() / getImportantPaths(100)                       │
            ▼                                                            │
  ┌──────────────────────────┐                                           │
  │ FastRepoInitHandshakeV2  │ ──── gRPC/Connect → api2.cursor.sh        │
  │  rootHash, simhash[],    │                                           │
  │  pathKeyHash, do_copy    │                                           │
  └──────────────────────────┘                                           │
            │ server: 다른 사용자 같은 코드베이스면 do_copy=true 재활용   │
            ▼                                                            │
  ┌──────────────────────────┐                                           │
  │ SyncMerkleSubtreeV2 loop │ ◀──▶ server: match:true(skip)            │
  │  subtree 단위 비교       │       mismatch{children}:재귀             │
  └──────────────────────────┘                                           │
            │ leaf 도달 시                                                │
            ▼                                                            │
  ┌──────────────────────────┐                                           │
  │ FastUpdateFileV2         │ ──▶ server-side:                          │
  │  ADD|DELETE|MODIFY|BATCH │     • chunk (RechunkerChoice              │
  │  LocalFile{file,hash,    │       IDENTITY / 600 / 2400 / 4000 toks)  │
  │   path}                  │     • embed → 벡터 인덱스                  │
  └──────────────────────────┘     • IsolatedTreesitter (심볼)           │
                                   • outline/lsp_subgraph 빌드          │
                                                                         │
─── 매 chat 턴 ─────────────────────────────────────────────             │
                                                                         │
  User input ChatComposer                                                │
   │                                                                     │
   ├─ file mentions  ──▶ getCodeChunksFromFileSelections                │
   │                     (★ WHOLE file from buffer/FS, max 16 parallel) │
   │                     → CodeChunk{lines, startLine:1,                │
   │                       intent: MENTIONED/VISIBLE/AI_EDITED/COMPOSER}│
   │                     → ConversationMessage.attached_code_chunks (#3)│
   │                                                                     │
   ├─ current editor ──▶ fastCurrentFileInfo+truncateCurrentFile        │
   │                     → StreamUnifiedChatRequest.current_file (#15)  │
   │                                                                     │
   ├─ recent AI edits──▶ RecentEdits (#16)                              │
   ├─ cached diffs ───▶ ComposerFileDiffHistory[] (LRU 10) (#18)        │
   ├─ LSP markers ────▶ linter_errors (#6) + multi_file (#14)          │
   ├─ cursor rules ───▶ matched-rule list                              │
   └─ env info ───────▶ EnvironmentInfo (#26)                          │
                                                                         │
            │ StreamUnifiedChatRequest (~85 fields)                      │
            ▼                                                            │
  ┌──────────────────────────┐                                           │
  │ ChatService              │ ──▶ server:                               │
  │  .streamUnifiedChat{,    │     • 시스템 prompt 조립                  │
  │   WithTools…}            │     • 필요 시 semSearch 실행              │
  │  (BiDi/SSE/Poll)         │     • ContextItem 선택 (FileChunk/        │
  └──────────────────────────┘       OutlineChunk/SparseFileChunk/      │
            │                        LspSubgraph/Lints/Docs)            │
            │                      • 텍스트+도구콜 스트림               │
            │                                                            │
            ▼ ContextItem 스트림 (서버→클라)                            │
  ┌──────────────────────────┐                                           │
  │ "shown to model" 렌더러  │ "SHOWN: file_chunk of X from line N: …"  │
  │  jQc/sfS/ofS @32741881   │  사용자가 실제 prompt 들어간 컨텍스트    │
  └──────────────────────────┘  확인용 오버레이                          │
                                                                         │
─── 모델 도구 호출 시 ─────────────────────────────────                  │
                                                                         │
  codebase_search ─▶ SEMANTIC_SEARCH_CODEBASE                            │
                    → 서버 semSearch → top-K Item[] 반환                │
                    → 모델이 골라서 read_semsearch_files (2-step)       │
                                                                         │
  grep_search ─────▶ GrepClient.query → crepectl in-memory ──────────────┘
                    (★ 100% 로컬, 서버 안 거침)
                    → byFile[] + matches[]
                                                                          
  read_file ───────▶ filesystem.read(target, offset, limit, chars_limit)
                    → tool_results (#18) — NOT chunked, byte-range
                    +matching_cursor_rules + images
```

---

## 14. 명시적 부재 (검색해서 없음을 확인한 것들)

- ❌ 클라 tree-sitter 파싱 (`treesitter.*` = 서버 RPC)
- ❌ `.scm` tree-sitter 쿼리 파일 0개 (`find … -name '*.scm'`)
- ❌ 클라 임베딩/벡터 캐시 (`.bin`/`.sqlite`/FAISS/HNSW 0)
- ❌ `vscode.executeWorkspaceSymbolProvider`/`executeDefinitionProvider` 등 LSP 명령 cursor-retrieval에서 0건
- ❌ on-disk merkle 영속 (in-memory only)
- ❌ 클라 chunker 로직 (`Rechunker`=서버 enum, `chunkFile`/`Chunker`/`splitIntoChunks` 0건)
- ❌ Python/Go/Rust/Java/C/C++ tree-sitter wasm (css/typescript/ini/regex만)

---

## 15. quanta 흡수 시사 — 정정된 결론

### 15.1 Cursor 모범 = 베끼지 마라 (조건이 다르다)
Cursor는 **백엔드가 있어서 청킹·임베딩·outline·심볼을 서버에 떠넘긴다**. quanta는:
- 사용자가 OpenAI/Anthropic API 키만 가짐 (백엔드 없음)
- multi-surface (CLI/Web-Tauri/CLI-embedded browser)
- → "클라가 Merkle만 하고 서버가 다 한다"는 패턴 *직접 적용 불가*

### 15.2 진짜 베낄 가치 (server-independent)
1. **★ 2-step semantic search 패턴** — top-K 메타만 받고 모델이 골라 hydrate (`SemanticSearch` → `read_semsearch_files`). 토큰 절약. quanta `codebase_search` 스킬 신설 시 이 형태로.
2. **★ retrieval ↔ on-demand-read 분리** — auto-attached `ContextItem` vs 모델-요청 `tool_results`. 둘 다 같은 봉투에 들어가지만 의미가 다름. quanta dispatch에 이 분리 명시.
3. **`read_file`의 `matching_cursor_rules` 자동 첨부** — 파일 읽을 때 .mdc glob 매칭 rule 같이 반환. quanta가 glob rule 흡수(P0)하면 read 결과에 끼워넣기 자연스러움.
4. **`read_file`의 `images[]` 반환** — PDF/이미지 파일 1급. quanta read 도구도 multimodal로.
5. **CodeChunk.Intent 9-value 분류** — MENTIONED/VISIBLE/AI_EDITED/COMPOSER/OUTLINE/RECENT/SELECTION — chunk 출처를 모델에 명시. quanta도 `attached_code_chunks` 같은 거 만든다면 intent 분류 필수.
6. **Ignore 4-layer (admin blocklist > user ignore list > .cursorignore > .cursorindexingignore)** — 정책 우선순위 데이터로 박힘.
7. **2개 watcher 패턴 (merkle용 / grep용 별개 구독)** — 인덱스용과 search용을 분리. quanta는 단일 watcher로도 충분할지 검토.

### 15.3 quanta가 *직접 결정*해야 할 것들
- 청킹·심볼 추출을 어디서: (a) 로컬 tree-sitter wasm + 자체 sqlite-vec, (b) 모델 호출로 청크 추출, (c) ripgrep만(심볼 없음), (d) LSP에 의존 — 트레이드오프 명확.
- 임베딩 어디서: 로컬(sqlite-vec/qdrant 임베디드) vs 사용자 API 키로 OpenAI embeddings 호출.
- 인덱싱 vs on-demand: 항상 grep으로 충분한지, 임베딩 인덱스 가치 있는지.
- Cursor는 "서버 reranking"이 강한데 우린 그게 없다 → 모델한테 더 큰 윈도우 주고 self-rerank 시킬지.

### 15.4 흡수 금지 (서버 종속)
- Merkle+simhash 핸드셰이크 (사용자별 코드베이스 카피 공유 = 서버 기능)
- `IsolatedTreesitter` 원격 RPC (서버 코드 파싱)
- ContextItem typed union 서버 producer (서버 책임)
- `RechunkerChoice` enum (서버 옵션)
- ChunkType CODEBASE/LONG_FILE/DOCS rerank pool (서버)

---

## 16. 핵심 결론 한 줄
**Cursor는 "클라가 가벼운 메타데이터(merkle/simhash/grep)만 만들고, 통째 파일을 보낸 뒤 청킹·심볼·임베딩·LspSubgraph·Outline까지 서버가 다 한다"는 *클라우드-우선* 아키텍처다. tree-sitter wasm 동봉은 에디터 하이라이팅용 미끼고, retrieval은 100% 서버. 이건 백엔드 있는 회사만 할 수 있는 결정이고, quanta(BYO-API-key, 백엔드 없음)는 청킹·심볼·임베딩 *어딘가*서 해야 하며 그 자리는 로컬 tree-sitter wasm + 임베디드 벡터스토어이거나 모델 호출이거나 grep-only다. Cursor의 *결과 envelope*(2-step search, intent-tagged CodeChunk, matching_cursor_rules 자동첨부, ignore layering, retrieval↔read 분리)은 베낄 가치 있다.**

---

## 17. Delta sync & drift 방어 — *변경분이 어긋나면 빵꾸 안 나나*

> 가장 흔한 우려: "FS watcher 드롭/race로 인덱스가 실제와 어긋나면 retrieval에 빵꾸". 정밀 검증 결과 — Cursor는 **watcher를 *진실*로 안 본다**. 4단 방어 모델로 막는다.

### 17.1 핵심 사상 — **server-driven verify-then-patch**

Cursor 설계 사상: **FS watcher는 *힌트(hint)* 이고 ground truth는 60초마다 *서버가 검증*한다**. 그래서 macOS fsevents가 드롭해도, 네트워크 FS라 watcher가 안 와도, 빵꾸 자가복구. **이벤트 한 줄에 안 맡긴다.**

### 17.2 4단 방어 (발화 빈도 순)

| # | 메커니즘 | 발화 주기 | 보장 |
|---|---|---|---|
| **1** | **In-band `recent_edits` overlay** | **매 chat 턴** | 방금 편집한 파일에 대해 모델이 **0초 안에 fresh 본문** 봄 |
| **2** | Rust 내부 debounced rehash | watcher 이벤트마다 (debounced) | 빠른 타이핑 collapse + 코어 merkle 트리 갱신 |
| **3** | **★ 서버 주도 subtree-walk 화해** | **≥60초마다 `doUpdate`** | **watcher가 100% 놓쳐도 60초 내 빵꾸 발견·복구 (진짜 보장)** |
| **4** | Handshake로 ground truth 재정립 | 매 `doUpdate` cycle | `rootHash`+`simhash` → 서버 `UP_TO_DATE/OUT_OF_SYNC/EMPTY` 판정, EMPTY면 풀 재업로드 |

### 17.3 #1: `recent_edits` overlay — 즉시 delta 채널 (chat path의 0-second 방어)

매 `StreamUnifiedChatRequest`의 field 16:
```
RecentEdits {                                  // IDE ~ offset 3 440 100
  code_block_info: CodeBlockInfo[]             // 편집 단위
  final_file_values: FileInfo[]                // 통째 파일 스냅샷
  edits_belong_to_composer_generation_uuid: string?
}
CodeBlockInfo {
  relative_workspace_path, content_before?, content_after?,
  generation_uuid?, version?
}
FileInfo { relative_workspace_path, content }
```
**메커니즘**: 서버는 (약간 stale한) 임베딩 인덱스 위에 `recent_edits` overlay를 얹어 "현재" 상태로 추론. merkle 파이프라인은 비동기로 따라잡힘. **모델 추론에는 stale 답 절대 안 줌**. 임베딩이 catch-up 못해도 OK — chat은 항상 fresh.

### 17.4 #2: 클라 측 debounce — Rust 내부 큐 ✓

JS layer는 debounce 안 함 — 매 키스트로크가 `merkleClient.onDidChange(fsPath)`를 native 호출. Debounce는 `FILESVC_NAPI` Rust 안:

verbatim 문자열 (`packages/file-service/src/merkle_client.rs`, `crates/merkle_tree/src/async.rs`):
```
pending documents detected; starting to debounce
cancelled index refresh (debounce)
performing index refresh (debounce)
performing index refresh
Processing Refresh (current Merkle state: ...)
Starting full rebuild for roots: ...
Rebuild complete in ...
before_hash = ... after_hash = ...
```
≈ 추론: 이벤트가 MPSC 큐 + debounce 타이머에 들어가, 타이머 발화시 한 번에 drain. 변형 3종 (`async.rs:275/282/289`): `FileModified` / `FileCreated` / `FileDeleted`. 정확한 debounce window는 엔진 내부, strings에서 추출 불가 (🔒). 빠른 타이핑 10자/100ms는 1개 rehash로 collapse.

**`.gitignore`/`.cursorignore` 변경 → 자동 풀 rebuild**: ✓ `cannot perform incremental update on an ignore file (root hash cannot be None)` → `Starting full rebuild for roots:`.

**Rename**: VSCode `**` watcher는 rename 이벤트 안 emit. JS도 Change/Create/Delete만 forward. Rust 측에서 **rename = Delete(old) + Create(new)**. 특수 path 없음.

### 17.5 #3: ★ 서버 주도 subtree-walk 화해 — 진짜 drift 가드

✓ `RETRIEVAL.aFe.startSync` 알고리즘:
```
queue = [{relativePath:".", hash: <rootHash>}]
while queue.length > 0 || semaphore busy:
  pop batch of size maxSyncMerkleBatchSize    // default 1
  call syncMerkleSubtreeV2 → match | mismatch{children[]} | responseSizeLimitExceeded
  processSyncResult:
    if match → done (subtree 일치, skip)
    if mismatch + 빈 children → newDirectoriesToSend (서버가 모름)
    if mismatch + children →
      for each child server returned:
        getSubtreeHash 로컬
        if local missing → newDirectoriesToSend
        if hash differs → push back queue (recurse)
      additionally: readdir 로컬, 서버가 안 mention한 path 찾기
        dirs → newDirectoriesToSend
        files → newFilesToSend
```
**대칭 비교 = 핵심**: 서버가 모르는 것(클라 missed events) + 클라가 모르는 것(서버 corruption) **둘 다 잡힘**. ✓ `MAX_NUM_ITERATIONS = 1e7` iteration cap, 초과 시 `hitIterationLimit:true` reported in `fastRepoSyncComplete`.

### 17.6 #4: Handshake로 ground truth 재정립 매 cycle

매 `doUpdate`에서 `FastRepoInitHandshakeV2{rootHash, simhash[], pathKeyHash, do_copy}` → 서버 응답 per-codebase status:
- `UP_TO_DATE` → skip
- `OUT_OF_SYNC` → subtree walk (#3)
- `EMPTY` → `startRepoUpload()` 풀 재업로드 (`merkleClient.getAllFiles()` 전체)
- `EMPTY_WITH_COPY_AVAILABLE` → `do_copy:true`로 다른 사용자 인덱스 카피
- `COPY_IN_PROGRESS` → `getCopyStatus` 1초 폴 (최대 60분), 단계: `INITIALIZING|COPYING|CREATING_SEARCH_FILTERS|COPYING_SEARCH_STATE|COPYING_TREE_STATE|SYNCING_COPY|COMPLETED`

`fastRepoSyncComplete` (sync 끝 신호):
```
{codebases: [{codebaseId, status:SUCCESS|FAILURE,
              similarityMetricType, similarityMetric,
              failedUploadCount, failedDeleteCount,
              totalUploadCount, totalDeleteCount,
              failedSubtreeCount, totalSubtreeCount,
              hitIterationLimit}]}
```

### 17.7 `doUpdate` step-by-step ✓ (race 보호 4-timer)

`RETRIEVAL.sFe.doUpdate`:
1. `isDisposed` 체크 → return
2. **Race 가드**: 4개 timer 중 하나라도 in-flight면 skip + 로그:
   - `currentIndexingJob` < 60s old → `"Skipping new indexing job: recent jobs still running"`
   - handshake < 30min → `"handshake in progress"`
   - syncMerkle < 30min → `"sync merkle subtree in progress"`
   - syncDeletes < 3min → `"sync deletes in progress"`
3. 새 `rFe` (CodebaseIndexingJob) 생성: `startIndexingRepository()` → `getServerStatus()` → `startFastRemoteSync()`

**이게 race lock** — 중복 동시 sync 방지. 큐된 FS 이벤트는 merkle 트리에 계속 누적 → 다음 tick에 자동 pickup.

### 17.8 Delete 경로 (왜 3분 별도 timeout)

✓ `aFe.deleteFileListFromServer`:
```
loop up to 10 concurrent → deletePathOnServer
  → repoClient.deleteFastUpdateFileWithRetry({
       partialPath:{case:"directory", value:{...}},
       updateType: DELETE,
       fileUpdates: []
     })
```
**전용 RPC 없음** — 같은 `fastUpdateFile` RPC + `updateType=DELETE`. "별도"는 클라 측 회계 — `pathsToDelete:Set`에 모았다가 upload 전 drain. 3분 ceiling은 deletes 행이면 `doUpdate` 더 빨리 재무장하려는 의도.

### 17.9 Delta payload — 정직하게 풀-파일 (diff 아님)

✓ `LocalFile`:
```
LocalFile {
  file: { relative_workspace_path, contents },   // contents = UTF-8 풀 본문
  hash,
  unencrypted_relative_workspace_path
}
```
**파일 단위 diff 아님, 청크 delta 아님**. "delta"는 *어느 파일을* 보낼지의 결정일 뿐, *파일의 어느 부분*이 아님.

**Batch**: 기본 `maxBatchBytes=2 MiB`, `maxBatchNumRequests=1` → 거의 항상 1파일=1요청. 서버가 `getUpdatedConfig`로 numRequests 올리면 batch 활성. 단일 파일 경로는 `partialPath`에, 다중은 `fileUpdates[]`+top-level `updateType=BATCH`.

### 17.10 Agent edits vs user edits — 같은 경로

- Agent의 `edit_tool_call`은 결국 VSCode `workspace.fs.writeFile` 호출 → `**` watcher 트립 → merkle 업데이트. **Fast-path 없음** (별도 NAPI 호출로 바로 in-memory tree 갱신하는 흔적 ❌).
- 결과: agent가 파일 편집 → 다음 턴 prompt 조립 시:
  - `read_file`/`grep`/`ls` 도구 결과: **fresh** (disk에서 직접 읽음)
  - `semSearch` (방금 편집한 파일 대상): **stale, 다음 sync까지** (수십초)
- 이 갭을 메우는 게 `recent_edits` overlay (§17.3)

### 17.11 Concurrent modification 보호 — *없다*, 다음 tick 화해에 맡김

✓ `aFe.syncFile`:
```
const s = await ca.workspace.fs.readFile(...);
const i = new TextDecoder("utf-8").decode(s);
const a = yQe(i);   // hash
push({ file:{contents:i}, hash:a, ... });
```
- **Optimistic CC token 없음, 사전 re-hash check 없음**. 파일이 upload 중 또 바뀌면 *read 시점 스냅샷* + 그 hash가 올라감.
- 그 후 또 바뀐 건? 다음 `doUpdate`의 subtree walk가 서버측 저장 hash ≠ 로컬 hash 발견 → 재업로드.
- 즉 race는 **수십초 stale 1회 허용 + 자가복구**. 강 일관성 안 노림.

`responseSizeLimitExceeded` ✓ — subtree 너무 크면 서버가 응답하고, 같은 node가 다시 queue됨 (조각조각 받음).

### 17.12 초기 sync + 복구

**Non-incremental path** (`startRepoUpload`): handshake 결과 `status===EMPTY`일 때만. `merkleClient.getAllFiles()`를 flat ADD 리스트로 업로드. 트리거: 첫 인덱싱 OR 서버가 인덱스 비웠을 때.

**File-count caps**:
- ✓ `autoIndexingMaxNumFiles` (기본 10000): `constructMerkleTree`에서 `numEmbeddableFiles > 임계 + indexingIntent === FallBackToDefault` → 중단 + status `not-auto-indexing` ("Not automatically indexing because folder has N files."). **사용자 명시 opt-in 필요**.
- ✓ `absoluteMaxNumberFiles` (기본 100000): `startSync`에서 `numJobs >= 임계` → 에러 "Too many files to upload." + status `error`. **hard cap**.

**`embeddable_files.txt`** truncate-then-rewrite: 파일 없음 OR non-incremental OR initialSync일 때 `writeFile(e, new Uint8Array())`로 비움, 이후 Rust가 append.

**워크스페이스 폴더 add/remove** (`KPe` CodebaseWorkspaceManager): `onDidChangeWorkspaceFolders` → sequencer.queue → removeCodebase(removed)/addCodebase(added). `RepoIndexWatcher`도 dispose/재생성 — 새 handshake로 자연 재개.

### 17.13 의도적으로 *안 막는* 것 (drift 인정)

| 시나리오 | drift | 회복 |
|---|---|---|
| **oversized 파일** (>임계, ✓ `KQe`) | **영구, silent** | "Skipping oversized file from index queue" 로그만, 사용자 통지 없음 |
| upload 중 file change race | 1회 stale 스냅샷 | 다음 tick walk |
| sync 중 query | stale 결과 반환 | 가용성 우선, "in-flight면 refuse" 없음 |
| 자동 복구로 `removeRepositoryV2` 호출 | 안 함 | 사용자가 "delete index" 메뉴로만, 자가복구는 walk 수렴에 100% 의존 |

### 17.14 Failure 모드 & retry

**Retry**:
- `handshakeWithRetry`: 30min 시작, 실패시 doubling, 60min cap. Sleep = 직전 timeout, then double. 단일 retry path, jitter 없음.
- `ensureIndexCreated`: 2s 시작, doubling, 120s cap.
- per-file upload (`syncFileListToServer`): `maxFileRetries=20`. Rate-limit aware: `FREE_USER_RATE_LIMIT_EXCEEDED`/`PRO_USER_RATE_LIMIT_EXCEEDED`/`ResourceExhausted`로 `errorIsRateLimit=true` → 자작 concurrency controller `d(success?, isRateLimit)`가 `concurrentUploads` halving (최소 1), 성공율 좋으면 다시 grow. `USAGE_LIMIT` → `errorIsFatal=true` 전체 sync abort.

**Worker panic**: ≈ `Worker thread panicked during initialization`/`Failed to acquire lock on MerkleTree` 메시지 → JS 측 에러 반환, terminate 안 함. 다음 tick에서 재시도.

**Server 5xx**: per-file 에러 `H_.FAILURE` (retryable) / `H_.EXPECTED_FAILURE` (non-retryable). retryable은 requeue.

**Search during failed sync**: ✓ 마지막 성공 인덱스에 대해 계속 작동. `repositoryIndexingStatus="error"` 상태에도 `primaryQueryOnlyIndex` 살아있으면 `isIndexedRepository()`가 true. 사용자는 *stale 결과* 받음, 에러 안 봄 → 가용성 편향.

### 17.15 Save → queryable 윈도우 (총 latency)

T=0 save 후 semSearch hit까지:
1. 내부 debounce: 수백ms~수초 (정확 값 🔒)
2. + 다음 `doUpdate` tick: ≤60s
3. + subtree walk + upload 변경 파일들: 변경 크기 비례
4. + 🔒 서버 임베딩: 수초

→ **총 수십 초**. chat은 §17.3 overlay로 즉시 OK.

### 17.16 빵꾸 시나리오 매트릭스

| 시나리오 | drift 발생? | 회복 메커니즘 | 회복 시간 |
|---|---|---|---|
| FS watcher 드롭 (macOS fsevents) | 일시적 | #3 subtree-walk | <60s |
| 빠른 타이핑 (100자/100ms) | 없음 | Rust debounce collapse | 즉시 |
| Upload 중 또 변경 | 1회 stale 스냅샷 | #3 hash mismatch | 다음 tick |
| `.gitignore` 변경 | 일시적 | 자동 풀 rebuild | rebuild 완료 시 |
| 서버 5xx | 회복 가능 | rate-limit aware retry | exp backoff |
| Oversized 파일 (>임계) | **영구 (의도적)** | 없음 — silent skip | 안 됨 |
| `merkleClient` 크래시 | 다음 tick까지 | NAPI 에러 반환, 재시도 | <60s |
| 워크스페이스 폴더 add/remove | 짧음 | 새 codebase handshake | 즉시 |
| chat에서 방금 편집한 파일 retrieval | 없음 (chat path) | #1 `recent_edits` overlay | 0s |

### 17.17 quanta 흡수 시사 — drift 방어 패턴만 베끼기

quanta는 서버 없으니 #3/#4 (서버 주도 reconciliation) 직접 적용 불가. 베낄 가치:

- **★ #1 `recent_edits` overlay 패턴**: chat path에서 모델이 stale 안 보게 — agent가 방금 편집한 파일의 before/after를 다음 prompt에 in-band 첨부. 인덱스가 stale해도 chat은 fresh. **인덱스 latency를 chat-level에선 0으로 만드는 1급 패턴**.
- **★ watcher = hint, periodic recon = truth** 사상: quanta가 로컬 인덱스 만들 거면, FS watcher만 믿지 말고 주기적 *재해시 + 비교* 루프 필수 (Cursor는 60s, quanta는 더 자주도 가능 — 로컬이라).
- **race lock 4-timer** 패턴: 동시 sync 방지하는 in-flight check + skip + log.
- **delete 별도 timeout**: short batch (3min) vs full sync (30min) 분리.
- **CC degradation**: oversized 파일은 silent skip + 로그만, 에러 안 던짐 (가용성 우선).
- **rate-limit aware concurrency halving**: 자작 controller로 부하 자가 조정.

**흡수 부적합** (서버 종속):
- simhash 기반 cross-user dedup (혼자 쓰는 사람용 의미 없음)
- `do_copy:true` 핸드셰이크 (서버 인덱스 공유)
- `responseSizeLimitExceeded` re-queue 프로토콜 (대화형 RPC)

### 17.18 한 줄 결론
**Cursor의 drift 방어는 "이벤트를 안 믿는다" 사상 — FS watcher는 힌트일 뿐 ground truth는 60초마다 서버 reconciliation. 빵꾸 가능 지점은 (a) oversized 파일 silent skip (의도) (b) 사용자가 명시 reindex 안 하면 catastrophic state 자체-복구 안 함 — 그래도 walk 수렴이 거의 모든 케이스 잡음. quanta가 인덱싱 만들 거면 이 사상(주기적 재해시 + recent_edits overlay)을 베끼고 인프라(simhash dedup/서버 walk)는 버려라.**
