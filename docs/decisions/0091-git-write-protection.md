# ADR-0091: git-write-protection static deny — `.git/{hooks,config}` + `.vscode` write = 코드실행 탈옥 벡터 (Cursor `cursorsandbox` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-22
- **관련**: `cursor-3.2-absorption`(on-disk audit), ADR-0070(review-kind permission matrix, 스타일 템플릿), ADR-0069(typed tool failure, default-OFF 패턴), docs/analysis/code-agent-loop/cursor-rust-engine.md §3.2, docs/analysis/code-agent-suit/cursor-repomap.md L127.

## 맥락

Cursor의 `cursorsandbox`(`…/app/resources/helpers/cursorsandbox`, Rust Mach-O Seatbelt+Bubblewrap)는 macOS Seatbelt SBPL 프로파일에 **write deny-regex**를 박아둔다. ✓ verbatim 검증된 deny 대상:

```
.git/hooks   .git/config   .vscode   .cursorignore   *.code-workspace
```

(`.cursor/`는 부분 deny + `rules|commands|worktrees|skills|agents` whitelist.) ⚠️ 정정: 과거 분석의 "preflight symlink 탐지로 `.git/hooks` 탈옥 차단"은 **틀림** — symlink는 *resolve*만 하고(`sandbox: found symlink:`), 실제 차단은 **deny-regex**가 한다(rust-engine §3.2, repomap L127). 차단 메커니즘은 정정됐지만 흡수 타겟(이 경로들의 write를 막는다) 자체는 유효하다.

이 경로들은 **데이터 파일이 아니라 코드/정책 파일**이다. write가 곧 임의 코드 실행이다:

- `.git/hooks/**` — git이 다음 git 작업(`pre-commit`/`post-checkout`/`pre-push`/…)에서 **자동 실행**한다. 에이전트가 `.git/hooks/pre-commit`을 쓸 수 있으면, 이후 *사용자가* 친 git 명령(에이전트 샌드박스 밖) 한 번으로 호스트에서 임의 코드가 돈다. 정통 샌드박스 탈옥.
- `.git/config` — `core.hooksPath`/`core.fsmonitor`/`core.pager`/`core.editor`/`[alias]`/`[filter "…"].clean|.smudge` 가 전부 git이 실행할 실행파일을 지정한다. config write는 hook 재배치·command shim 설치의 간접 경로 → 같은 결과.
- `.git/hooks`(디렉터리 자체) — 디렉터리를 symlink/교체로 통제하면 그 내용을 통제하는 것과 같다.
- `.vscode/**` — `tasks.json`/`launch.json`은 에디터가 auto-run하는 셸 커맨드라인을, `settings.json`은 툴 바이너리 경로를 담는다. 에디터 주도 실행으로 같은 클래스.

quanta는 OS 샌드박스(Seatbelt) 없이도 도는 multi-surface(CLI/Web-Tauri/embedded). 따라서 OS-sandbox에 의존하는 Cursor와 달리 **surface-agnostic 정적 detector**가 필요하다.

## 결정

PURE·ADDITIVE·DEFAULT-OFF detector를 새 파일로 추가한다.

- **NEW** `src/permission/git-write-guard.ts`:
  - `export type GitWriteProtectReason = "git_hooks" | "git_hooks_dir" | "git_config" | "editor_config"` + `ALL_GIT_WRITE_PROTECT_REASONS`.
  - `export const gitWriteProtectReason = (relativeOrAbsPath: string): GitWriteProtectReason | null` — 순수 경로-패턴 매처. I/O 0, 상태 0.
  - `export const isGitWriteProtected = (path: string): boolean` — convenience.
  - **세그먼트 앵커 매칭**(substring 아님): 경로를 `/`·`\` 양쪽으로 split, 앞쪽 `./`·trailing slash·`//` 흡수, 통짜 세그먼트 일치만 인정. 중첩 `.git`(submodule/worktree) 전 세그먼트 스캔.
