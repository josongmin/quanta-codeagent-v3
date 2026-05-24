# ADR-0156: LSP `applyWorkspaceEdit` Phase 2 EXDEV cross-FS fallback

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0152 (2-phase tmp+rename atomicity — EXDEV 처리를 명시적으로 follow-up 으로 미뤘던 그 부채), ADR-0143 (`applyWorkspaceEdit` v1), ADR-0141 (port + tool stub), ADR-0015 (`LspPort` base)
- **참조**:
  - `src/lsp/adapters/base.ts` — Phase 2 loop 의 `renameFile` catch 에 EXDEV 분기 추가 + `copyFile` protected seam 신설 + `isEXDEV(e)` 인라인 헬퍼 + `node:fs/promises.copyFile` import
  - `tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` — 슬라이스 E 3-case 추가 (E1 same-FS / E2 EXDEV→copy+unlink / E3 EACCES propagate) + FakeLspClient 에 `copies` / `setCopyThrow` / `copyFile` override / `committed` & `pendingTmps` 게터 갱신
  - `docs/decisions/0152-lsp-atomic-workspace-edit.md` — Follow-up 섹션의 "Cross-FS rename fallback (EXDEV)" 항목이 본 ADR 로 닫힘

## Context

ADR-0152 의 Phase 2 는 `fs.rename(tmp, target)` 의 POSIX atomicity 에 의존한다. 같은 filesystem 내부에서는 진실이지만, tmp 가 target 과 다른 mount 에 있으면 `rename(2)` 는 `EXDEV` (`cross-device link not permitted`) 로 즉시 실패한다. 발생 시나리오:

- `/tmp` 가 `tmpfs` (Linux 의 흔한 default), 워크스페이스는 디스크 mount
- 컨테이너 안에서 워크스페이스가 bind-mount, tmp 는 컨테이너 overlay
- macOS 의 `/private/var/folders/.../T/` 와 `/Users/...` 가 별 mount 인 환경 (드물지만 가능)

ADR-0152 는 명시적으로 "tmp 는 sibling 으로 워크스페이스 안에 만들기 때문에 EXDEV 가 거의 안 나지만, follow-up 으로 copy+delete fallback 을 둔다" 로 부채를 남겼다. 본 ADR 이 그것.

## Decision

Phase 2 의 per-file `renameFile` 호출 catch 에서 에러 종류를 검사:

```ts
try {
  await this.renameFile(entry.tmp, entry.target)
} catch (e) {
  if (isEXDEV(e)) {
    logger.debug("lsp: applyWorkspaceEdit EXDEV → copy+unlink fallback", { ... })
    await this.copyFile(entry.tmp, entry.target)
    await this.unlinkTmp(entry.tmp)
    continue
  }
  // 기존 비-EXDEV 분기: 1..K-1 committed + K-N tmp leftover + typed error
  throw new Error(`Phase 2 (commit) failed on "${entry.target}" ...`)
}
```

- `isEXDEV(e)`: `e instanceof Error && (e as NodeJS.ErrnoException).code === "EXDEV"` — code 만 보고 message 문자열 매칭 안 함 (i18n/locale 안전).
- `copyFile` 신규 protected seam, default `fs.copyFile` 위임 — 테스트는 fake 로 fallback 경로 firing 을 단언.
- 성공 후 `unlinkTmp` 로 leftover 청소 → 다음 호출의 Phase 0 스캔이 마주칠 stale 0건.
- fallback 자체가 실패 (디스크 풀 / 권한) 하면 별도 typed error `Phase 2 (EXDEV fallback) failed on "<target>" ...` 로 surface — 호출자 입장에선 일반 Phase 2 실패와 동일한 recovery 경로 (tmp suffix scan).
- `logger.debug` 한 줄로 EXDEV 발생을 기록 → 운영자가 tmpdir 를 같은 FS 로 옮겨 perf 회복 가능 (copy 는 rename 보다 N 배 느림 — 큰 파일에서 차이 큼).

## Hellgate (3 신규 case)

`tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` 슬라이스 E:

| case | 봉인하는 invariant |
|---|---|
| ATOM-E1 | 같은-FS rename 성공 → `copyFile` 0회 호출 (fallback 미발화 보장) |
| ATOM-E2 | rename 이 EXDEV throw → `copyFile` 1회 + `unlinkTmp` 1회 호출 + target 에 tmp content; pendingTmps 0 |
| ATOM-E3 | rename 이 EACCES (non-EXDEV) throw → fallback 미발화, 기존 `Phase 2 (commit) failed` 에러 그대로 propagate, tmp 1개 leftover |

