# ADR-0152: LSP `applyWorkspaceEdit` 2-phase temp+rename atomicity

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0143 (`applyWorkspaceEdit` v1 — per-file 순차 write, mid-way 실패 시 partial state caveat 봉인), ADR-0141 (4 sibling port + tool stub), ADR-0015 (`LspPort` base)
- **참조**:
  - `src/lsp/adapters/base.ts` — `applyWorkspaceEdit` body 2-phase 로 교체 + `renameFile` / `unlinkTmp` / `listDir` 3 protected seam 추가 + `cleanupStaleTmps` 헬퍼 + `node:crypto.randomBytes` / `node:fs/promises` (rename/unlink/readdir) import
  - `tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` — 10-case 신규 hellgate (Happy 3 + Phase 1 rollback 3 + Concurrency 2 + Cleanup 2)
  - `tests/unit/lsp-real-adapters-hellgate.test.ts` — 기존 D1-D4 + E3 를 신 semantics 로 갱신 (`c.committed` 게터로 post-rename 상태 검증; 기존 `c.writes` 는 Phase-1 tmp paths 만 보유)

## Context

ADR-0143 의 `applyWorkspaceEdit` 는 per-file 순차 `Bun.write` 였다. 5 파일 edit 중 3번째에서 disk full / permission 변경 / 디렉토리 삭제 가 나면 파일 1-2 는 이미 수정된 채로, 파일 3-5 는 옛 상태로 남는다. = **partial workspace state** — refactoring 도구에서 가장 안 좋은 결과 (build broken + git status 가 inconsistent).

ADR-0143 자체가 "v2 follow-up: temp+rename + 2-phase" 로 마킹해 둔 부채.

## Decision

전 슬라이스를 단일 `applyWorkspaceEdit` 호출 안에서 **all-or-(almost-)nothing** 으로 commit. 3-phase:

### Phase 0 — best-effort 잔여 tmp 청소 (호출 시작)

각 edit 의 target dir 을 unique 화 → `listDir(dir)` 로 entry 나열 → suffix `*.quanta-tmp-${sessionId}-*` 매칭 entry 만 `unlink`. 다른 sessionId 의 tmp 는 **건드리지 않음** (다른 동시 op 의 in-flight 일 수 있음). 모든 에러 swallow — Phase 0 가 legitimate edit 을 막아선 안 됨.

### Phase 1 — prepare (tmp 일괄 write)

각 doc 에 대해:
1. `readFileText(target)` → original
2. `applyEditsToText(original, doc.edits)` → patched (ADR-0143 의 reverse-offset 헬퍼 그대로)
3. `tmp = ${target}.quanta-tmp-${sessionId}-${randomBytes(4).hex}`
4. `writeFileText(tmp, patched)`

**랜덤 hex suffix가 중요**: 같은 sessionId 로 같은 파일에 2개 op 가 병렬 진입해도 tmp 가 다르므로 서로의 buffer 를 클로버 안 함.

**Phase 1 실패 시 (어느 파일에서든)**: 지금까지 prepare 한 tmp 전부 `unlink` (errors swallowed — Phase 1 의 본질은 "원본 0 건드림") 후 원래 에러 re-throw. **원본 파일 0개 수정** = workspace 무손상.

### Phase 2 — commit (atomic rename per file)

`fs.rename(tmp, target)` 을 순차 호출. POSIX `rename(2)` 는 **같은 FS 내에서 atomic** (Linux/macOS 공통; LSP edit 는 보통 workspace 안 → tmp 도 같은 워크스페이스 sibling → 같은 FS 가 steady-state).

**Phase 2 가 K/N 번째에서 실패**: 1..K-1 originals 는 commit 완료; K-N tmps 는 disk 에 남음 (`.quanta-tmp-<sid>-*` 으로 식별). 호출자에게 typed error:

```
LSP applyWorkspaceEdit Phase 2 (commit) failed on "<target>" (K-1/N files renamed, M tmp file(s) remain): <orig>
```

Caller 는 tmp suffix scan 으로 recovery 가능 (다음 호출의 Phase 0 가 자동 청소).

### 시그니처

```ts
applyWorkspaceEdit(
  edit: CodeActionWorkspaceEdit | RenameWorkspaceEdit,
  sessionId: string = randomBytes(8).toString("hex"),
): Promise<void>
```

기본값이 per-call 랜덤이라 호출자가 sessionId 를 안 주면 자연스럽게 격리됨. 동일 logical session 의 여러 edit 을 한 묶음으로 보고 cleanup 을 일관되게 하고 싶다면 명시 주입.

## Hellgate (10 신규 case + 4 갱신)

`tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts`:

