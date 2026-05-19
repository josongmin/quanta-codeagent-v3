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

> **측정 기준의 정직성 (50%/70%)**: 하니스(`apps/bench`)·Best-of-N
> 샘플러·Python 채점 seam(`python-swebench.ts`)은 **구현되어 결정론 단위/
> 통합 테스트로 검증**된다 — 메커니즘은 실재한다. 그러나 *resolution
> 퍼센트* 자체는 비차단 실-LLM eval 티어(§10.4)와 외부 Docker/Python
> 채점에서만 산출되며, 본 레포는 그 퍼센트를 스스로 증명하지 않는다.
> 50%/70%는 목표치이지 레포가 보장하는 측정값이 아니다(머신은 진짜,
> 점수는 외부 검증 대상).

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
| LLM SDK | `@anthropic-ai/sdk`, `openai` | 듀얼 provider 런타임 스위치 (ADR-0002) |
| 스키마 검증 | `zod` | 도구 입력 검증, 모델 출력 파싱 |
| DB | `bun:sqlite` | 내장, 의존성 0 (memory 슬라이스 영속화에 사용) |
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
- 예외: `tool/` → `runtime/`·`storage/`, `memory/` → `storage/` (자연스러운
  의존; `tool/ → storage/`는 read/write/edit/test-runner가 사용, biome.json
  override 목록에서 제외돼 강제 매트릭스에 반영됨)
- `memory/`는 `@/llm` import 불가 유지 — 시맨틱 회상에 필요한 임베딩은
  memory가 소유한 주입식 `EmbedderPort`로 받고, 구현은 `@/agent`에 둠 (§6.3, ADR-0008)

### 3.2 슬라이스 목록

