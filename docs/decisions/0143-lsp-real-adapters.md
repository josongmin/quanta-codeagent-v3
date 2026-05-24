# ADR-0143: LSP default-adapter 실배선 — code-action / format / signature-help / applyWorkspaceEdit

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0015 (`LspPort` 8 nav RPC 흡수), ADR-0141 (4 sibling port + tool + `not-implemented` default adapter)
- **참조**:
  - `src/lsp/adapters/base.ts` — `LspClient` 에 4 wire method 추가 (`requestCodeActions` / `requestFormatting` / `requestSignatureHelp` / `applyWorkspaceEdit`) + `writeFileText` protected seam + raw shape 6 추가 + `applyEditsToText` / `positionToOffset` 헬퍼
  - `src/lsp/adapters/default-{code-action,format,signature-help}.ts` — `not-implemented` stub → real `LspClient` 위임 (DI: 구조적 duck-typed `*LspClient` 인터페이스로 fake 가 subclass 없이 만족)
  - `tests/unit/lsp-real-adapters-hellgate.test.ts` — 29 case hellgate (`FakeLspClient extends LspClient` + scripted replier; lsp-nav-rpc 패턴 미러)

## Context

ADR-0141 이 깐 4 port + 4 tool 은 default adapter 가 `throw new Error("not-implemented: …")` 로 떠 있었다. `lsp_code_action` / `lsp_format` / `lsp_signature_help` 가 호출되면 tool 의 catch 가 `"<tool_name> unavailable: not-implemented …"` 로 변환 → 모델에 silent breakage 없이 표시되지만, **실 wire 가 없어 기능 dead**.

본 ADR 은 그 stub 을 `LspClient` 에 새로 추가한 4 wire method 로 교체. 결과: `LspClient` 를 의식적으로 주입한 caller (`new DefaultCodeActionAdapter(lspClient)`) 는 진짜 `textDocument/codeAction` / `textDocument/formatting` / `textDocument/signatureHelp` / `workspace/applyEdit` 가 동작.

## Decision

### Part 1 — `LspClient` 4 신규 wire method (`src/lsp/adapters/base.ts`)

기존 nav RPC 와 동일 패턴 (lazy `ensureOpen` → `callOrNullOnUnsupported` → `null` on `-32601`/`-32602`/"not supported" → 일반 에러 propagate):

| method | LSP wire | 정규화 |
|---|---|---|
| `requestCodeActions(file, line, col, kind?)` | `textDocument/codeAction` | `RawCodeAction \| RawCommand` 두 변종 → 9-value `CodeActionKind` 유니온. `Command` (no `edit`) → `kind: "quickfix"` + `edit` 부재. `kind` 미지 → `"other"`. |
| `requestFormatting(file, range?)` | `range` 부재 ⇒ `textDocument/formatting`, 있으면 `textDocument/rangeFormatting` | `RawTextEdit[]` → `TextEdit[]`. |
| `requestSignatureHelp(file, line, col)` | `textDocument/signatureHelp` | `RawSignatureHelp.signatures` → `SignatureInfo[]`. parameter label `[start,end]` tuple 은 signature label 슬라이스. documentation `MarkupContent` → `.value`. |
| `applyWorkspaceEdit(edit)` | (client-side write — wire 없음) | `edit.changes` (또는 `documentChanges` — 자동 정규화) 의 각 doc 에 대해 `readFileText` → `applyEditsToText` (reverse offset order) → `writeFileText`. |

`writeFileText(filePath, text)` 는 `Bun.write` 위임. `readFileText` 와 동일 patten 의 `protected` seam — 테스트가 FS 안 건드리고 fake 가능.

`applyEditsToText` 는 LSP `TextEdit[]` 을 텍스트에 적용:
- `positionToOffset(text, line, character)` 로 (line, character) → UTF-16 byte-ish offset 변환 (line=0, char=0 시작; char 가 line length 넘으면 line end 로 clamp)
- edits 를 start offset 내림차순으로 stable sort → 뒤에서부터 slice/splice → 앞쪽 offset 이 shift 안 됨

`codeActionFilterFor(kind)`: port 의 9-value 유니온 → wire 의 4-value coarse (`"quickfix"|"refactor"|"source"|"all"`). `"all"` 또는 부재 ⇒ `context.only` 생략.

### Part 2 — 3 default adapter 실배선

