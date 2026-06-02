# RFC: Canvas Web Components — Rich DiffView + Segmented UsageBar for the Web/Tauri Surface

**Status:** Draft (implementation-ready)
**Surface:** `apps/web-frontend` (Vite + React 18 + Tailwind 3.4), shared by the Tauri shell (`apps/tauri-shell`)
**ADR suggestion:** ADR-0435 (latest landed is `0434-permission-profile-list-select.md`; 0435 is free)
**Posture:** closed-port / DI, **default-OFF** (components are dead weight until the daemon emits the data; chat UI byte-unchanged)
**Author lens:** SOTA++ absorption of Cursor's `cursor/canvas` SDK component shapes — render-side only.

---

## 1. Problem

quanta는 이미 **diff 데이터**와 **per-category segmented token-usage 데이터**를 CLI 표면에서 계산한다:

- Diff: `src/apps/cli/diff-preview.ts` — write/edit/apply_patch/scripted_replace에 대한 line-level LCS (Hunt–McIlroy) unified diff. `renderUnified(before, after, maxLines)` (diff-preview.ts:252) 가 내부적으로 `diffLines()` (diff-preview.ts:280) 를 거쳐 `DiffOp { kind: "keep"|"del"|"add"; line }` (diff-preview.ts:265) 의 배열을 만든다. 단, **현재는 즉시 ANSI 문자열로 직렬화**되어 데이터 구조가 밖으로 노출되지 않는다.
- Usage: `src/apps/cli/repl/context-usage-snapshot.ts` 가 turn마다 `PromptAssembledSnapshot` 을 받아 `buildUsageBreakdownDefault()` 로 `SegmentedUsageView` (status-line.ts:108) 를 만든다. 세그먼트는 `{ id, tokens }` + `total`/`max`/`model?`. 카테고리는 `CATEGORY_ORDER` (usage-breakdown.ts:51): System/Tools/Rules/Skills/MCP/Subagents/Conversation, 각자 named color (usage-breakdown.ts:62).

반면 web/Tauri 표면은 **basic chat UI**다. `apps/web-frontend/README.md:140-153` 가 v1 비-목표를 명시적으로 선언한다: *"No cost / token dashboard · No diff preview for tool calls."* 가진 컴포넌트는 `ChatPanel`/`InputBar`/`StatusBar`/`ObservabilityPane`/`TokenCounter`(헤더 누적 pill뿐) 정도다 (README.md:105-124).

즉 **데이터는 이미 있고 web 표면에 rich renderer만 없다.** 이 RFC는 Cursor `cursor/canvas` SDK의 검증된 컴포넌트 prop 형태를 거울삼아, 기존에 계산된 diff/usage 데이터를 web/Tauri에서 풍부하게 렌더하는 React 컴포넌트를 추가한다. **데이터를 재계산하지 않는다** — adapter로 변환만 한다.

---

## 2. Goals / Non-Goals

### Goals
- G1. `DiffView` React 컴포넌트 — Cursor `DiffViewProps` (diff-view.d.ts:63) 형태를 미러. `lines: DiffLineData[]` 를 색 배경 + line-number gutter + accent strip 으로 렌더.
- G2. `DiffStats` 컴포넌트 — `+N`/`-N` glyph pair (diff-view.d.ts:34).
- G3. `UsageBar` React 컴포넌트 — Cursor `UsageBarProps` (usage-bar.d.ts:21) 형태를 미러. proportional 세그먼트 + remainder + topLeft/topRight 라벨.
- G4. **Lossless adapter** — quanta의 기존 데이터 모델 → Cursor prop 형태:
  - `diffOpsToLines(ops: DiffOp[]): DiffLineData[]`
  - `segmentedViewToUsageBar(view: SegmentedUsageView): { segments, total, topLeftLabel, topRightLabel }`
