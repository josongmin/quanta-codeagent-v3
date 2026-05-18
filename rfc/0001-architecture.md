# RFC-0001: Quanta CodeAgent v3 — 아키텍처

- **상태**: Draft
- **작성일**: 2026-05-19
- **대상**: v3 처음부터 새로 만드는 코딩 에이전트
- **선행 학습**: v2가 워크플로우 기반 + 406k LoC + 87 ADR로 실패. 본 RFC는 그 반대 방향.

---

## 1. 목표

LLM이 사용자와 티키타카하며 코딩 태스크(읽기/검색/편집/테스트)를 수행하는 **ReAct 기반 에이전트**.

### 1.1 측정 가능한 성공 기준

- Phase 1 (2주): 단일 파일 편집 + 테스트 실행 사이클 작동
- Phase 2 (1개월): SWE-bench Verified 50%+ 단일 trajectory
- Phase 3 (3개월): SWE-bench Verified 70%+ (Best-of-N 포함)
- 전체 코드베이스 **20k LoC 미만 유지**

### 1.2 명시적 Non-Goals

- ❌ 결정론적 replay (LLM은 본질적으로 비결정적)
- ❌ 전체 액션 사전 정의 (closed alphabet 강박 금지)
- ❌ FSM/워크플로우 엔진 (ReAct이면 충분)
- ❌ 87개 ADR (정량 상한 10개, 코드 동작 후 작성)
- ❌ 모든 슬라이스에 ports/adapters 풀세트 (2nd impl 나올 때까지 약식)
- ❌ 컨테이너 격리 등 enterprise 안전망 (필요할 때 추가)

---

## 2. 기술 스택

| 항목 | 선택 | 이유 |
|------|-----|------|
| 언어 | TypeScript | Claude 코딩 자신감 1위 |
| 런타임 | Bun | 단일 도구 통합, 빠른 iteration, 단일 바이너리 |
| LLM SDK | `@anthropic-ai/sdk` | 공식, 1급 지원 |
| 스키마 검증 | `zod` | 도구 입력 검증, 모델 출력 파싱 |
| DB | `bun:sqlite` | 내장, 의존성 0 |
| Lint/Format | Biome | 단일 도구 |
| 타입 체크 | `tsc --noEmit` (CI만) | 개발 중엔 Bun이 알아서 |

**거부된 선택**:
- Python: v2 자산 살리기엔 좋지만 단일 바이너리·타입·DX 미달
- Rust: 컴파일 시간 너무 김
- Go: LLM 학습량 부족, idiomatic 코드 약함
- tsc 빌드: 메모리 2GB+. Bun이 대체

---

## 3. 아키텍처 — Vertical Slice + Inner Hexagonal

### 3.1 원칙

**Slice-first, Hexagonal-within**:
- 슬라이스 = 도메인 (memory, tool, llm 등)
- 슬라이스 내부에서만 hexagonal (ports/adapters)
- 구현 1개면 ports/adapters 생략 (약식)
- 2개+ 되면 추출

**의존성 방향**:
```
apps/
  ↓
agent/ (모든 슬라이스 조립)
  ↓
다른 슬라이스 (서로 모름, agent가 중재)
  ↓
shared/ (공통 타입만)
```

**규칙 (lint로 강제)**:
- `agent/`만 다른 슬라이스 import 가능
- 다른 슬라이스끼리 import 금지
- `shared/`는 누구나 import 가능
- 예외: `tool/` → `runtime/`, `memory/` → `storage/` (자연스러운 의존)

### 3.2 슬라이스 목록

| 슬라이스 | 책임 | 형태 (Phase 1) |
|---------|-----|--------------|
| **shared** | 공통 타입, 에러, 로거 | (utility) |
| **llm** | LLM 추상화 + 어댑터 | 풀 헥사고날 |
| **tool** | 도구 정의 + 레지스트리 | 풀 (Tool 인터페이스) |
| **memory** | 작업/장기 메모리 | 풀 |
| **storage** | 파일 I/O | 약식 (단일 구현) |
| **stream** | 출력/이벤트 | 풀 |
| **permission** | 정책 평가 | 약식 |
| **runtime** | 셸/샌드박스 실행 | 약식 → 풀 (sandbox 시) |
| **lsp** | 언어 서버 (P1) | 풀 |
| **observability** | 로그/메트릭 | 약식 |
| **agent** | ReAct 루프 조립 | 약식 (자체 구현) |