| 슬라이스 | 책임 | 형태 (Phase 1) |
|---------|-----|--------------|
| **shared** | 공통 타입, 에러, 로거 | (utility) |
| **llm** | LLM 추상화 + 어댑터 | 풀 헥사고날 |
| **tool** | 도구 정의 + 레지스트리 | 풀 (Tool 인터페이스) |
| **memory** | 작업/장기 메모리 | 풀 (working + sqlite/in-memory, 구현됨) |
| **storage** | 파일 I/O | 약식 (단일 구현) |
| **stream** | 출력/이벤트 | 풀 |
| **permission** | 정책 평가 | 약식 |
| **runtime** | 셸/샌드박스 실행 | 약식 → 풀 (sandbox 시) |
| **lsp** | 언어 서버 | 풀 (pyright + typescript 어댑터; `agent/lsp-bridge.ts`가 `diagnostics` 도구로 노출, ADR-0009) |
| **observability** | 로그/메트릭 | 약식 (logger + metrics, 구현됨) |
| **mcp** | MCP 클라이언트 + 브리지 | 약식 (client/jsonrpc, agent가 브리지) |
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
│   │   ├── assemble.ts          # system 프리픽스 조립 (캐시)
│   │   ├── adapters/
│   │   │   ├── anthropic.ts
│   │   │   └── openai.ts        # ADR-0002
│   │   └── index.ts
│   │
│   ├── tool/
│   │   ├── types.ts             # Tool, ToolContext, ToolResult
│   │   ├── registry.ts
│   │   ├── schema.ts
│   │   ├── bash/index.ts
│   │   ├── read/index.ts
│   │   ├── write/index.ts
│   │   ├── edit/
│   │   │   ├── index.ts
│   │   │   ├── exact.ts
│   │   │   └── fuzzy.ts
│   │   ├── grep/index.ts
│   │   ├── glob/index.ts
│   │   ├── localize/index.ts
│   │   ├── test-runner/index.ts
│   │   └── index.ts
│   │
│   ├── memory/
│   │   ├── types.ts             # MemoryEntry, FreshnessBucket
│   │   ├── working.ts           # 세션 내
│   │   ├── ranking.ts           # recall 랭킹
│   │   ├── vector.ts            # 임베딩/유사도
│   │   ├── dedup.ts
│   │   ├── eviction.ts
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
│   ├── lsp/
│   │   ├── types.ts
│   │   ├── ports.ts
│   │   ├── adapters/
│   │   │   ├── jsonrpc.ts
│   │   │   ├── pyright.ts
│   │   │   └── typescript.ts
│   │   └── index.ts
│   │
│   ├── observability/
│   │   ├── types.ts
│   │   ├── logger.ts            # 구조화 로거
│   │   ├── metrics.ts           # 메트릭 수집
│   │   └── index.ts
│   │
│   ├── mcp/
│   │   ├── types.ts
│   │   ├── jsonrpc.ts
│   │   ├── client.ts            # MCP 클라이언트
│   │   └── index.ts
│   │
│   ├── agent/
│   │   ├── types.ts             # AgentConfig
│   │   ├── loop.ts              # ReAct 루프
│   │   ├── dispatch.ts          # 도구 디스패치 (동시성 배칭)
│   │   ├── retry.ts             # in-loop 실패 복구
│   │   ├── compaction.ts        # proactive/reactive
│   │   ├── hooks.ts
│   │   ├── plan.ts              # plan mode
│   │   ├── state.ts             # state 영속/resume
│   │   ├── metrics.ts
│   │   ├── memory.ts            # WorkingMemory + recall/persist 배선
│   │   ├── memory-consolidate.ts
│   │   ├── memory-distill.ts
│   │   ├── memory-embedder.ts   # EmbedderPort 구현 (OpenAI/null/캐싱)
│   │   ├── memory-stats.ts      # recall/persist 통계 (onStats 시임)
│   │   ├── memory-tools.ts      # memory_search/write/update self-edit 도구
│   │   ├── mcp-bridge.ts        # MCP 도구 브리지
│   │   ├── lsp-bridge.ts        # LSP → diagnostics 도구 어댑터 (§3.2)
│   │   ├── prompt.ts            # 시스템 프롬프트 (정적 프리픽스 + 턴 컨텍스트)
│   │   └── index.ts
│   │
│   └── apps/
│       ├── cli/
│       │   ├── dotenv.ts        # .env.dev 자동 로드
│       │   └── index.ts
│       └── bench/               # SWE-bench 하니스
│           ├── runner.ts
│           ├── sampler.ts       # Best-of-N
│           ├── swebench.ts
│           ├── swebench-dataset.ts
│           ├── python-swebench.ts  # python seam
│           ├── dry-run.ts
│           ├── report.ts
│           ├── types.ts
│           └── index.ts
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

세션 내 `WorkingMemory`(불변) + 영속 SOTA++ 계층형 시맨틱 메모리.
의도적 anti-bloat override(§12 위험표·ADR-0008). 신규 npm 의존성 0.

```typescript
interface WorkingMemory<M = StoredMessage> {  // 세션 내 메시지 버퍼, 비영속
  messages: M[]
  append(message: M): void
  snapshot(): readonly M[]
}

interface PersistentStorePort {                // 영속 장기 메모리 (hexagonal)
  save(entry: MemoryEntry): Promise<void>
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>
  delete(id: string): Promise<void>
  get(id: string): Promise<MemoryEntry | undefined>
  all(): Promise<MemoryEntry[]>
  recall(query: MemoryQuery): Promise<MemoryEntry[]>
}

interface EmbedderPort {                        // memory가 소유, @/agent가 구현
  embed(texts: string[]): Promise<number[][]>
}
```

- **계층**: `tier` = `episodic`(세션 회상, 빠른 eviction) / `semantic`(중복제거된
  내구 지식). `kind` = `fact|decision|observation|preference`. `working`은 tier가
  아닌 비영속 메시지 버퍼.