- G5. Daemon → WS → component 데이터 흐름. 새 WS 메시지 타입(`tool.diff` / `context.usage`)을 정의하되 **gate ON 일 때만** emit.
- G6. Tailwind token palette (canvas-tokens.d.ts 미러) — light/dark, accessibility.
- G7. **default-OFF**: 컴포넌트는 데이터가 없으면 렌더되지 않음 (empty state → null/placeholder). chat UI 변경 0.
- G8. Optional: `BarChart`/`PieChart` 경량 SVG 컴포넌트 (chart-primitives.d.ts 미러) — usage history / tool-outcome 분포용. v1 stretch.

### Non-Goals (v1)
- **NG1 (핵심):** agent가 저작하는 `.canvas.tsx` **코드 실행 샌드박스** 아님. Cursor의 canvas는 agent가 `cursor/canvas` SDK로 `.canvas.tsx` 파일을 작성 → esbuild → proto serialize → host webview 에서 실행하는 무거운 파이프라인이다 (index.d.ts:1-12 의 `useHostTheme()`/`useCanvasState()`/`useCanvasAction()` hooks — host ↔ canvas 양방향 RPC). 이건 별도 future RFC. 여기서는 **render-side React 컴포넌트만**, 기존 daemon 데이터로 구동.
- NG2. Shiki/Prism syntax highlighting per-line은 v1 비-목표 (Cursor의 `path`→language 추론은 선택). web-frontend는 이미 `react-syntax-highlighter` (README.md:17) 가 있으니 v2에서 `path` prop을 받아 적용. v1은 monospace + diff 배경색만.
- NG3. `useCanvasState`/`useCanvasAction` host-state hooks, DAG layout, form primitives, collapsible/todo-list 등 나머지 canvas SDK 표면 — 미흡수.
- NG4. 인터랙티브 diff 편집(stage/unstage hunks). read-only 렌더만.
- NG5. CLI의 diff math를 web bundle로 복제하지 않음 — diff math는 daemon-side(이미 노드)에서 돌고, web은 결과 `DiffLineData[]` 만 받는다.

---

## 3. Design

### 3.1 컴포넌트 위치

```
apps/web-frontend/src/
├── components/
│   ├── canvas/                       ← NEW: rich render-side components
│   │   ├── DiffView.tsx              ← G1
│   │   ├── DiffView.test.tsx
│   │   ├── DiffStats.tsx             ← G2
│   │   ├── UsageBar.tsx              ← G3
│   │   ├── UsageBar.test.tsx
│   │   ├── charts/                   ← G8 (stretch)
│   │   │   ├── BarChart.tsx
│   │   │   └── PieChart.tsx
│   │   └── tokens.ts                 ← G6: canvas-tokens 미러 (light/dark)
│   └── DiffPanel.tsx                 ← NEW: host card wrapper (DiffStats header + DiffView body)
├── adapters/                         ← NEW: lossless CLI-data → canvas-prop
│   ├── diff-adapter.ts               ← G4: DiffOp[]/wire → DiffLineData[]
│   ├── diff-adapter.test.ts
│   ├── usage-adapter.ts             ← G4: SegmentedUsageView → UsageBarProps
│   └── usage-adapter.test.ts
└── ws/
    └── canvas-hooks.ts               ← NEW: useToolDiffs / useContextUsage (WS feed)
```

`canvas/` 서브디렉토리는 Cursor의 `cursor/canvas` 네임스페이스를 미러하면서 web-frontend의 평범한 컴포넌트와 격리한다. 향후 NG1(실행 샌드박스)을 추가하면 여기에 host runtime이 들어간다.

### 3.2 컴포넌트 prop 형태 (Cursor 미러, 1:1)

**DiffView** — `diff-view.d.ts:57-95` 그대로:

```ts
export type DiffLineType = "added" | "removed" | "unchanged"
export interface DiffLineData {
  readonly type: DiffLineType
  readonly content: string
  readonly lineNumber?: number
}
export interface DiffViewProps {
  readonly lines: readonly DiffLineData[]
  readonly path?: string                  // language inference (v2 highlight)
  readonly language?: string              // override; language wins over path
  readonly showLineNumbers?: boolean      // default true
  readonly coloredLineNumbers?: boolean   // default true
  readonly showAccentStrip?: boolean      // default true (3px left strip)
  readonly className?: string             // web-frontend는 style 대신 Tailwind className
}
```