---

## 4. 디렉토리 구조

```
quanta-codeagent-v3/
├── src/
│   ├── shared/
│   │   ├── types.ts             # Result, Id, base types
│   │   ├── errors.ts
│   │   └── logger.ts
│   │
│   ├── llm/
│   │   ├── types.ts             # Message, ContentBlock
│   │   ├── ports.ts             # LLMPort
│   │   ├── adapters/
│   │   │   └── anthropic.ts
│   │   └── index.ts
│   │
│   ├── tool/
│   │   ├── types.ts             # Tool, ToolContext, ToolResult
│   │   ├── registry.ts
│   │   ├── bash/index.ts
│   │   ├── read/index.ts
│   │   ├── write/index.ts
│   │   ├── edit/
│   │   │   ├── index.ts
│   │   │   ├── exact.ts
│   │   │   └── fuzzy.ts         # Phase 2
│   │   ├── grep/index.ts
│   │   ├── glob/index.ts
│   │   ├── test-runner/index.ts
│   │   └── index.ts
│   │
│   ├── memory/
│   │   ├── types.ts             # MemoryEntry, FreshnessBucket
│   │   ├── working.ts           # 세션 내
│   │   ├── ports.ts             # PersistentStorePort
│   │   ├── adapters/
│   │   │   ├── sqlite.ts
│   │   │   └── in-memory.ts
│   │   └── index.ts
│   │
│   ├── storage/
│   │   ├── types.ts
│   │   ├── service.ts           # Bun.file 직접
│   │   └── index.ts
│   │
│   ├── stream/
│   │   ├── types.ts             # Event types
│   │   ├── ports.ts             # StreamPort
│   │   ├── adapters/
│   │   │   └── stdout.ts
│   │   └── index.ts
│   │
│   ├── permission/
│   │   ├── types.ts
│   │   ├── policy.ts
│   │   └── index.ts
│   │
│   ├── runtime/
│   │   ├── types.ts
│   │   ├── shell.ts             # Bun.$
│   │   └── index.ts
│   │
│   ├── lsp/                     # Phase 1.5
│   │   ├── types.ts
│   │   ├── ports.ts
│   │   ├── adapters/
│   │   │   └── pyright.ts
│   │   └── index.ts
│   │
│   ├── observability/
│   │   ├── types.ts
│   │   ├── logger.ts
│   │   └── index.ts
│   │
│   ├── agent/
│   │   ├── types.ts             # AgentConfig
│   │   ├── loop.ts              # ReAct 루프 (~300 LoC)
│   │   ├── dispatch.ts          # 도구 디스패치
│   │   ├── compaction.ts
│   │   ├── hooks.ts
│   │   └── index.ts
│   │
│   └── apps/
│       ├── cli/index.ts
│       └── bench/index.ts       # Phase 2: SWE-bench
│
├── tests/
│   ├── unit/                    # core 단위 (mock adapter)
│   ├── integration/             # 슬라이스 통합
│   └── fixtures/
│
├── rfc/                         # ← 본 디렉토리
├── docs/
│   └── decisions/               # ADR (최대 10개)
├── package.json
├── tsconfig.json
├── biome.json
├── bunfig.toml
└── README.md
```

---

## 5. 슬라이스 내부 표준 패턴

### 5.1 풀 헥사고날 (구현 2개+ 예상)

```typescript
// <slice>/types.ts        ← 도메인 타입 (외부 노출)
// <slice>/ports.ts        ← 인터페이스
// <slice>/adapters/x.ts   ← 구현
// <slice>/index.ts        ← public API (selective re-export)
```

예시 (`llm/`):
```typescript
// llm/index.ts
export type { Message, ContentBlock } from "./types"
export type { LLMPort } from "./ports"
export { AnthropicAdapter } from "./adapters/anthropic"
```

### 5.2 약식 (구현 1개)

```typescript
// <slice>/types.ts        ← 도메인 타입
// <slice>/service.ts      ← 직접 구현
// <slice>/index.ts        ← public API
```

예시 (`storage/`):
```typescript
// storage/index.ts
export type { FileInfo } from "./types"
export { readFile, writeFile, statFile } from "./service"
```

**약식 → 풀 전환 트리거**: 2번째 구현이 진짜로 필요해질 때. 추상적 가능성 X.

---

## 6. 핵심 인터페이스 (Phase 1 확정)