`DefaultCodeActionAdapter(client)`:
- 생성자: `CodeActionLspClient` (duck-typed 2-method 인터페이스 — `requestCodeActions` / `applyWorkspaceEdit`) DI.
- `resolveCodeActions(file, line, col, kind?)`: port 9-value `kind` 를 `toClientFilter` 로 wire 4-value 로 coarsen → `client.requestCodeActions` → 결과를 port-level `kind` 와 **exact match 로 narrowing** (wire 는 prefix-match 라 e.g. `"refactor.inline"` 요청 시 server 가 `refactor.extract` 도 줄 수 있음).
- `applyEdit(edit)`: `client.applyWorkspaceEdit(edit)` 위임.

`DefaultFormatAdapter(client)`:
- `format(file, range?)`: `range` 부재 ⇒ `client.requestFormatting(file)` (whole-file), 있으면 `client.requestFormatting(file, range)` (rangeFormatting). exactOptional 으로 `undefined` 안 흘림.

`DefaultSignatureHelpAdapter(client)`:
- `signatureHelp(file, line, col)`: 그대로 `client.requestSignatureHelp` 위임.

Plane-clean: 각 adapter 는 `../ports/*-port` + (DefaultCodeActionAdapter 에 한해서) duck-typed interface 만 import. `./base` 의 `LspClient` 클래스를 직접 type-import 하지 않음 — caller 가 `new DefaultCodeActionAdapter(lspClient)` 로 박을 때 구조적 매칭으로 통과.

### Part 3 — 29-case hellgate (`tests/unit/lsp-real-adapters-hellgate.test.ts`)

`FakeLspClient extends LspClient` (`lsp-nav-rpc.test.ts` 패턴 미러). `sendRequest` / `sendNotification` / `readFileText` / `writeFileText` 오버라이드 → 모두 in-memory + scripted replier. **실 server / 실 FS / 실 stdio 0 의존**.

| 슬라이스 | 케이스 수 |
|---|---|
| A. requestCodeActions | 8 (happy / empty / throw / kind filter forward / "all" omits filter / unsupported→null / unknown kind→"other" / legacy Command shape) |
| B. requestFormatting | 5 (whole-file / range / empty / null / unsupported→null) |
| C. requestSignatureHelp | 6 (happy / null / empty / line/col forward / `[start,end]` tuple label / MarkupContent doc 평탄화) |
| D. applyWorkspaceEdit | 4 (multi-file / write failure mid-way / multi-edit reverse order / documentChanges variant → changes 정규화) |
| E. adapter wiring | 6 (CodeAction kind 정밀 narrowing × 3 / Format range branch × 2 / SignatureHelp 위임 × 1) |

**29 pass / 0 fail / 51 expect**. ADR-0141 의 60 case hellgate 도 그대로 green (총 89 pass / 174 expect).

### Part 4 — barrel 변경 없음

`src/lsp/index.ts` 는 ADR-0141 에서 이미 `DefaultCodeActionAdapter` / `DefaultFormatAdapter` / `DefaultSignatureHelpAdapter` 를 export 중. 클래스 식별자 동일 + 생성자 시그니처만 변경 (1 param 추가) — caller 가 stub 을 의존하던 곳 없으니 barrel mutate 0.

## Default-OFF 유지

```
DefaultCodeActionAdapter / DefaultFormatAdapter / DefaultSignatureHelpAdapter
  ⇒ 모두 ctor 에 LspClient 필요
  ⇒ caller (assembly) 가 명시적으로 LspClient 박지 않으면 인스턴스 자체 없음
  ⇒ 4 tool 미등록 (ADR-0141 default-OFF 패턴 유지)
```

`AgentConfig.lspPorts` slot 은 아직 없음 (ADR-0141 Follow-up). 본 ADR 은 adapter 만 채움 — assembly seam 은 후속.

## LSP server 호환성

| method | typescript-language-server | pyright | 비고 |
|---|---|---|---|
| `textDocument/codeAction` | ✅ (quickfix/refactor/source 풀세트) | ✅ (quickfix 위주, refactor 제한적) | `Command`/`CodeAction` 두 변종 모두 server 별로 다름 → 둘 다 매핑 |
| `textDocument/formatting` | ✅ | ⚠️ 미지원 (pyright 는 format 안 함; Ruff/Black 분리) | unsupported → `null` 로 안전 |
| `textDocument/rangeFormatting` | ✅ | ⚠️ 미지원 | 동일 |
| `textDocument/signatureHelp` | ✅ | ✅ | 양쪽 안정 |
| `workspace/applyEdit` (server→client) | (client-side write — wire 양방향 없음) | (동일) | v1 은 client 가 직접 FS write (`Bun.write`), `workspace/applyEdit` server-initiated reverse RPC 는 v2 |