> Cursor는 `style?: CSSProperties` 를 받지만 web-frontend는 Tailwind/cx 컨벤션이므로 `className?` 으로 치환 (lib/classnames.ts 의 `cx`). prop **이름과 의미는 동일**하게 유지.

**DiffStats** — `diff-view.d.ts:34`: `{ additions?: number; deletions?: number }`. 둘 다 0이면 `null` 렌더 (원본 contract 동일).

**UsageBar** — `usage-bar.d.ts:9-31` 그대로:

```ts
export interface UsageBarSegment {
  readonly id: string
  readonly value: number                  // non-finite/<=0 ⇒ 0
  readonly color?: Color                   // 미지정 시 usageColorSequence 인덱스 순환
}
export interface UsageBarProps {
  readonly segments: readonly UsageBarSegment[]
  readonly total: number                   // remainder = max(0, total - Σvalue)
  readonly topLeftLabel?: ReactNode
  readonly topRightLabel?: ReactNode
  readonly className?: string
}
```

**Color palette** — canvas-tokens.d.ts:126-135 의 `colorPalette` 7색 (gray/purple/green/yellow/pink/blue/orange) 을 그대로 `tokens.ts` 에 옮긴다. `usageColorSequence` 도 (auto-rotation).

**Charts (G8 stretch)** — chart-primitives.d.ts:30-67: `ChartSeries { name, data[], tone? }`, `BarChartProps { categories, series, stacked?, horizontal?, normalized?, valueSuffix? }`, `PieChartProps { data: {label,value,tone?}[], donut? }`. 순수 inline SVG, zero-dep (원본과 동일 철학).

### 3.3 Adapter (lossless, G4)

**diff-adapter.ts** — quanta의 `DiffOp { kind: "keep"|"del"|"add"; line }` ↔ Cursor `DiffLineData`:

```ts
// kind 매핑: keep→unchanged, del→removed, add→added
const KIND_TO_TYPE = { keep: "unchanged", del: "removed", add: "added" } as const

export const diffOpsToLines = (
  ops: readonly { kind: "keep" | "del" | "add"; line: string }[],
): DiffLineData[] => {
  let oldNo = 0, newNo = 0
  return ops.map((op) => {
    const type = KIND_TO_TYPE[op.kind]
    // unchanged/removed advance old; unchanged/added advance new.
    // DiffView gutter shows the *new-side* number for added/unchanged,
    // old-side for removed — mirrors diff-view.d.ts:118-123 example.
    if (op.kind === "del") return { type, content: op.line, lineNumber: ++oldNo }
    if (op.kind === "add") return { type, content: op.line, lineNumber: ++newNo }
    oldNo++; newNo++
    return { type, content: op.line, lineNumber: newNo }
  })
}
```

> **핵심:** diff math를 web에서 다시 돌리지 않는다. daemon이 `DiffOp[]` (또는 동등 wire 형태) 를 보내고, adapter는 순수 형태변환만. lossless 테스트로 봉인.

또한 add/del 카운트에서 `DiffStats` props 도출: `additions = ops.filter(add).length`, `deletions = ops.filter(del).length`.

**usage-adapter.ts** — `SegmentedUsageView` (status-line.ts:108) ↔ `UsageBarProps`:

```ts
// CATEGORY_ORDER (usage-breakdown.ts:51) 가 segment 순서를 정하므로
// usageColorSequence 인덱스 순환이 CLI의 named color와 일관되게 정렬됨.
export const segmentedViewToUsageBar = (v: SegmentedUsageView): UsageBarProps => ({
  segments: v.segments.map((s) => ({ id: s.id, value: s.tokens })),  // color 생략 → 자동
  total: v.max > 0 ? v.max : v.total,    // remainder span = 남은 윈도우
  topLeftLabel: `${percentFull(v)}% Full`,
  topRightLabel: `${formatTokens(v.total)} / ${formatTokens(v.max)} Tokens`,
})
```