### 6.1 LLM
```typescript
interface LLMPort {
  stream(input: {
    messages: Message[]
    system?: string
    tools: ToolSchema[]
    thinking?: { type: "enabled"; budget_tokens: number }
  }): AsyncIterable<StreamEvent>
}
```

### 6.2 Tool
```typescript
interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: z.ZodSchema<I>
  isReadOnly(): boolean
  isConcurrencySafe(input: I): boolean    // Phase 2
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent<O>>
}
```

### 6.3 Memory
```typescript
interface WorkingMemory {
  messages: Message[]
  append(message: Message): void
  snapshot(): readonly Message[]
}

interface PersistentStorePort {
  save(entry: MemoryEntry): Promise<void>
  recall(query: MemoryQuery): Promise<MemoryEntry[]>
}
```

### 6.4 Stream
```typescript
interface StreamPort {
  emit(event: AgentEvent): void
}
```

### 6.5 Permission
```typescript
type PermissionDecision = "allow" | "deny" | "ask"
function evaluate(action: ToolAction, ctx: PermissionContext): PermissionDecision
```

---

## 7. 빌드/Lint 설정

### 7.1 `package.json`

```json
{
  "name": "quanta-codeagent",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun --hot run src/apps/cli/index.ts",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src tests",
    "lint:fix": "biome check --write src tests",
    "format": "biome format --write src tests",
    "build": "bun build --compile --minify src/apps/cli/index.ts --outfile dist/agent",
    "bench": "bun run src/apps/bench/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "bun-types": "^1.1.0",
    "@biomejs/biome": "^2.4.0"
  }
}
```

### 7.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "lib": ["ESNext"],

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,

    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,

    "skipLibCheck": true,
    "allowJs": false,

    "baseUrl": ".",
    "paths": {
      "@/shared": ["./src/shared/index.ts"],
      "@/shared/*": ["./src/shared/*"],
      "@/llm": ["./src/llm/index.ts"],
      "@/llm/*": ["./src/llm/*"],
      "@/tool": ["./src/tool/index.ts"],
      "@/tool/*": ["./src/tool/*"],
      "@/memory": ["./src/memory/index.ts"],
      "@/memory/*": ["./src/memory/*"],
      "@/storage": ["./src/storage/index.ts"],
      "@/storage/*": ["./src/storage/*"],
      "@/stream": ["./src/stream/index.ts"],
      "@/stream/*": ["./src/stream/*"],
      "@/permission": ["./src/permission/index.ts"],
      "@/permission/*": ["./src/permission/*"],
      "@/runtime": ["./src/runtime/index.ts"],
      "@/runtime/*": ["./src/runtime/*"],
      "@/lsp": ["./src/lsp/index.ts"],
      "@/lsp/*": ["./src/lsp/*"],
      "@/observability": ["./src/observability/index.ts"],
      "@/observability/*": ["./src/observability/*"],
      "@/agent": ["./src/agent/index.ts"],
      "@/agent/*": ["./src/agent/*"]
    }
  },
  "include": ["src", "tests"],
  "exclude": ["node_modules", "dist"]
}
```

슬라이스마다 bare 엔트리(`@/shared`)와 `/*` 엔트리를 둘 다 둔다: `@/shared` 같은 bare-module import는 슬라이스 public API(`index.ts`)로 해석되어야 하므로 명시적 `index.ts` 엔트리가 필요하고, `@/shared/*`는 슬라이스 내부 경로용이다.

### 7.3 `biome.json`

> 원안의 `nursery.noRestrictedImports` 단일 블록(슬라이스→금지배열)은 Biome
> 어느 버전에서도 유효하지 않은 스키마였다. Biome 2.x의 `overrides[]` +
> `style/noRestrictedImports`(경로별 메시지)로 교체했다. 상세: `docs/decisions/0001-biome2-slice-isolation.md`.

대표 발췌 (base + `src/tool/**` override 1개):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "useExhaustiveDependencies": "warn"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsole": "warn"
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useImportType": "error",
        "useExportType": "error"
      },
      "complexity": {
        "noExcessiveCognitiveComplexity": {
          "level": "warn",
          "options": { "maxAllowedComplexity": 15 }
        }
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "asNeeded",
      "trailingCommas": "all",
      "arrowParentheses": "always"
    }
  },
  "files": {
    "includes": ["**", "!node_modules", "!dist", "!**/*.d.ts"]
  },
  "overrides": [
    {
      "includes": ["src/tool/**"],
      "linter": {
        "rules": {
          "style": {
            "noRestrictedImports": {
              "level": "error",
              "options": {
                "paths": {
                  "@/memory": "Slice isolation (RFC 3.1): @/tool may only reach @/storage, @/runtime, @/shared",
                  "@/stream": "Slice isolation (RFC 3.1): @/tool may only reach @/storage, @/runtime, @/shared",
                  "@/permission": "Slice isolation (RFC 3.1): @/tool may only reach @/storage, @/runtime, @/shared",
                  "@/lsp": "Slice isolation (RFC 3.1): @/tool may only reach @/storage, @/runtime, @/shared",
                  "@/observability": "Slice isolation (RFC 3.1): @/tool may only reach @/storage, @/runtime, @/shared"
                }
              }
            }
          }
        }
      }
    }
    // … (슬라이스별 9개 override, 전체는 biome.json 참조)
  ]
}
```

**규칙 설명**:
- 슬라이스별 `overrides[]` 블록 하나가 그 디렉토리에서 금지된 import 경로와 메시지를 선언 → RFC §3.1 의존성 방향표를 그대로 인코딩.
- 예외 허용: `@/tool` → `@/storage`, `@/runtime` (목록에서 제외). `@/memory` → `@/storage` (영속화).
- `agent/`는 override 없음 → 모두 import 가능 (조립자).
- `shared/`는 어느 목록에도 없음 → 누구나 import 가능.
- 슬라이스 신설 시 override 수기 갱신 필요 (RFC §9.2 ADR 절차에 흡수). 결정 근거: `docs/decisions/0001-biome2-slice-isolation.md`.

### 7.4 `bunfig.toml`

```toml
[install]
exact = true
production = false

