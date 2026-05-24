# ADR-0141: LSP 4-tool 확장 — code-action / rename-apply / format / signature-help

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0015 (Codex `may-20-codex-lsp.md` 흡수 — 8 nav tools, `LspPort` 도입), ADR-0119 (shadow tools — `always-confirm` HITL 시그니처 패턴 참조), ADR-0140 (placeholder)
- **참조**:
  - `src/lsp/ports/{code-action-port,format-port,signature-help-port,rename-apply-port}.ts` — 신규 canonical ports (4 file)
  - `src/lsp/adapters/{default-code-action,default-format,default-signature-help}.ts` — 신규 default adapters (3 file; `not-implemented` stub)
  - `src/tool/lsp_nav/{code-action,rename-apply,format,signature-help}.ts` — 신규 tool factories (4 file; 각자 duck-typed mirror port 포함)
  - `src/lsp/index.ts` — barrel re-export 확장 (canonical ports + default adapters)
  - `src/tool/lsp_nav/index.ts` — barrel re-export 확장 (4 tool + 4 mirror port)
  - `tests/unit/tool/lsp-{code-action,rename-apply,format,signature-help}-hellgate.test.ts` — 60 case hellgate (15 / 16 / 14 / 15)

## Context

ADR-0015 가 흡수한 `LspPort` 8 nav 표면 (definition / references / hover / typeDefinition / implementation / documentSymbol / workspaceSymbol / prepareRename) 은 **read-only 탐색**까지만 다룬다. 모델이 실제로 mutate 하려면:

1. **code action** — quickfix / refactor / organizeImports / fixAll 을 제안받고 골라서 적용
2. **rename apply** — `prepareRename` (probe) 다음의 진짜 `textDocument/rename` 실행 + workspace edit 적용
3. **format** — whole-file 또는 selection range 포매팅
4. **signatureHelp** — function call 안 cursor 위치에서 overload / active parameter 표시

네 가지를 `bash` 로 모델이 자기 손으로 raw git / sed 로 흉내내야 했고, 그 경로엔 HITL gate 도 typed-error 도 없다. ADR-0119 의 shadow_rewind 와 정확히 같은 trap.

본 ADR 은 네 port + 네 tool 을 **첫-class agent surface 로 정식 노출**한다. 단, 현재 `LspClient` (`src/lsp/adapters/base.ts`) 가 wire 단 method 를 노출하지 않으므로 default adapter 는 의도적으로 `not-implemented` throw — tool 은 잡아 typed `ok:false` 로 변환. assembly seam (= 실제 wire 연결) 은 후속 ADR.

## Decision

8 part. 전부 새 surface 추가 — 기존 코드 mutation 0 (barrel 두 줄, surgical append).

### Part 1 — `src/lsp/ports/` 신규 디렉토리 (4 file)

`src/lsp/ports.ts` (= `LspPort`, ADR-0015) 는 손대지 않는다 (in-flight nav 계약 churn 0). 새 ports 는 디렉토리에 sibling 파일로:

- `code-action-port.ts` — `CodeActionPort { resolveCodeActions(file, line, col, kind?) → CodeAction[]|null, applyEdit(edit) }`. `CodeAction = { title, kind, edit? }`, `CodeActionKind` 닫힌 9-value 유니온 (`quickfix`/`refactor`/`refactor.extract`/`refactor.inline`/`refactor.rewrite`/`source`/`source.organizeImports`/`source.fixAll`/`other`). `WorkspaceEdit` 은 v1 에서 `changes` 만 (per-document edits). `documentChanges` (rename/create/delete file) 는 의식적 follow-up.
- `format-port.ts` — `FormatPort { format(file, range?) → TextEdit[]|null }`. `range` 부재 ⇒ whole-file (`textDocument/formatting`). 부재 시 v1 에서 conditional-spread 로 ABSENT 유지 (exactOptional strict).
- `signature-help-port.ts` — `SignatureHelpPort { signatureHelp(file, line, col) → SignatureInfo[]|null }`. `SignatureInfo = { label, documentation?, parameters[], activeParameter? }`.
- `rename-apply-port.ts` — `RenameApplyPort { computeRename(file, line, col, newName) → WorkspaceEdit|null, applyEdit(edit) }`. Two-step (compute → apply) 로 progress 에 preview 보여주고 HITL gate 통과 후 apply. 기존 `LspPort.prepareRename` 은 단순 probe — 의도적 별도 port (재사용 불가; 시그니처 다름).