라벨 텍스트는 `formatSegmentedUsage` (status-line.ts:158) 의 head 라인 의미를 그대로 재현 (`76.8k/120k · 64% Full`). **percent/format 헬퍼는 CLI 로직을 그대로 옮긴 순수 함수** — 새 휴리스틱 도입 금지(`viewPercent` status-line.ts:116 동일 식).

### 3.4 데이터 흐름 (daemon → WS → component)

기존 패턴을 그대로 따른다. ADR-0420 의 observability sink (`src/apps/web-daemon/server.ts:90-111`) 가 per-connection 으로 `observability.snapshot`/`observability.delta` 프레임을 `ws.send()` 한다. 이와 **동형(同型)** 의 두 신규 채널을 추가한다:

```
[agent loop]
  ├─ onToolApproved/onToolCompleted seam (diff data 이미 계산됨, diff-preview.ts)
  │     └→ daemon emit "tool.diff" frame  ───WS───▶  useToolDiffs() ─▶ <DiffPanel>
  └─ onPromptAssembled seam (context-usage-snapshot.ts, 이미 계산됨)
        └→ daemon emit "context.usage" frame ─WS─▶  useContextUsage() ─▶ <UsageBar>
```

**새 WS 메시지 타입** (web-daemon owns canonical shape; frontend는 local copy — protocol.ts:1-25 패턴):

```ts
// src/protocol/canvas/messages.ts (NEW, upstream 정본)
export interface ToolDiffMessage {
  readonly kind: "tool.diff"
  readonly toolCallId: string
  readonly path?: string
  readonly language?: string
  readonly binary?: boolean       // true ⇒ DiffView 대신 "binary file" placeholder
  readonly truncated?: boolean    // CLI의 clip()/64KiB cap 신호
  readonly lines: readonly DiffLineData[]   // daemon이 diffOps→lines 변환 후 송신
  readonly additions: number
  readonly deletions: number
  readonly emittedAt: number
}
export interface ContextUsageMessage {
  readonly kind: "context.usage"
  readonly segments: readonly { readonly id: string; readonly tokens: number }[]
  readonly total: number
  readonly max: number
  readonly model?: string
  readonly emittedAt: number
}
```

> `ContextUsageMessage` 는 `SegmentedUsageView` 와 구조적으로 동일 — daemon은 `view()` (context-usage-snapshot.ts:45) 결과를 거의 그대로 직렬화. **재계산 없음.**

**default-OFF gate:** observability sink와 동일하게 (server.ts:50-55, `attachObservabilitySink ... ?? undefined`), `canvasPorts?: CanvasEmitterPorts` 를 `WebDaemonConfig` 에 optional 추가. composition root가 주입하지 않으면 프레임을 절대 송신하지 않고 → 컴포넌트는 빈 상태 → chat UI 무변경. ENV gate 예: `QUANTA_WEB_CANVAS=1`.

**Frontend hooks (canvas-hooks.ts)** — `observability-hooks.ts:114` 의 `useObservabilityState` 와 동형:

```ts
export const useToolDiffs = (source: CanvasSource | null): Map<string, ToolDiffMessage> // by toolCallId
export const useContextUsage = (source: CanvasSource | null): ContextUsageMessage | null  // latest wins
```

`CanvasSource.subscribe(handler)` 는 `ObservabilitySource` (observability-hooks.ts:110) 와 같은 모양 — 프로덕션은 `SessionClient` wrap, 테스트는 stub.

### 3.5 렌더 위치 (UI 통합)