- **WIRED** `src/permission/index.ts`: append-only로 `git-write-guard` re-export 추가(export 리스트가 clean·알파벳 정렬이라 안전하게 끼움 — gate-pattern-wire 다음, inspector 앞).

`cursorsandbox`가 deny하던 `.cursorignore`/`*.code-workspace`는 **고의로 제외** — Cursor 고유 파일이고 quanta 탈옥 벡터가 아니다(`memory/cursor-3.2-absorption`의 "별도 ignore 파일 늘리지 말 것" 원칙과 일치). 보편 코드실행 벡터(`.git/{hooks,config}`)와 에디터 실행 벡터(`.vscode`)만 흡수한다.

스타일은 `src/permission/review-kind.ts`(ADR-0070) 미러: 리터럴-유니온 + `ALL_*` 런타임 배열 + `never` default exhaustive switch, sentinel/silent-normalize/`any` 없음, `exactOptionalPropertyTypes` 준수.

## 근거

- **OS 샌드박스 비의존**: 정적 경로 분류라 Seatbelt/Landlock 없이 모든 surface에서 동작. dispatch seam / permission gate가 write 타겟을 이 함수에 통과시켜 non-null이면 정적 deny.
- **세그먼트 앵커**: `.gitignore`/`git/config`/`src/config`/`.github/`/`notes/.git-stuff`/`.git/configfoo` 같은 substring 트랩이 절대 매치되지 않음 — false-deny가 합법 write를 막는 회귀를 원천 차단.
- **중첩 `.git`**: submodule·linked worktree의 `vendor/lib/.git/hooks/x`도 탈옥 벡터이므로 첫 세그먼트가 아니라 전 세그먼트 스캔.

## 대안

- **OS Seatbelt 프로파일 직접 흡수**(Codex/Cursor식): 기각(현 단계) — desktop 진출 전이고 surface-agnostic이 아님. ADR-0086은 그 상위 호환(샌드박스 도입 시 같은 deny 목록 재사용 가능).
- **substring `includes(".git/hooks")` 매처**: 기각 — `notes/.git-stuff` 등 false positive, 타입 안전·정밀도 0.
- **`.gitignore` 재사용 / glob 엔진**: 과설계 — 4개 고정 escape 벡터는 닫힌 유니온 + 세그먼트 비교로 충분.

## 결과·트레이드오프

- **얻은 것**: 호출부가 write 한 줄을 정적 deny할 수 있는 순수 seam. `never` switch로 새 벡터 추가 시 컴파일 강제. 본 슬라이스 테스트 green(아래 검증 참조).
- **비용**: detector만 추가, **아직 아무도 호출 안 함**. 효과 발생은 dispatch-seam/permission-gate wiring 후속에 달림.

## 한계 (LIMITATIONS)

- (a) **DEFAULT-OFF — 미배선**: 이 커밋은 detector만 추가. dispatch.ts/loop.ts/inspector.ts(타 트랙 소유)는 무수정. 실제 deny 집행은 후속 wiring(write 타겟 → `gitWriteProtectReason` → non-null이면 정적 deny + typed stop). 이 ADR이 그 follow-up을 문서화한다.
- (b) `*.code-workspace`/`.cursorignore`/`.cursor/*` 미흡수 — Cursor 고유, 의도적 제외(위 결정 참조).
- (c) `..` 정규화 안 함 — `..` 세그먼트는 보존되며 어떤 패턴 세그먼트와도 같지 않아 매치 유발 불가. 심볼릭 경로 정규화는 호출부 책임(이 모듈은 순수 문자열 분류).

## 불변식 영향

- **byte-identical default-OFF**: 새 순수 모듈. 호출자가 배선하기 전까지 어떤 기존 경로도 불변. 기존 테스트 전부 무수정 통과.
- **ADDITIVE only**: `src/permission/index.ts`는 append-only re-export 1블록만 추가.
- **슬라이스 격리 유지**: detector는 `@/permission`이 소유, 분류 결과는 닫힌 유니온으로만 노출.