| 슬라이스 | case | 봉인하는 invariant |
|---|---|---|
| A. Happy 2-phase | ATOM-A1 | 3-file 성공 → 모두 commit + tmp 잔여 0 + write path 는 tmp suffix / rename to 는 original |
| | ATOM-A2 | Phase 1 도중 peek 시 commit 0 (rename 전 까지 visibility 없음) |
| | ATOM-A3 | Phase 1 후 / Phase 2 전 사이 pendingTmps 1개, rename 후 0개 |
| B. Phase 1 rollback | ATOM-B1 | 3 중 2번째 write 실패 → renames 0, committed 0, file-1 tmp `unlink` 됨 |
| | ATOM-B2 | 1 of 1 즉시 실패 → writes 0 / unlinks 0 (말 그대로 noop) |
| | ATOM-B3 | Phase 1 통과 후 Phase 2 의 2/3 번째 rename 실패 → 1 commit + 2 pendingTmps + 메시지에 `Phase 2`/`r2.ts`/`1/3 files renamed`/`2 tmp file(s) remain`/EXDEV 포함 |
| C. Concurrency | ATOM-C1 | 다른 sessionId 병렬 → 서로 다른 tmp suffix; 둘 다 commit |
| | ATOM-C2 | 같은 sessionId 같은 파일 병렬 → 랜덤 hex 가 tmp 충돌 방지; writes 2개, rename 2개 |
| D. Cleanup | ATOM-D1 | dir 의 `*.quanta-tmp-<sid>-*` 잔여 sweep; 다른 sid 의 tmp 는 보존 |
| | ATOM-D2 | 잔여 없으면 unlinks 0 + 정상 commit |

`tests/unit/lsp-real-adapters-hellgate.test.ts` (기존):
- D1-D4 + E3 는 `c.writes[0]?.path === a` (직접 target) 단언을 → `c.committed.get(a)` (post-rename) + tmp suffix 인지 패턴으로 갱신.
- `FakeLspClient` 는 `renameFile` / `unlinkTmp` / `listDir` 도 override + `get committed()` / `get pendingTmps()` 게터 제공.

전부 in-memory (실 FS 의존 0).

## Alternatives rejected

1. **Single FS transaction** — POSIX 에는 multi-file atomic op 없음 (`rename` 은 per-call atomic, multi-file 아님). Btrfs/ZFS snapshot 은 portable 하지 않음. 기각.
2. **백업 원본 먼저 (original → `.bak`, 새것 → original)** — 디스크 사용량 2x; 실패 시 두 단계 rollback 필요 (.bak → original) + .bak 가 leftover 면 다음 호출에서 혼란. tmp+rename 보다 복잡 + 더 큰 IO. 기각.
3. **SQLite-like WAL** — N 파일 edit 을 WAL replay 로 → FS 단순 rename 보다 1-2 차수 더 복잡; LSP edit 은 보통 ≤10 파일이라 over-engineering. 기각.
4. **Lock file** (`<target>.lock` 으로 동시 edit 차단) — POSIX advisory lock 은 협력적 (강제 아님); cross-process 라면 portable 보장 약함. 랜덤 suffix 가 collision 방지 + lock 의 stale 청소 비용 없음. 기각.
5. **Phase 2 실패 시 Phase 1 처럼 rollback** (이미 rename 된 파일을 원본으로 되돌리기) — 원본 -> tmp 의 역 rename 이 가능하려면 원본의 prev state 가 어딘가 보존돼 있어야 함 (= Alternative 2 의 .bak 디자인 회귀). Phase 2 자체가 atomic per file 이므로 K/N partial 은 드물고 (cross-FS EXDEV 가 거의 유일), tmp suffix scan 으로 사람/스크립트 recovery 가 가능. 기각 — 복잡도 vs ROI.

## SOTA++ 자리매김

| 시스템 | applyWorkspaceEdit 모델 |
|---|---|
| VSCode LSP client | tmp+rename + WorkspaceEdit transaction (UI level 에서는 모든 변경 묶음 undo 가능; 디스크 level 은 본질적으로 같은 패턴) |
| Codex 0.131 | `apply_patch` 의 V4A 그래머 — 별도 patch 형식 + own write 패스 (LSP wire 미사용) |
| Claude Code 2.1 | bash 우회 (`sed`/`mv`) — atomicity 보장 없음 |
| **quanta** (이번 ADR) | 2-phase tmp+rename + 랜덤 suffix concurrency safe + Phase 0 cleanup + typed error on partial-commit |

## Follow-up (이 ADR 이 닫지 않음)

- **Cross-FS rename fallback (EXDEV)** — `rename(2)` 가 EXDEV 면 copy+delete 로 fallback. tmp 의 의도가 "원본과 같은 FS sibling" 인 이상 보통 안 발생하지만, `/tmp` ↔ workspace mount 경계 시 발생 가능. v3 후속.
- **Phase 1 후 fsync** — write 직후 `fsync(2)` 호출로 crash 후 부분-write 방지. 현재 OS page cache 에 의존; 일반 워크로드에는 충분하나 power loss 시 tmp 가 0 bytes 가능. fsync 비용 (수 ms/파일) vs ROI 별도 측정 필요.
- **Phase 2 partial 자동 recovery** — 다음 호출의 Phase 0 가 같은 sessionId tmps 를 청소하는 만큼, 실패한 호출의 "이미 rename 된 파일들" 을 복구하려면 별도 manifest 가 필요. 본 ADR 은 typed error + tmp 잔여만 → 사람이 의사결정.
- **OTel attribute** — `lsp.apply_edit.phase` / `lsp.apply_edit.files_committed` / `lsp.apply_edit.pending_tmps` span tag.
- **`workspace/applyEdit` server-initiated reverse RPC** — ADR-0143 follow-up 유지; 본 ADR 의 2-phase 로직은 server-initiated 도 그대로 재사용.