- **시맨틱 회상**: OpenAI `text-embedding-3-small`(1536d) 임베딩을 Float32
  BLOB(sqlite)로 저장, 코사인 유사도. 하이브리드 랭킹(`ranking.ts`, 가중 합)
  = 벡터(W=10, 지배항) + 텍스트 부분일치(5, 완전일치 +1) + 태그(4/태그) +
  freshness(fresh3/recent2/stale1/archived0) + importance(×4) +
  tier(semantic1/episodic0.5, ×W_TIER=2 — 내구 지식이 raw 회상보다 우선) +
  접근 강화(`min(log1p(accessCount),3)`). **텍스트는 더 이상 하드 필터가
  아니라 점수 항** — paraphrase 누락 버그 제거. 태그·`tiers`·`kinds`·
  `minImportance`는 하드 필터(`tiers` 미지정 시 전 tier 회상 — 동작 보존).
- **distill**: 세션 종료 시 `distillSession`(@/agent)이 트랜스크립트를 LLM으로
  구조화 레코드로 추출 → raw 최종-텍스트 덤프 대체. LLM/임베더 부재 시
  휴리스틱 단일 요약으로 graceful degrade.
- **consolidation/dedup**: `findNearDuplicates`(코사인 OR 토큰-Jaccard) →
  LLM 중재 `arbitrateConsolidation`이 `insert|skip|merge|supersede` 결정.
- **decay + eviction**: `planEviction`이 tier별 정원, 30일 초과 superseded
  하드삭제, 정원 초과 저가치 삭제, archived 저가치 importance 감쇠를 계획
  (순수 함수, 호출자가 적용).
- **self-edit 도구**: store 존재 시 `memory_search`/`memory_write`/
  `memory_update`를 에이전트에 등록(세션 중 자기 메모리 수정). `memory_search`는
  `tier`/`kind`/`minImportance` 선택 필터 노출. 루프 회상은
  `memory.recallTiers`(env `QUANTA_MEMORY_RECALL_TIERS`)로 tier 제한 가능.
- **관측성**: `AgentRecorder`가 `memory.recall.*`(calls/entries/semantic/
  fallback) · `memory.persist.calls` · `memory.distilled` ·
  `memory.consolidate.*`(insert/merge/supersede/skip) · `memory.evict.*`
  (decay/delete) 카운터를 기록. `recallContext`/`persistSession`은 반환형
  불변, 옵셔널 `onStats` 옵저버로 통계 방출(루프가 recorder에 배선).
- **슬라이스 격리 유지**: `src/memory/**`는 여전히 `@/llm`을 import 불가
  (Biome 강제). memory는 주입식 `EmbedderPort` 인터페이스만 소유; OpenAI
  구현 + 모든 LLM 주도 지능(임베딩/distill/consolidate)은 `@/agent`에 거주
  (유일 교차 슬라이스 importer). memory는 순수 저장+랭킹+벡터수학으로 유지.
- **동작 보존 / anti-bloat**: store/embedder 부재 ⇒ 루프 byte-for-byte 불변.
  신규 엔트리 필드는 전부 optional, store 경계 `normalizeEntry`에서 정규화 →
  구 행/구 호출자 그대로 동작. sqlite는 레거시 스키마를 open 시 자동 마이그레이션.

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

분리 축은 "실 어댑터 여부"가 아니라 **결정론성·환경의존성**. 상세·트레이드오프: `docs/decisions/0003-test-pyramid.md`(ADR-0003).

### 10.1 단위 (`tests/unit/`)
- 순수 슬라이스 로직 (loop, dispatch, compaction). Mock adapter 주입.
- 완전 결정론. 전체 <5초(CI 예산 8초). 매 push/PR 차단.

### 10.2 통합 (`tests/integration/`)
- 슬라이스 결선 — 실 **in-process** adapter + FakeLLM + 임시 디렉토리.
- 완전 결정론(예: SQLite·spawn한 mock MCP 서버). 매 push/PR 차단.
- `bun test`(기본) = 10.1+10.2만. 이것이 머지 게이트.

### 10.3 컨트랙트 (`tests/contract/`)
- 실 외부 프로세스: Docker 데몬, pyright/typescript 언어서버.
- 환경게이트. 로컬은 부재 시 공손히 스킵, CI는 `REQUIRE_CONTRACT=1`로
  부재를 하드 실패화(`_guard.ts`) — 스킵 뒤 회귀 은폐 방지. main 차단.