= Pyright 에 `lsp_format` 박으면 자연스럽게 `"format not supported here"` 출력 (port `null` → tool 정상 분기). 사용자에게 silent breakage 없음.

## Alternatives rejected

1. **각 tool 이 자기 `LspClient.sendRequest("…", …)` 직접 호출 (adapter 제거)**
   - tool 마다 wire decode 로직 중복; `LspClient` connection 재사용 못함 (각 tool 이 자기 `LspClient` 생성).
   - 거부 — 4 wire method 가 `LspClient` 한 군데에 + 3 adapter 가 port 매핑만.

2. **`CodeActionPort` / `FormatPort` / `SignatureHelpPort` 별로 별도 `LspClient` 인스턴스**
   - LSP server 는 connection 비싸 (spawn + initialize + capability handshake). port 별 instance 면 4 spawn → connection thrash + per-file `didOpen` 4번 중복.
   - 거부 — 단일 `LspClient` 공유, adapter 는 method delegation 만.

3. **`applyWorkspaceEdit` 를 temp-file + rename atomic 으로 v1 부터**
   - 멀티-파일 atomic 은 OS-level 2-phase commit 필요 (tmpdir 모음 → 일괄 rename). 복잡도 vs ROI 가 v1 에 안 맞음.
   - 보류 — v2 에서 `applyWorkspaceEditAtomic` 별도 method. v1 은 per-file 순차 write, mid-way 실패 시 earlier files on disk (hellgate D2 가 이 caveat 봉인).

4. **`DefaultCodeActionAdapter` 가 `LspClient` 클래스 자체를 type-import**
   - `import type { LspClient } from "./base"` 시 generic class type import — fake 가 반드시 subclass 해야 만족.
   - 거부 — duck-typed `CodeActionLspClient` interface (2 method) 로 DI → fake 는 plain object 도 가능. 구조적 호환은 컴파일러가 보장.

5. **`applyEditsToText` 가 LSP edits 를 forward order 로 적용**
   - 같은 파일에 여러 edit 시 앞쪽 edit 이 뒤쪽 offset 을 shift → 잘못된 위치 patch.
   - 거부 — reverse offset order (stable sort) + 뒤에서 slice. LSP spec 의 "edits MUST NOT overlap" 전제 위에서 안전. hellgate D3 가 봉인.

## SOTA++ 자리매김

| 시스템 | code-action wire | format wire | signatureHelp wire | applyWorkspaceEdit |
|---|---|---|---|---|
| Cursor | IDE 내부 (사용자 invisible) | 동일 | 동일 | 동일 |
| Codex 0.131 | LSP wire 없음 | 없음 | 없음 | apply_patch 로 우회 |
| Claude Code 2.1 | 없음 | 없음 | 없음 | bash 우회 |
| **quanta** | ✅ (port + adapter + tool + hellgate) | ✅ | ✅ | ✅ (per-file, v2 atomic) |

= ADR-0141 의 "agent surface 정식 노출" 을 ADR-0143 이 "실 wire 까지 완주" 로 닫음.

## Follow-up (이 ADR 이 닫지 않음)

- **`applyWorkspaceEdit` atomicity (v2)** — tmpdir + 2-phase rename. mid-way write 실패 시 earlier files 도 rollback.
- **cross-server fallback** — TypeScript 파일에 Pyright 가 박혀있을 때 (or vice versa) `null` → 다른 server retry. 현재는 per-file 1-server 가정.
- **`workspace/applyEdit` server-initiated reverse RPC** — server 가 client 에게 edit 적용 요청 (refactoring tool 이 backend 에서 시작 시). 현재 v1 은 client → server 일방향만.
- **`AgentConfig.lspPorts` slot + assembly seam** (`src/agent/lsp-bridge.ts`) — DefaultCodeActionAdapter / DefaultFormatAdapter / DefaultSignatureHelpAdapter 를 caller 옵션으로 깐 lspClient 와 자동 wire. 현재는 caller 가 1-by-1 박아야 함.
- **Pyright format fallback (Ruff/Black)** — pyright 가 `textDocument/formatting` 미지원이라 외부 formatter binary fallback.
- **OTel attribute** — `lsp.code_action.kind` / `lsp.format.range_lines` / `lsp.apply_edit.files` span tag.