- `<DiffPanel>` (DiffStats header + DiffView body, diff-view.d.ts:22-31 의 Card 컴포지션 미러): 해당 `tool.invoked`/`tool.completed` 행 아래 또는 `ObservabilityPane` 의 Run row 확장 영역에 인라인. v1은 chat transcript 흐름에 카드로 삽입.
- `<UsageBar>`: `ObservabilityPane` 상단(ObjectiveCard 위) 또는 헤더의 `TokenCounter` 옆 확장 패널. 데이터 없으면 안 그림 (TokenCounter.tsx:14 의 `if (usage.turns === 0) return null` 패턴 동일).

### 3.6 Styling (G6)

`tokens.ts` 에 canvas-tokens.d.ts 의 light/dark 팔레트 미러:

```ts
export const diffTokens = {
  dark:  { insertedLine: "#3FA26633", removedLine: "#B8004933",
           stripAdded: "#3FA2668F", stripRemoved: "#FC6B838F" },   // canvas-tokens.d.ts:27-30
  light: { insertedLine: "#1F8A651F", removedLine: "#CF2D5614",
           stripAdded: "#1F8A65CC", stripRemoved: "#CF2D56CC" },   // canvas-tokens.d.ts:58-61
}
export const colorPalette = { gray:"#8888A8E0", purple:"#7B64B8F0", green:"#1F8A65E8",
  yellow:"#E8C030E0", pink:"#C85898E0", blue:"#2E79B5E0", orange:"#F0A040E0" } as const  // :126
export const usageColorSequence = [...] as const                    // canvas-tokens.d.ts:144
```

web-frontend는 `tailwind.config.js` 가 `darkMode: 'class'` (README.md:112 — `<html class="dark">`). diff/usage 배경색은 인라인 `style={{ background: token }}` 으로 token을 적용(Tailwind arbitrary value도 가능하나 token map이 단일 진실 원천이라 inline이 명확). 텍스트/스트로크는 기존 `neutral-*` Tailwind 스케일 유지. **하드코딩 hex 금지** — 전부 `tokens.ts` 경유 (canvas SDK 규칙 index.d.ts:8 미러).

다크/라이트 전환: web-frontend는 현재 dark-only (README.md:149). `tokens.ts` 는 양쪽을 다 노출하되 v1은 dark 기본; light은 `<html>` class 감지 hook 으로 v2.

### 3.7 Accessibility
- DiffView: `role="table"`, 각 라인 `role="row"`; added/removed에 `aria-label="added line"/"removed line"` (색만으로 의미 전달 금지 — accent strip + aria 둘 다). monospace `font-mono`.
- UsageBar: `role="img"` + `aria-label="context usage: 64% full, 76.8k of 120k tokens"`; 각 세그먼트 `title` 툴팁 (id + tokens + %).
- 색약 대비: insertedLine/removedLine 은 33/14 alpha라 배경 대비 충분. accent strip(8F/CC alpha)이 색 외 추가 신호.

---

## 4. Edge Cases

| 케이스 | 처리 |
| --- | --- |
| Huge diff | daemon-side에서 CLI와 동일 cap 적용: 64 KiB/side (`DEFAULT_MAX_BYTES`, diff-preview.ts:42) + 200 line (`DEFAULT_MAX_LINES`, :45). 초과 시 `truncated: true` + lines를 잘라 송신; DiffView가 하단에 `… (N more lines)` (clip() 미러, diff-preview.ts:345). 추가로 컴포넌트 레벨 200+ 행이면 window virtualization은 v2 (v1은 cap으로 충분). |
| Binary file | daemon이 `binary: true` 만 송신 (lines 생략); DiffView는 `"[binary file; preview skipped]"` placeholder (diff-preview.ts:132,357 의 NUL 검출을 daemon이 재사용). |
| No usage yet | `useContextUsage` 가 `null` → UsageBar 미렌더 (first turn 전 `view()` 가 undefined, context-usage-snapshot.ts:45). |
| total/max = 0 | `percentFull` 가 0 반환 (viewPercent status-line.ts:117 의 `if (!(b.max > 0)) return 0`); remainder span이 전체를 채움. NaN 금지. |
| segment value 비유한/음수 | `≤0`/non-finite ⇒ 0 (usage-bar.d.ts:14 contract). adapter에서 클램프. |
| Dark/light theme | tokens.ts 양쪽 노출; `<html class="dark">` 감지. v1 dark. |
| 같은 toolCallId 재emit | `useToolDiffs` Map by toolCallId — overwrite (latest wins). |
| WS 끊김 | 기존 reconnect (reconnect.ts) 그대로; 재연결 시 daemon이 snapshot 재송신은 v2, v1은 다음 turn의 delta로 자연 복구. |