전부 plane-clean: `@/agent` / `@/permission` / SDK import 0.

### Part 2 — `src/lsp/adapters/default-*.ts` 신규 (3 file)

- `default-code-action.ts` — `DefaultCodeActionAdapter implements CodeActionPort`. `resolveCodeActions` + `applyEdit` 둘 다 `throw new Error("not-implemented: …")`. 후속 ADR 에서 `LspClient.sendRequest("textDocument/codeAction", …)` 로 교체.
- `default-format.ts` — 동일 posture.
- `default-signature-help.ts` — 동일 posture.

`RenameApplyPort` default adapter 는 미작성. rename 은 destructive — wire 가 없으면 tool 이 등록되지 말아야지 default 가 silent stub 으로 떠 있는 건 위험 (ADR-0119 의 default-OFF 원칙). 사용자가 의식적으로 real adapter 박을 때만 활성.

### Part 3 — 4 tool 신규 `src/tool/lsp_nav/`

| tool | isReadOnly | concurrencySafe | hitlTier |
|---|---|---|---|
| `lsp_code_action` | true | true | (none — inferred) |
| `lsp_rename_apply` | false | false | **`always-confirm`** |
| `lsp_format` | false | false | **`pre-approval-ok`** |
| `lsp_signature_help` | true | true | (none — inferred) |

각 tool 파일은:
1. **duck-typed mirror port** 를 in-file 로 선언 — `@/tool` 는 `@/lsp` 를 import 할 수 없다 (RFC §3.1 slice fence, biome 강제). 정식 port 는 `@/lsp/ports/` 의 canonical, 테스트 fake 가 구조적으로 둘 다 만족.
2. **input schema** — 1-based line/character (LSP wire 는 0-based; tool 이 변환).
3. **abort + invalid input + port-throw** 일관 처리 — `aborted before start` / `invalid input: …` / `<tool_name> unavailable: …`.
4. **deterministic output formatting** — null/empty/non-empty 3-way branch + singular/plural pluralization.

### Part 4 — `src/lsp/index.ts` barrel 확장

`export type { LspPort } from "./ports"` 다음에 ADR-0141 expansion 블록 추가: 3 default adapter + 4 canonical port (and their nested types).

### Part 5 — `src/tool/lsp_nav/index.ts` barrel 확장 (SURGICAL)

기존 `formatHover` / `formatLocations` / `formatRenamePreview` / `formatSymbols` re-export + `lspNavTools(provider)` 8-tool factory 는 손대지 않음. 새 ADR-0141 expansion 블록 추가: 4 tool + 4 mirror port + 4 schema/input type.

`lspNavTools` 시그니처는 의도적 유지 (`provider: LspNavProvider` 단일 인자 — 새 4 tool 은 각자 별개 port). 만약 한 factory 로 합치면 caller 가 4 port 모두를 줘야 하는데, 그건 default-OFF 등록 패턴 (= 미주입 시 미등록) 과 충돌. 4 tool 은 caller 가 의식적으로 1-by-1 박는다.

### Part 6 — assembly 미장치

`src/agent/lsp-bridge.ts` 미장치. 사용자가 `LspClient` 에 wire methods 박은 후 후속 ADR 에서 진짜 adapter + tier1 wiring.

### Part 7 — 60-case hellgate (각 tool 14-16 case)