### 10.4 평가 (`src/apps/bench`, P2)
- 실 LLM · SWE-bench(synthetic→실 서브셋) · Best-of-N 점수.
- 비결정. nightly/`eval` 라벨, **비차단**(`continue-on-error`). 게이트 아님,
  점수 트렌드로만 관측 (retry-until-green 금지 — 회귀 은폐).

### 10.5 커버리지 정책
- 목표 % 없음 (퍼센트 강박 X). 측정만(`test:cov`, CI 아티팩트), 게이트 X.
- core 슬라이스는 모든 분기, adapter는 happy + 주요 error path.
- 강제 장치는 CI(`.github/workflows/ci.yml`): pyramid/contract/eval 잡.

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
| memory 슬라이스 anti-bloat 의도적 override (SOTA++, ROI 무관) | 높(이미 발생) | 중 | 사용자 명시 지시로 한정·기록(ADR-0008). 신규 dep 0 유지, 전부 env-gated 기본 OFF, store/embedder 부재 시 루프 불변, 순수 결정론 코어 + 풀 테스트 피라미드, 임베딩/세션종료 LLM 실패는 lexical로 graceful degrade |

---

## 13. 미해결 질문

다음은 코드 작성 중 결정 (Q1–Q5 전부 해소됨 — §13.1 참조, 원 질문은 이력 보존):

1. **Hook 시스템** — Phase 1에 포함? 아니면 Phase 2? → 해소: `agent/hooks.ts` 구현 (§13.1).
2. **agent state 영속화** — 세션 resume 필요한가? → 해소: `agent/state.ts`, CLI `--resume`/`QUANTA_RESUME` (§13.1).
3. **Plan mode** — 별도 도구로? 시스템 프롬프트 변경으로? → 해소: `agent/plan.ts`, `QUANTA_PLAN` (§13.1).
4. **Best-of-N 구현 위치** — `agent/` 내부? 별도 `sampler/` 슬라이스? → 해소: 별도 슬라이스 없이 `apps/bench/sampler.ts` (§13.1).
5. **MCP 지원** — Phase 어디서? → 해소: `mcp/` 슬라이스 + `agent/mcp-bridge.ts` 구현, `QUANTA_MCP_CONFIG` (§13.1).

**원칙**: 막힐 때 결정. 미리 결정하지 않음.

### 13.1 Phase 1 결정 (2026-05-19)