---

## 5. Test Plan

web-frontend의 기존 vitest 셋업 사용 (`npm run test`, README.md:128-138). DOM 컴포넌트 테스트는 `@testing-library/react` (이미 `MessageBubble.test.tsx` 존재 → jsdom 환경 확인됨).

**Component tests:**
- `DiffView.test.tsx`: added/removed/unchanged 라인이 각각 올바른 배경 token + aria-label로 렌더; `showLineNumbers=false` 시 gutter 없음; `coloredLineNumbers` on/off; accent strip 토글; 빈 `lines` → 빈 컨테이너(throw 안 함).
- `DiffStats`: `additions=0,deletions=0` ⇒ null; `+5`/`-2` glyph + tabular-nums.
- `UsageBar.test.tsx`: 세그먼트 width가 value에 비례(합 = total - remainder); remainder span = `max(0, total - Σ)`; color 미지정 시 usageColorSequence 순환; topLeft/topRight 라벨; `total=0` ⇒ NaN 없음, remainder 100%.

**Adapter tests (lossless 봉인):**
- `diff-adapter.test.ts`: `DiffOp[]` → `DiffLineData[]` round-trip — keep→unchanged/del→removed/add→added; lineNumber gutter가 diff-view.d.ts:118-123 예제와 일치; additions/deletions 카운트 정확.
- `usage-adapter.test.ts`: `SegmentedUsageView` → `UsageBarProps` — segments id/value 보존; 라벨이 `formatSegmentedUsage` head 의미와 일치(64% Full · 76.8k/120k); `max=0` 폴백.

**Empty/edge:**
- no-usage ⇒ UsageBar null; binary ⇒ placeholder; truncated ⇒ "more lines" 표시.

**Hook tests:** `canvas-hooks.test.ts` — stub `CanvasSource` 로 `tool.diff`/`context.usage` 프레임 주입 → state 갱신 (observability-hooks.test 패턴 미러).

회귀 fence: chat 경로 컴포넌트(`MessageBubble`/`ChatPanel`)에는 import/변경 0 — diff/usage는 별도 트리.

---

## 6. File-by-File Change List

### NEW — frontend (apps/web-frontend/src/)
| 파일 | 내용 |
| --- | --- |
| `components/canvas/tokens.ts` | colorPalette/usageColorSequence/diffTokens (canvas-tokens 미러, light+dark) |
| `components/canvas/DiffView.tsx` | DiffViewProps 컴포넌트 (G1) |
| `components/canvas/DiffStats.tsx` | DiffStats (G2) |
| `components/canvas/UsageBar.tsx` | UsageBarProps 컴포넌트 (G3) |
| `components/canvas/charts/BarChart.tsx`, `PieChart.tsx` | inline SVG charts (G8 stretch) |
| `components/DiffPanel.tsx` | DiffStats header + DiffView body card wrapper |
| `adapters/diff-adapter.ts` | diffOpsToLines + stats 도출 (G4) |
| `adapters/usage-adapter.ts` | segmentedViewToUsageBar (G4) |
| `ws/canvas-hooks.ts` | useToolDiffs / useContextUsage + CanvasSource |
| `types/protocol.ts` (EDIT) | `ToolDiffMessage`/`ContextUsageMessage`/`DiffLineData` local copy 추가 |
| 테스트 5개 | DiffView/UsageBar/diff-adapter/usage-adapter/canvas-hooks |