`FakeLspClient` 갱신:
- `copies: { from, to }[]` 수집
- `setCopyThrow(fn)` 으로 fallback 자체 실패 시뮬레이션 가능 (E3 에서 직접 쓰진 않지만 future case 대비 hook 보존)
- `copyFile` override → `copies` push
- `get committed()` 가 rename + copy 모두 반영
- `get pendingTmps()` 가 copy 후 tmp 도 cleared 로 간주

`errnoError(message, code)` 헬퍼로 Node `ErrnoException` 형태 (`.code` 필드) 합성.

## Caveat

`fs.copyFile` 의 atomicity 는 FS 의존:
- 대부분의 modern FS (ext4 / APFS / NTFS / XFS) 는 새 inode 에 write 후 atomic-replace 로 동작 → reader 는 pre 또는 post content 만 봄.
- 일부 오래된/예외적 FS 는 partial-write window 가 존재할 수 있음 (write 도중 reader 가 끼면 절반-쓰인 파일을 봄). 본 ADR 은 이 케이스를 **수용 가능한 trade-off** 로 분류:
  - cross-FS edit 자체가 비-steady-state (운영자가 tmpdir 를 잘못 둔 환경)
  - 대안 (block / async migrate) 의 복잡도가 훨씬 큼
  - log line 으로 운영자가 즉시 인지 + 교정 가능

`copyFile` 은 또한 rename 과 달리 **새 mtime** 을 만든다. file-watcher (esbuild / vite) 가 이 차이로 한 번 더 reload 할 수 있음 — 본 ADR 의 fallback 경로에서는 OK (drop-in atomicity 보장이 우선).

## Alternatives rejected

1. **거부 (block 사용자)** — EXDEV 면 edit 실패. 사용자는 LSP refactor 가 안 됨에 놀라며 root cause (FS mount 경계) 를 모름. 운영성 최악. 기각.
2. **백그라운드 async migrate** — daemon 이 tmpdir 를 자동 co-locate. 복잡도 (FS sniffing + concurrent migration safety + permission) vs ROI 가 안 맞음. 기각 (단, follow-up 의 "tmpdir 자동 선택" 으로 별도 트랙 가능).
3. **rename 전에 statfs 로 mount 검사** — Node 에는 portable `statvfs` 없음 (Linux 만). copy 시도 후 EXDEV 잡기와 동등 + 더 단순. 기각.
4. **Phase 1 에서부터 cross-FS 라면 tmp 를 target dir 안에 두기** — Phase 1 이 이미 그렇게 하고 있음 (`${target}.quanta-tmp-${sid}-${rand}` = target 의 sibling). cross-FS EXDEV 는 target dir 가 별 mount 인 게 아니라 **`fs.copyFile` 이 새 FS 의 다른 위치를 가리킬 때**가 아니라 — 본 시나리오에서는 발생 안 함. 그래도 실 환경의 케이스 (path normalization / symlinked tmpdir) 에서는 가능 → fallback 유지.
5. **Phase 2 실패 시 Phase 1 처럼 일괄 rollback** — ADR-0152 의 Alternatives rejected #5 와 동일 사유 (원본 prev state 미보존). 기각.

## SOTA++ 자리매김

| 시스템 | cross-FS atomic write 모델 |
|---|---|
| VSCode | `vscode.workspace.fs.writeFile` → 내부적으로 tmp+rename, EXDEV fallback 동일 패턴 (Electron Node fs 위) |
| Codex 0.131 | `apply_patch` V4A 자체 write — atomicity 보장 없음 (단순 write) |
| Claude Code 2.1 | bash `mv` 우회 — cross-FS 시 `mv` 가 내부적으로 copy+unlink 하지만 atomicity 비보장 |
| **quanta** (본 ADR) | rename try → EXDEV → copyFile + unlinkTmp + debug log; non-EXDEV 는 기존 typed error 그대로 |

## Follow-up

- **tmpdir co-location heuristic (auto-pick same-FS tmpdir per workspace)** — Phase 1 에서 tmp 의 parent 를 target 의 parent 로 고정 (현재 그렇지만 symlink/mount 경계가 있으면 깨질 수 있음). 워크스페이스 시작 시 `rename(probe_tmp, probe_dst)` 한 번으로 same-FS 검증 후 cache.
- **OTel attribute** — `lsp.apply_edit.exdev_fallbacks` counter (Phase 2 에서 fallback 이 몇 번 발화했는지) → 운영 대시보드에서 mount 문제 조기 탐지.
- **`fsync` 추가** — Phase 1 의 tmp write 후 + Phase 2 의 copy 후 모두 `fsync(2)` 호출하면 crash-safety 가 한 단계 더 올라감. cost vs ROI 별도 측정 (ADR-0152 Follow-up 과 합쳐서).