`tests/unit/tool/lsp-*-hellgate.test.ts` 4 file:
- **A. metadata** — name / isReadOnly / isConcurrencySafe / hitlTier (해당 시)
- **B. input validation** — schema 거부 케이스 (missing path / line=0 / unknown enum / empty newName / partial range)
- **C. port conversion** — 1-based → 0-based propagation + optional field passthrough (`exactOptionalPropertyTypes` 엄수 — `kind` / `range` 부재 시 ABSENT)
- **D. output formatting** — null / empty / non-empty 3-way; pluralization (`1 signature` vs `2 signatures`); active-param marker
- **D'. (rename) apply branches** — null edit ⇒ apply NOT called; empty changes ⇒ apply NOT called + ok:true; non-empty ⇒ apply called with SAME edit object
- **E. error & signal** — port throw → `<tool_name> unavailable: …` / apply throw → `applyEdit failed: …` / abort → `aborted before start` + port NOT called
- **F. determinism** — same input + same fake ⇒ byte-identical output

모든 케이스 hand-rolled fake port — 실 LSP server / 실 FS 의존 0. **60 pass / 0 fail / 123 expect()**.

### Part 8 — slice fence 유지 (RFC §3.1)

- 4 tool 파일: 오직 `zod` + `../types` + in-file mirror port. No `@/agent`, `@/permission`, `@/lsp`, `@/storage`.
- 4 canonical port 파일: import 0 (셀프 컨테인드).
- 3 default adapter: 오직 `../ports/<port>` import.

biome 의 `@/tool` override 가 `@/lsp` 를 금지 — 컴파일 타임 강제. mirror drift 는 consumer-side test 가 (tests 디렉토리에서 둘 다 import 가능) 잡는다.

## HITL 설계

| tool | tier | 사유 |
|---|---|---|
| `lsp_code_action` | (none, isReadOnly inferred → `none`) | 순수 enumerate. 적용 안 함. |
| `lsp_signature_help` | (none, inferred) | 순수 query. |
| `lsp_format` | `pre-approval-ok` | 포매팅은 idempotent + 일상 작업 — 한 번 승인하고 잊는 ergonomics. mistakes cost 작음 (재포매팅으로 복구). |
| `lsp_rename_apply` | **`always-confirm`** | Destructive across files — symbol rename 은 dozens of files 건드릴 수 있고 silent overwrite cost real. `pre-approval-ok` 아님 (실수 시 batch revert 어려움). `hand-off-required` 도 아님 (보안 primitive 가 아니라 의사 확인). |

## Default-OFF posture

```
caller 가 4 port 를 의식적으로 박지 않음
  ⇒ 4 tool 미등록 (assembly seam 부재)
  ⇒ ToolRegistry byte-identical
  ⇒ 모델은 4 tool 존재 자체 모름
```

후속 ADR 에서 `src/agent/tier1/lsp-expansion.ts` per-subsystem builder + `AgentConfig.lspPorts` slot 추가 시 default-OFF gate 활성. ADR-0119 의 shadow tools 와 정확히 같은 패턴 (assembly auto-registration 없음).

## Alternatives rejected

1. **새 ports 를 기존 `src/lsp/ports.ts` 의 `LspPort` 에 8 method 더하기**
   - 기존 nav 8 method 와 mutating apply method 가 한 interface 에 섞이면 ISP 위반 — read-only consumer (예: 진단 도구) 도 apply 메서드 stub 강제됨.
   - 거부 — port 분리 (CodeActionPort / FormatPort / SignatureHelpPort / RenameApplyPort).

2. **`lspNavTools` factory 에 새 4 tool 통합 (단일 entrypoint)**
   - caller 가 단일 `LspNavProvider` 만 주면 되는 ergonomics 가 깨짐 (4 port + provider 5 객체 필요).
   - 기존 8 tool 의 `provider.open` lifecycle (per-file session) 과 새 4 tool 의 stateless port 모델이 다름.
   - 거부 — 4 tool 은 별도 factory (각 1-arg).

