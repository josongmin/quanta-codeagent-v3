# ADR-0137: Document readers extensions — YAML / PDF (native attachment) / XLSX (stub)

- **상태**: Accepted (yaml + pdf shipped; xlsx deferred to ADR-0138 deps decision)
- **날짜**: 2026-05-24
- **관련**: ADR-0126 (read_image — typed-attachment via ToolResult.images; magic-byte SSOT precedent), ADR-0147 (document slice — csv + ndjson sibling; renumbered from ADR-0133)
- **참조**: `src/tool/document/{yaml-read,pdf-read,xlsx-read}.ts`, `tests/unit/tool/{yaml,pdf,xlsx}-read-hellgate.test.ts`

## 맥락

ADR-0147 (renumbered from ADR-0133)이 text-format 구조화 데이터(`csv_read` / `ndjson_read`)를 봉인했다. 남은 큰 gap:
1. **YAML** — config 파일의 de-facto 표준. 단순 dep 추가로 해결.
2. **PDF** — 비텍스트 + 텍스트 혼합. 모든 SOTA가 client-side text 추출 lib(`pdf-parse`/`pdfjs`)에 의존하지만 **Anthropic API는 native document content-block 지원**(claude-3.5+). lib 없이 base64 PDF를 그대로 attachment로 보내면 모델이 vision+text+form 모두 native 처리.
3. **XLSX** — 큰 dep(SheetJS ~10MB native binding) 필요. deps decision deferred.

## 결정

### Part 1 — `yaml_read` (pure-TS dep `yaml@2.x`)
- `bun add yaml` (50KB, eemeli/yaml, YAML 1.2 strict + lenient mix).
- 경로 안전: ADR-0126 패턴 mirror (lstat symlink-leaf reject + `..` 차단 + absolute = explicit consent).
- 출력: YAML → 2-space JSON.stringify (단일 canonical agent surface).
- 옵션: `maxKeys` (default 200, max 5000) — anchor/merge expansion으로 key 폭발 차단.
- READ-ONLY + concurrency-safe.

### Part 2 — `pdf_read` (Anthropic native document-block)

`src/llm/types.ts`:
```ts
export interface DocumentBlock {
  type: "document"
  data: string                 // base64
  mediaType: string             // e.g. "application/pdf"
}
// ContentBlock union now: TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock | DocumentBlock
```

`src/tool/types.ts`:
```ts
ToolResult {
  ...,
  documents?: DocumentBlock[]   // ADR-0137 sibling of ADR-0126 images?
}
```

`src/tool/types.ts` `contentBlocks?:` (ADR-0126 wire) extended to include `DocumentBlock`. dispatch wire (W1 round, ADR-0121+0126) automatically composes documents into the next user message's tool_result content via `composeToolResultContent`.

`pdf_read` 도구:
- Input: `{path: string}`.
- 경로 안전 + **magic-byte SSOT**: `%PDF-` (0x25 0x50 0x44 0x46 0x2D). PNG의 .pdf 확장자 spoofing 차단.
- 32MB cap (Anthropic Messages API document-block 한계).
- 출력: `{ok:true, output:"Read PDF: <path> (N bytes, M base64 chars)", documents:[{type:"document", data:base64, mediaType:"application/pdf"}]}`.
- READ-ONLY + concurrency-safe.

→ **client-side PDF lib 0**. Claude가 native로 vision+text+form 처리 (scanned PDF도 OCR 없이).

### Part 3 — `xlsx_read` (typed stub, ADR-0138 deps decision deferred)

`src/tool/document/xlsx-read.ts`:
- Tool surface 봉인 (name/inputSchema/READ-ONLY 메타데이터 모두 정상).
- `execute()` → typed 메시지: `"xlsx_read not yet implemented — deps decision deferred to ADR-0138"`.
- 단순 stub지만 caller가 도구 표면을 의존할 수 있음 → 다음 라운드에서 impl swap이 byte-identical.

## Default-OFF

3 도구 모두 barrel에서 export, **defaults 미등록**. 이유:
- `read_image` + `web_fetch` 정착 후에야 mode-mutating-table 동기화 안전 (atomic-PR 패턴, W5 round).
- xlsx는 stub이라 noisy.
- caller가 한 번에 셋 다 등록할 수 있게 deferred.

## Hellgate (26 cases)

- **yaml_read** 12: 메타 3 / happy 4 (anchor+ref expand 포함) / 경로 안전 4 / 결정성 1
- **pdf_read** 11: 메타 3 / 매직 sniff 3 (PNG spoofing 차단) / happy 1 (minimal PDF byte fixture) / 가드 4
- **xlsx_read** 3: 메타 1 / input 검증 1 / 정확한 deferral 메시지 1

총 26 pass / 0 fail.

## Alternatives rejected

1. **lib-based PDF text extraction (`pdf-parse`/`pdfjs-dist`)** — vision 손실 + scanned/form-only PDF 미지원. Anthropic native attachment이 우월.
2. **`xlsx_read`에서 SheetJS 즉시 추가** — 10MB+ dep + native binding. 별도 ADR-0138에서 deps trade-off 결정.
3. **`yaml.org/Wasm` 파서** — `yaml@2.x` pure-TS면 Wasm overhead 불필요.
4. **`images?` 필드에 PDF 끼워넣기** — media type 혼동. sibling `documents?` 깔끔.
5. **xlsx 자동 CSV 변환** — 데이터 손실 (formula/format/sheet 분리). stub이 honest.
6. **PDF 텍스트 페이지별 추출 + truncate** — 이미 cap 32MB로 다룸; truncation은 PDF 단위가 무의미 (model이 page 선택).

## Security

- **Magic-byte SSOT** (PDF spoofing 차단; ADR-0126 pattern).
- **Path safety**: leaf-symlink reject + `..` 차단 (relative); absolute는 explicit consent (csv_read와 동일 posture).
- **Size cap**: PDF 32MB (Anthropic 한계). YAML output cap 50KB.
- **plane-clean**: 3 도구 모두 `@/agent`/`@/permission`/`@/storage` 0 import.

## SOTA++ 자리매김

| Agent | YAML | PDF 처리 | XLSX |
|---|---|---|---|
| Cursor | ❌ | lib-based extract | ❌ |
| Claude Code 2.1 | partial | **native document-block** | ❌ |
| Codex | ❌ | lib-based extract | ❌ |
| v0.dev | ❌ | ❌ | ❌ |
| **quanta (now)** | **✅ pure-TS dep** | **✅ native attachment + magic-byte SSOT** | stub (deferred) |

= "lib-free PDF (vision+text+form 모두 native), magic-byte SSOT로 spoofing 차단, type-safe DocumentBlock 도입한 첫 자체 호스트형 agent".

## Follow-up

- **ADR-0138**: xlsx deps 결정 (SheetJS vs exceljs vs custom OOXML vs deferred indefinitely).
- **defaults 등록**: 3 도구 모두 `buildDefaultTools()` + `MUTATING_TOOL_TABLE` 추가 (atomic, mode-mutating-table 갱신 동시).
- **`read_pdf_url`**: web_fetch + pdf_read 결합 (ADR-0146 read_image_url 패턴 mirror; renumbered from ADR-0132).
- **OCR scanned PDFs**: native attachment이 이미 처리하지만 explicit OCR mode 옵션.
- **Multi-page PDF page-range**: 큰 PDF에서 특정 페이지만 attach.
- **YAML multi-document** (`---` 구분 stream): 현재 첫 document만 파싱; multi-doc 지원은 follow-up.