[install.cache]
disable = false

[test]
preload = ["./tests/setup.ts"]
coverage = false

[run]
hot = true
```

---

## 8. Phase 계획

### Phase 1 — Core ReAct (2주, ~3k LoC)

```
shared/  llm/anthropic  tool/{bash,read,write,edit,grep,glob}
runtime/shell  storage  stream/stdout  permission  agent/loop  apps/cli
```

**Done 정의**: 
- 사용자가 자연어 요청
- 에이전트가 도구 호출 반복
- 파일 편집·테스트 실행 성공
- 30+ turn 안정 동작

### Phase 1.5 — Memory + LSP (1주, +~2k LoC)

```
memory/{working, sqlite}  lsp/pyright  observability/logger
tool/test-runner (정교화)
```

**Done 정의**: 메모리 영속, LSP 진단 도구로 노출.

### Phase 2 — SWE-bench 도전 (1개월, +~3k LoC)

```
tool/edit/fuzzy  apps/bench  tool/localize  permission/policy 강화
agent/dispatch (per-tool concurrency)  agent/compaction
```

**Done 정의**: SWE-bench Verified 50%+ 단일 trajectory.

### Phase 3 — Best-of-N + 운영 (2개월, +~5k LoC)

```
apps/bench (N=5 sampling, voting)  observability/metrics
lsp/typescript  llm/openai  stream/sse  runtime/sandbox(docker)
```

**Done 정의**: SWE-bench Verified 70%+, 단일 바이너리 배포 가능.

### 총 예상

```
Phase 1     ~3k LoC
Phase 1.5  +2k
Phase 2    +3k
Phase 3    +5k
─────────────────
합계      ~13k LoC
```

v2 (406k) 대비 **31배 가벼움**.

---

## 9. ADR 정책 (v2 87개 ADR의 반대)

### 9.1 작성 규칙

1. **코드 동작 후 작성** — 가설 ADR 금지
2. **1 페이지 상한** — 길면 결정 안 된 것
3. **결정/근거/트레이드오프** 3섹션만
4. **3개월 동안 5~10개 목표**
5. **PR에서 reviewer가 ADR 필요성 동의해야 작성**

### 9.2 진짜 ADR이 필요한 케이스

- 슬라이스 추가/제거
- ports/adapters 추출 결정
- LLM provider 추가
- 의존성 방향 예외 허용
- 외부 시스템 통합 (Docker, vector DB 등)

### 9.3 ADR이 필요 없는 케이스

- 변수명, 함수 시그니처
- 단일 슬라이스 내부 리팩토링
- 의존성 버전 업그레이드
- 임시 휴리스틱

---

## 10. 테스트 전략

### 10.1 단위 (`tests/unit/`)
- `core/`의 순수 로직 (loop, dispatch, compaction)
- Mock adapter 주입
- 빠르게 (전체 <5초)

### 10.2 통합 (`tests/integration/`)
- 슬라이스 단위 (실제 adapter 사용)
- LLM은 fixture 또는 cassette
- 셸/파일은 임시 디렉토리

### 10.3 E2E (`tests/e2e/`, P2)
- SWE-bench fixture 작은 서브셋
- 실제 LLM 호출 (CI 옵셔널)

### 10.4 커버리지 정책
- 목표 없음 (퍼센트 강박 X)
- core/ 슬라이스는 모든 분기 테스트
- adapter는 happy path + 주요 error path

---

## 11. v2에서 가져올 자산

| v2 위치 | 가져갈 부분 | LoC | 변환 작업 |
|--------|----------|-----|---------|
| `localization/adapters/pyright_lsp_session.py` | LSP stdio JSON-RPC 패턴 | ~500 | Python → TS 포팅 또는 multilspy subprocess |
| `memory/sqlite_durable_memory_store.py` | SQLite 스키마/쿼리 | ~300 | `bun:sqlite`로 재작성 |
| `eval/adapters/swebench_official_runner.py` | SWE-bench harness 호출 패턴 | ~400 | subprocess로 swebench Python 호출 |
| `attempt/retry_policy.py` | decide_retry 로직 | ~200 | TS 포팅 |

**총 가져올 가치 있는 자산: ~1.5k LoC 정도**. 나머지는 새로 짜는 게 빠름.

---

## 12. 위험 및 완화

| 위험 | 가능성 | 영향 | 완화 |
|------|------|-----|-----|
| Anthropic SDK 변경 | 중 | 중 | adapter 격리, 1주 내 대응 가능 |
| v2 마인드셋 재발 (워크플로우 강박) | 높 | 큼 | **본 RFC를 매주 재독**, ADR 정책 엄수 |
| 슬라이스 경계 침범 | 중 | 중 | Biome `noRestrictedImports` 강제 |
| Bun 호환성 이슈 | 낮 | 중 | Node fallback 코드 X (Bun 전용 commit) |
| 의존성 폭증 | 중 | 큼 | 분기마다 의존성 리뷰. 5개 미만 유지 목표 |
| LLM 비용 폭주 | 높 | 중 | dev 중 cost cap, CI에선 fixture 사용 |

---

## 13. 미해결 질문

다음은 코드 작성 중 결정:

1. **Hook 시스템** — Phase 1에 포함? 아니면 Phase 2?
2. **agent state 영속화** — 세션 resume 필요한가?
3. **Plan mode** — 별도 도구로? 시스템 프롬프트 변경으로?
4. **Best-of-N 구현 위치** — `agent/` 내부? 별도 `sampler/` 슬라이스?
5. **MCP 지원** — Phase 어디서?

**원칙**: 막힐 때 결정. 미리 결정하지 않음.

### 13.1 Phase 1 결정 (2026-05-19)

- **Hook 시스템** → Phase 1 제외 (루프에 미포함, 후속 Phase).
- **Plan mode** → 미구현 (후속).
- **agent state 영속화** → 미구현 (CLI는 인메모리 멀티턴만).
- **슬라이스 격리 강제** → Biome 2.x `overrides[]` 채택 (ADR-0001).
- **Tool 인터페이스** → `isConcurrencySafe`/`AsyncIterable<ToolEvent>`는 Phase 2로 연기 (Phase 1은 `execute(): Promise<ToolResult>`).

---

## 14. 부록: 첫 파일

### `src/shared/types.ts`
```typescript
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export type Id<Brand extends string> = string & { __brand: Brand }
```

### `src/llm/types.ts`
```typescript
export interface Message {
  role: "user" | "assistant"
  content: ContentBlock[]
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export interface ThinkingBlock { type: "thinking"; thinking: string }

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; delta: string }
  | { type: "tool_use_end"; id: string; input: unknown }
  | { type: "message_stop"; stop_reason: string }
```

---

## 15. 변경 이력

| 버전 | 날짜 | 변경 |
|-----|-----|------|
| 0.1 | 2026-05-19 | 최초 작성 |
| 0.2 | 2026-05-19 | Phase 1 구현 반영: 빌드설정 현행화, Biome 2.x 슬라이스 격리(ADR-0001), §13.1 결정 기록 |