3. **default adapter 가 silent ok:false 반환 (throw 대신)**
   - tool 의 error-handling branch (try/catch → `<tool_name> unavailable: …`) 가 dead path 됨 — 후속 adapter 가 throw 하기 시작하면 silent breakage.
   - 거부 — `throw new Error("not-implemented: …")` 로 명시. Tool 의 catch 는 typed `ok:false` 만들고 모델은 "이 wire 안 된다" 를 분명히 알게 됨.

4. **`RenameApplyPort` 도 default adapter 제공 (silent stub)**
   - rename 은 destructive. wire 가 없으면 tool 자체가 미등록돼야지 default 가 떠 있는 건 위험.
   - 거부 — 사용자가 의식적으로 real adapter 박을 때만 활성.

5. **`lsp_format` 의 `isReadOnly: true`**
   - 의미적으로 v1 은 edit 만 surface 하고 disk 안 건드림 — readonly 같지만, semantic intent 는 mutate. 후속 iteration 에서 apply 추가 시 silent semantic drift.
   - 거부 — `isReadOnly: false` + `pre-approval-ok` HITL 으로 명시.

6. **`CodeActionKind` 유니온 닫지 않고 string passthrough**
   - 새 server-defined kind (`refactor.move`, `source.removeUnusedImports` 등) 에 미리 대비.
   - 거부 — 모델 prompt 에 정확한 enum 보여줘야 환각 줄어듬. 미지의 kind 는 `"other"` 로 매핑 권장.

7. **`lsp_rename_apply` 가 progress 에 unified diff preview 첨부**
   - 정보 풍부 — 하지만 large rename (100+ file) 시 token blowout.
   - 보류 — `progress` 는 file/edit count 만, 진짜 diff 가 필요하면 후속 ADR 에서 별도 `lsp_rename_preview` tool (read-only).

## SOTA++ 자리매김

| 시스템 | code-action | rename apply | format | signatureHelp | HITL |
|---|---|---|---|---|---|
| Cursor 3.2 | IDE 내부 — user-visible HITL surface 없음 | 동일 | 동일 | 동일 | ✗ (자동) |
| Codex 0.131 | tool 없음 (apply_patch 로 흉내) | tool 없음 | tool 없음 | tool 없음 | N/A |
| Claude Code 2.1 | tool 없음 (bash 경유) | tool 없음 | tool 없음 | tool 없음 | bash 일반 HITL 만 |
| **quanta** | **있음 — read-only enumerate** | **있음 — always-confirm + 2-step preview/apply** | **있음 — pre-approval-ok** | **있음 — read-only** | **per-tier 명시** |

= "LSP 의 mutating surface (code-action / rename / format) 를 typed agent tool 로 노출하면서 per-tool HITL tier 를 명시한 최초 OSS 구현". 60-case hellgate 로 sealed.

## Follow-up (이 ADR 이 닫지 않음)

- **`LspClient` 에 wire methods 추가** — `sendRequest("textDocument/codeAction", …)` / `sendRequest("textDocument/rename", …)` / `sendRequest("textDocument/formatting", …)` / `sendRequest("textDocument/signatureHelp", …)` + `workspace/applyEdit` (server-initiated) 의 reverse direction. ADR-0015 의 nav RPC 와 같은 normalize 패턴.
- **assembly seam** — `src/agent/lsp-bridge.ts` 에 real adapter 생성 + `src/agent/tier1/lsp-expansion.ts` per-subsystem builder + `AgentConfig.lspPorts` slot.
- **`WorkspaceEdit.documentChanges` 지원** — rename/create/delete file resource ops.
- **`lsp_rename_preview` read-only tool** — apply 전 unified-diff preview 별도 tool.
- **`lsp_code_action` apply mode** — kind 별 quick-apply (`source.organizeImports` 등 idempotent 한 것).
- **OTel attribute on tool calls** — `tool.lsp_<name>.{file, line, col, …}` span attribute.
- **`lsp_format` apply on disk** — v2 에서 edits 를 실제로 writes (현재 v1 은 summary 만).