### NEW/EDIT — upstream (src/)
| 파일 | 내용 |
| --- | --- |
| `src/protocol/canvas/messages.ts` (NEW) | ToolDiffMessage/ContextUsageMessage 정본 + type guards + encode/decode (observability/messages.ts 패턴 미러) |
| `src/apps/cli/diff-preview.ts` (EDIT, 추가만) | `diffLines`/`renderUnified` 옆에 `diffOps()` export — 기존 `DiffOp[]` 를 ANSI 직렬화 전에 반환하는 순수 함수 노출 (현재 internal). 기존 ANSI 경로 byte-identical 유지. |
| `src/apps/web-daemon/server.ts` (EDIT) | `canvasPorts?: CanvasEmitterPorts` optional + `attachCanvasSink(ws, ports)` (observability sink 동형, server.ts:90-111). gate OFF ⇒ undefined. |
| `src/apps/web-daemon/canvas-emitter.ts` (NEW) | per-connection emitter: diff/usage seam → frame. 64KiB/200-line cap + binary 검출 재사용 (diff-preview helpers). |
| composition root (EDIT) | `QUANTA_WEB_CANVAS=1` 일 때만 canvasPorts 주입 + agent seam(`onPromptAssembled`, tool-approved/completed) → emitter 배선. |
| `docs/decisions/0435-canvas-web-components.md` (NEW) | ADR |

**Slice fence:** frontend `canvas/`/`adapters/` 는 `@/agent` import 금지(protocol.ts:303 규칙 동일); diff math는 daemon-side에만. `diff-preview.ts` 변경은 **export 추가만**(기존 ANSI 출력 불변 — diff-preview byte-identical 테스트 통과 필수).

---

## 7. ADR Suggestion

**ADR-0435 — Canvas Web Components (render-side DiffView + UsageBar).**
- Context: web/Tauri 표면이 basic chat; diff/usage 데이터는 CLI에서 이미 계산.
- Decision: Cursor `cursor/canvas` prop 형태를 미러한 render-side React 컴포넌트 + lossless adapter + 신규 WS 채널 2개(default-OFF). 코드-실행 canvas 샌드박스는 명시적 future.
- Consequences: web 표면 SOTA 근접; 재계산 없음; chat UI 불변. Negative invariant: agent-authored `.canvas.tsx` 실행 미도입; diff math web 복제 금지.

---

## 8. SOTA++ Justification

- **재계산 없음:** diff(diff-preview.ts) + segmented usage(context-usage-snapshot.ts) 데이터를 그대로 WS로 흘려 web에서 형태변환만. 단일 진실 원천.
- **검증된 prop API 미러:** Cursor `cursor/canvas` SDK의 `DiffViewProps`/`UsageBarProps`/`colorPalette`/chart shapes를 1:1 흡수 — 성숙한 컴포넌트 계약.
- **theme tokens:** canvas-tokens 의 light/dark diff/category 팔레트 미러, 하드코딩 hex 0.
- **slice-fenced + default-OFF:** 신규 트리(canvas/adapters/protocol·canvas), chat 경로 무변경, gate OFF ⇒ dead weight. observability(ADR-0420) sink 패턴 재사용으로 daemon 배선 위험 최소.

## 9. Effort

| 작업 | 규모 |
| --- | --- |
| frontend 컴포넌트 + adapter + hooks + 테스트 (G1–G4,G6,G7) | M (~1.5d) |
| protocol/canvas + daemon emitter + diff-preview export + 배선 (G5) | M (~1d) |
| charts (G8 stretch) | S (~0.5d) |
| **합계 (G8 제외)** | **~2.5d, 1 ADR, slice-fenced** |

Future (별도 RFC): NG1 agent-authored `.canvas.tsx` 실행 샌드박스 (esbuild→proto→host webview + useCanvasState/Action RPC) — 무거움, ROI 별도 평가.