- **Hook 시스템** → (v0.1 계획: Phase 1 제외) **현재 구현됨** `agent/hooks.ts`, 루프 배선.
- **Plan mode** → (v0.1 계획: 미구현) **현재 구현됨** `agent/plan.ts`, `QUANTA_PLAN`/`--plan`.
- **agent state 영속화** → (v0.1 계획: 미구현) **현재 구현됨** `agent/state.ts`, `--state`/`--resume` (기본 OFF, env-gated).
- **슬라이스 격리 강제** → Biome 2.x `overrides[]` 채택 (ADR-0001).
- **Tool 인터페이스** → (v0.1 계획: Phase 2 연기) **현재 v2 구현됨** `isConcurrencySafe` + `AsyncIterable<ToolEvent>`, dispatch 동시성 배칭.
- **MCP / Best-of-N** → (v0.1 미해결 Q4·Q5) **현재 구현됨** `mcp/` 슬라이스 + `agent/mcp-bridge.ts`(`QUANTA_MCP_CONFIG`), Best-of-N 샘플러는 `apps/bench/sampler.ts`. subagent는 여전히 범위 외.
- **LLM provider** → §8에서 Phase 3였던 OpenAI 어댑터를 Phase 1에 선반영 (실 검증 키가 OpenAI, 포트 기존재). Anthropic/OpenAI 런타임 스위치. 상세 ADR-0002.
- **루프 견고화 + compaction (v0.4)** → §8에서 Phase 2였던 compaction을 Phase 1 루프에 편입: proactive(턴 상단 토큰압) + reactive(PTL 트리거). 함께 in-loop 실패 복구 추가 — transient는 bounded backoff 재시도, PTL→reactive compact 후 동일 턴 재개, max_output_tokens는 continue meta 주입, malformed tool_use 1회 교정, empty turn 캡. **same-turn 복구는 maxTurns 카운터 불소모** (정상 tool round만 증가). 근거: §8 Phase 1 Done "30+ turn 안정"은 단일 transient 오류에도 죽지 않아야 성립. e2e(`agent-recovery-e2e`)·OpenAI 어댑터 테스트로 검증.
- **프롬프트 캐시 (v0.4)** → 매 턴 system 재조립 폐기, 정적 프리픽스 고정 + 동적 컨텍스트는 꼬리 `<system-reminder>` 1메시지. 양 provider 캐시 프리픽스 안정. 시스템 프롬프트 강화 동반. 상세 ADR-0004. (참고: 사전조사 결과 hooks/plan/`AsyncIterable` tool 인터페이스는 위 항목들과 별개로 이미 선구현된 상태였음 — 본 절 상단 "제외/연기" 표기는 v0.1 시점 계획값.)

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
| 0.3 | 2026-05-19 | OpenAI provider 선반영(ADR-0002), 의존성 `openai` 추가, §13.1 LLM provider 항목 |
| 0.4 | 2026-05-19 | 루프 견고화 선반영: in-loop 실패 복구(transient backoff / PTL→reactive compact / max_output_tokens / malformed tool_use / empty turn, same-turn 재시도는 maxTurns 불소모) + proactive·reactive compaction을 Phase 1 루프에 편입(§8에선 Phase 2였음). 프롬프트 캐시 프리픽스 고정 + 시스템 프롬프트 강화(ADR-0004). e2e 복구·OpenAI 어댑터 테스트 추가. §13.1 항목 |
| 0.5 | 2026-05-19 | Phase 1.5/2/3 구현 일괄 반영(문서 현행화): memory(working+sqlite+in-memory, recall/persist 배선)·lsp(pyright+typescript)·observability(logger+metrics)·mcp 슬라이스, Tool 인터페이스 v2(동시성 배칭), retry/compaction/hooks/plan/state/metrics + mcp-bridge, SWE-bench 하니스 + Best-of-N 샘플러 + python seam, WorkingMemory 루프 배선. §2·§3.2·§4 트리·§13 Q1–Q5 해소 표기 동기화 |
| 0.6 | 2026-05-19 | SOTA++ 계층형 시맨틱 메모리 반영(ADR-0008): §6.3 재작성(tier/하이브리드 회상/distill/consolidate/evict/self-edit/EmbedderPort 주입), §3.1 memory↛@/llm 예외 명문화, §12 anti-bloat 의도적 override 위험 항목 추가. 신규 dep 0 |
| 0.7 | 2026-05-19 | SOTA++ 메모리 심화(ADR-0008 연장): tier가 회상 랭킹에 실제 작용(W_TIER=2, semantic>episodic — "계층형 회상" 빵꾸 해소), `memory_search` tier/kind/minImportance 필터, `memory.recallTiers`+`QUANTA_MEMORY_RECALL_TIERS`, 메모리 관측성(`AgentRecorder` memory.recall/persist/distilled/consolidate/evict 카운터, `onStats` 옵저버). 반환형 불변·동작 보존, 신규 dep 0. 523 테스트 통과 |
| 0.8 | 2026-05-19 | 문서 정직성 정정: §1.1 SWE-bench 50%/70% 측정 정직성 주석(메커니즘 구현·결정론 검증 / 퍼센트는 외부 eval 대상), §3.1 `tool/→storage/` 예외 명문화(biome 강제 매트릭스 정합), §3.2/§4 LSP가 `agent/lsp-bridge.ts`로 `diagnostics` 도구 노출(ADR-0009), §4 트리에 memory-stats/memory-tools/lsp-bridge 추가. 사문화 export `planSystemAugmentation`/`PLAN_AUGMENTATION` 제거(in-loop 카피는 prompt.ts `PLAN_NOTICE`로 일원화). ADR-0005 결번 placeholder |
