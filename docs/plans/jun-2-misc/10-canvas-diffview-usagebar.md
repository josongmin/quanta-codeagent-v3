# RFC: Rich DiffView (side-by-side + collapsible hunks) + Labeled Segmented UsageBar — Web/Tauri 표면

**Status:** Draft (implementation-ready)
**Surface:** `apps/web-frontend` (Vite + React 18 + Tailwind 3.4), Tauri 쉘 공유 — [[surface-model]]
**ADR suggestion:** ADR-0436 (06 RFC가 0435를 점유; 0435는 06의 base 컴포넌트, 0436은 이 RFC의 rich-layer)
**Posture:** closed-port / DI, **default-OFF / feature-gated** (06의 데이터 채널이 OFF면 dead weight; chat UI byte-unchanged)
**Author lens:** Cursor `cursor/canvas` SDK 중 06이 의도적으로 **흡수하지 않은** 표면 — `collapsible-section.d.ts` / `swatch.d.ts` + side-by-side diff layout.

---

## 0. 06과의 경계 (반드시 먼저 읽을 것)

이 RFC는 **자매 RFC `docs/plans/jun-2-misc/06-canvas-web-components.md` 위에 쌓는 rich-layer**다. 06이 이미 끝낸 것을 **다시 만들지 않는다**:

| 06이 이미 소유 (이 RFC는 재사용·cross-ref만) | 근거 (06 line) |
| --- | --- |
| `DiffView` 기본 컴포넌트 (inline/unified, `DiffLineData[]`) | 06:27, 06:78-96 |
| `DiffStats` (`+N`/`-N` glyph) | 06:29, 06:100 |
| `UsageBar` 기본 primitive (segments + remainder + topLeft/topRight) | 06:29, 06:102-117 |
| lossless adapter (`diffOpsToLines` / `segmentedViewToUsageBar`) | 06:30-32, 06:123-165 |
| **데이터 포트** (`tool.diff` / `context.usage` WS 프레임, daemon emitter, gate `QUANTA_WEB_CANVAS=1`) | 06:33, 06:167-217, 06:304-314 |
| `tokens.ts` (`colorPalette` 7색 / `usageColorSequence` / `diffTokens`) | 06:34, 06:119, 06:223-239 |
| charts (BarChart/PieChart, stretch) | 06:36, 06:121 |

**이 RFC가 추가하는 것 (06이 명시적으로 제외한 표면):**
1. **(A) Rich DiffView** — 06의 flat `DiffLineData[]` 는 **inline-only**다. 06은 side-by-side 레이아웃도, **collapsible hunk**도 다루지 않는다 (06:41 NG3가 `collapsible-section` 미흡수를 명시). 이 RFC는 (a) **side-by-side 2-column 모드**와 (b) **hunk 단위 접기**(unchanged 컨텍스트를 fold)를 추가한다. Cursor `collapsible-section.d.ts:10-31` 미러.
2. **(B) Labeled UsageBar 주변 chrome** — 06은 bar **primitive**만 만든다. 이 RFC는 (a) `ContextUsageBreakdown` 를 **직접** 소비하는 `Swatch` 범례(legend) + 카테고리별 `CollapsibleSection` 드릴다운, (b) 좌/우 라벨 슬롯의 의미를 `formatSegmentedUsage` (status-line.ts:158) 와 정합. Cursor `swatch.d.ts:11-15` + `collapsible-section.d.ts` 미러.

**데이터 포트는 06에 위임한다.** 이 RFC는 `tool.diff` 프레임에 **hunk 메타 1개 필드**(`hunks`)를 additive로 더할 뿐, 새 WS 채널을 만들지 않는다(§4.3). 만약 06이 그 필드까지 흡수하면 이 RFC는 컴포넌트-only로 축소된다.

> **데이터 모델 정정 (06 대비):** 06:16/06:152 는 usage 데이터를 `SegmentedUsageView` (status-line.ts:108) 로 다룬다. 그러나 **진짜 원천은 `ContextUsageBreakdown`** (usage-breakdown.ts:101) 으로, segment가 `{id, tokens, **chars**, **color**}` (usage-breakdown.ts:90-99) 를 갖는다. `SegmentedUsageView` 는 그것의 **구조적 부분집합**(`{id,tokens}`만, status-line.ts:109 주석)이라 `color`/`chars` 가 손실된다. 이 RFC의 Swatch 범례는 카테고리별 색이 필요하므로 **`ContextUsageBreakdown` 를 직접 소비**한다 (task brief 요구사항과 일치).

---

## 1. 배경

### 1.1 Cursor Canvas SDK — 06이 남긴 두 컴포넌트

Cursor `cursor/canvas` SDK는 06이 흡수한 `DiffView`/`UsageBar` 외에 **두 개의 보조 primitive**를 더 노출한다. 06은 이를 NG3(06:41)로 미룬다:

- **`Swatch`** — `swatch.d.ts:11-15`:
  ```ts
  export type SwatchProps = {
    color: Color   // 7-hue 공유 팔레트 (canvas-tokens)
    style?: CSSProperties
  }
  ```
  주석(swatch.d.ts:5-8, :22-23)이 핵심 의도를 못박는다: *"a category's swatch and its `UsageBar` segment for the same `color` stay visually coherent"*. 즉 Swatch는 **UsageBar segment 색과 같은 팔레트를 공유하는 카테고리 배지**다 — 범례·legend·드릴다운 행의 leading 아이콘 용.

- **`CollapsibleSection`** — `collapsible-section.d.ts:10-31`:
  ```ts
  export type CollapsibleSectionProps = {
    title: string
    leading?: ReactNode   // 예: <Swatch>
    count?: number        // 자식 수
    trailing?: ReactNode  // 예: 토큰 readout / 뱃지
    children?: ReactNode  // 펼쳤을 때 본문
    style?: CSSProperties
  }
  ```
  주석(collapsible-section.d.ts:32-43)이 정확히 이 RFC의 두 use-case를 묘사한다: *"Compose with `<Swatch>` in the `leading` slot ... put a token readout / pill in `trailing`. Body content is indented ... so nested `CollapsibleSection`s read as a tree."* + *"Always starts closed (uncontrolled, no `defaultOpen`)"*. 이건 (A) diff hunk 접기와 (B) usage 카테고리 드릴다운 **둘 다**의 빌딩블록이다.

### 1.2 GUI 표면에서 rich diff/usage가 ANSI를 이기는 이유

CLI는 한 줄 ANSI bar(`formatSegmentedUsage` head, status-line.ts:175)와 unified +/- diff(`renderUnified`, diff-preview.ts:252)로 충분하다 — 스크롤·hover·클릭이 없으니까. GUI(web/Tauri)는 다르다:

- **Side-by-side diff**: 큰 edit에서 old↔new 정렬이 inline보다 훨씬 읽기 쉽다(코드 리뷰의 표준). 06의 flat `DiffLineData[]`(inline)는 이걸 못 한다.
- **Collapsible hunk**: 200줄 cap(diff-preview.ts:45)을 친 거대 diff에서 unchanged 컨텍스트를 fold하면 변경 hunk만 보인다. CLI의 `clip()` "… (N more lines)" (diff-preview.ts:345) 보다 정보 손실이 적다.
- **Swatch 범례 + 드릴다운**: ANSI는 7색을 glyph 회전(`SEGMENT_GLYPH`, status-line.ts:125)으로 흉내내지만, GUI는 실제 색 칩(Swatch) + hover/클릭으로 카테고리별 `chars`/`tokens`/% 드릴다운을 줄 수 있다(usage-breakdown.ts:90-99 의 `chars` 는 CLI 범례에서 아예 안 쓰임 — GUI에서 살린다).

cross-ref: 06 §1(06:11-21) 이 "데이터는 이미 있고 web 표면에 rich renderer만 없다"를 확립했다. 이 RFC는 그 renderer를 **한 단계 더 rich하게** 만든다.

---

## 2. 현재 quanta

### 2.1 데이터는 이미 계산됨 (재사용 대상)

- **Diff math**: `src/apps/cli/diff-preview.ts` 의 `diffLines()` (diff-preview.ts:280) — line-level LCS(Hunt–McIlroy, diff-preview.ts:270 주석) → `DiffOp { kind: "keep"|"del"|"add"; line }` (diff-preview.ts:265-268). 현재는 `renderUnified` (diff-preview.ts:252) 가 즉시 ANSI 문자열로 직렬화한다(diff-preview.ts:257-262). **`DiffOp[]` 구조는 module-internal** — 06이 이미 "daemon-side에서 `diffOps()` export 추가"를 계획(06:308)했다. 이 RFC는 거기에 **의존**한다(중복 안 함).
- **Usage 데이터**: `ContextUsageBreakdown` (usage-breakdown.ts:101-110) = `{ segments: {id,tokens,chars,color}[], total, max, model? }`. 카테고리 enum은 `ContextCategory` (usage-breakdown.ts:41-48) = System/Tools/Rules/Skills/MCP/Subagents/Conversation, 순서는 `CATEGORY_ORDER` (usage-breakdown.ts:51-59), 색은 `CATEGORY_COLOR` (usage-breakdown.ts:62-70, ANSI named: cyan/blue/magenta/green/yellow/red/white). `breakdownPercent()` (usage-breakdown.ts:172-175) 가 NaN-free %를 준다.
- **Track D 캡처 seam**: 런타임 `onPromptAssembled` → `createContextUsageHolder().sink` (context-usage-snapshot.ts:42), `/context` → `view()` (context-usage-snapshot.ts:45) 가 `buildUsageBreakdownDefault(snapshotToBreakdownInput(latest))` 로 breakdown을 만든다(context-usage-snapshot.ts:49). **first turn 전 `view()` 는 `undefined`** (context-usage-snapshot.ts:46).
- **CLI 렌더러(참고용, 복제 금지)**: `formatSegmentedUsage` (status-line.ts:158-188) — fixed 24-cell bar(`SEGMENTED_BAR_CELLS`, status-line.ts:122) + glyph 회전(status-line.ts:125) + 카테고리별 범례 행(status-line.ts:180-186). 라벨 의미: `<total>/<max> · <pct>% Full · <model>` (status-line.ts:175). `viewPercent` (status-line.ts:116-119) 가 % 식의 단일 진실(`max<=0 ⇒ 0`).

### 2.2 web-frontend의 실제 상태 (정직)

web-frontend는 **빈약하지 않다 — 실재한다.** Vite + React 18 + Tailwind 3.4(README.md:14-16), 자체 `package.json`/`tsconfig`/vitest(README.md:7-10, :28-30). 현존 컴포넌트(README.md:108-124): `App.tsx`, `ChatPanel.tsx`, `MessageBubble.tsx`(markdown + `react-syntax-highlighter`, README.md:17), `InputBar.tsx`, `StatusBar.tsx`, `HotkeyToast.tsx`, 그리고 `ObservabilityPane.tsx`/`TokenCounter.tsx`(파일 트리 실측). WS 인프라도 실재: `ws/client.ts`(SessionClient), `ws/envelope.ts`, `ws/observability-hooks.ts`(`useObservabilityState`/`ObservabilitySource`, observability-hooks.ts:110-122), `types/protocol.ts`(upstream 타입 local copy, README.md:64-65).

**갭(README.md:140-148 가 명시한 v1 비-목표):** *"No cost / token dashboard · No diff preview for tool calls."* → **canvas 컴포넌트 디렉토리가 아예 없다** (실측: `apps/web-frontend/src/components/canvas` 부재, `apps/web-frontend/src/adapters` 부재).

즉: **데이터(diff math + ContextUsageBreakdown)는 계산되고, 06이 데이터 포트와 base 컴포넌트를 깔고, 이 RFC가 rich-layer를 얹는다.** 셋 다 새 코드지만 서로 직교.

---

## 3. Goals / Non-Goals

### Goals
- **G1. Side-by-side DiffView 레이아웃** — 06의 `DiffView`(inline)에 `layout?: "inline" | "split"` prop 추가(혹은 형제 `SplitDiffView`). 같은 `DiffLineData[]` 입력에서 del↔add 를 좌/우 2-column으로 정렬 렌더. **06의 diff math 재사용** — 새 LCS 없음.
- **G2. Collapsible hunk** — 인접 `unchanged` 런(run)을 hunk 경계로 그루핑, N줄(default 3) 컨텍스트만 보이고 나머지는 `CollapsibleSection` 으로 fold. Cursor `collapsible-section.d.ts` 미러(uncontrolled, closed-default).
- **G3. `Swatch` 컴포넌트** — `swatch.d.ts:11-15` 미러. 7-hue 팔레트(06의 `tokens.ts#colorPalette` 재사용) 24px 둥근 칩.
- **G4. `CollapsibleSection` 컴포넌트** — `collapsible-section.d.ts:10-31` 미러. title/leading/count/trailing/children, uncontrolled closed-default(collapsible-section.d.ts:33).
- **G5. `UsageBreakdownPanel`** — `ContextUsageBreakdown` 를 **직접** 소비. 상단에 06의 `UsageBar`(좌/우 라벨 슬롯 채움) + 그 아래 카테고리별 `CollapsibleSection` 행(leading=`Swatch`, trailing=`tokens (chars · %)`). 좌/우 라벨은 `formatSegmentedUsage` head 의미(status-line.ts:175) 와 정합.
- **G6. 카테고리→Color 매핑** — `ContextCategory`(usage-breakdown.ts:41) 의 ANSI named color(`CATEGORY_COLOR`, usage-breakdown.ts:62) → 06 `tokens.ts#colorPalette` 의 7-hue `Color` 로 1:1 매핑. CLI Swatch와 web Swatch가 같은 카테고리=같은 색(swatch.d.ts:22-23 contract).
- **G7. default-OFF / feature-gated** — 데이터(06 채널)가 없으면 `UsageBreakdownPanel`/리치 diff는 `null` 렌더. chat UI 변경 0.

### Non-Goals
- **NG1.** 새 WS 채널·daemon emitter·gate — **06 소유**(06:167-217, 06:304-314). 이 RFC는 `tool.diff` 프레임에 optional `hunks` 1필드만 additive(§4.3); usage 채널은 06의 `context.usage` 를 그대로 쓰되 **`color`/`chars` 가 손실되지 않도록** 06의 frame shape에 두 필드 추가를 요청(§4.3, 06이 거부하면 컴포넌트가 색을 카테고리 id에서 자체 매핑 — fallback 명시).
- **NG2.** diff math 재계산/web 복제 — 06 NG5(06:43) 와 동일. `DiffLineData[]` 만 받는다.
- **NG3.** syntax highlighting(per-line Shiki/Prism) — 06 NG2(06:40) 와 동일하게 v2. `path`/`language` prop은 받되 forward만.
- **NG4.** agent-authored `.canvas.tsx` 실행 샌드박스 — 06 NG1(06:39) 와 동일. render-side only.
- **NG5.** 인터랙티브 diff 편집(stage/unstage hunk) — 06 NG4(06:42) 와 동일. read-only. 접기만 인터랙티브.
- **NG6.** `dag-layout`/`form-primitives`/`todo-list` 등 나머지 canvas SDK 표면 — 미흡수.

---

## 4. 설계

### 4.1 (A) Rich DiffView

#### 4.1.1 입력 — 06의 모델 재사용
06이 정의한(06:81-95) `DiffLineData` 를 그대로 입력으로 받는다:
```ts
type DiffLineType = "added" | "removed" | "unchanged"
interface DiffLineData { readonly type: DiffLineType; readonly content: string; readonly lineNumber?: number }
```
이건 daemon이 `diffOps()`(06:308 가 export 추가) → `diffOpsToLines()`(06:131) 로 변환해 보낸 것. **이 RFC는 그 배열을 받아 hunk로 재구성만** 한다 — diff math 0.

#### 4.1.2 Hunk 그루핑 (G2) — 순수 함수
```ts
// apps/web-frontend/src/components/canvas/diff-hunks.ts  (NEW, 순수)
export interface DiffHunk {
  readonly lines: readonly DiffLineData[]
  readonly collapsed: boolean   // 전부 unchanged이고 contextLines 초과 ⇒ 접힘 후보
}
export const groupHunks = (
  lines: readonly DiffLineData[],
  contextLines = 3,         // 변경 주변 보존 컨텍스트 (git diff 기본과 동일)
): readonly DiffHunk[]
```
규칙(결정적, n=1 휴리스틱 아님 — git diff 의 검증된 contextLines 모델 차용, [[no-heuristics-only-validated]]):
- `added`/`removed` 런과 그 앞뒤 `contextLines` 줄은 항상 visible hunk.
- 그 사이의 `unchanged` 런이 `2*contextLines` 초과면 → fold 가능 hunk(`collapsed:true`), `CollapsibleSection`(title=`… N unchanged lines`, count=N) 로 렌더.
- 변경이 전혀 없으면(전부 unchanged) → 단일 collapsed hunk.

#### 4.1.3 레이아웃 (G1)
`DiffView` 에 06 prop 외 `layout?: "inline" | "split"` (default `"inline"` — 06 기본과 호환) 추가. split 모드:
- del/unchanged → 좌 column(old-side `lineNumber`), add/unchanged → 우 column(new-side).
- `groupHunks` 결과의 각 변경 hunk에서 del↔add를 **순서대로 zip**(짝 없는 쪽은 빈 셀). LCS가 이미 del→add 순서로 op를 내므로(backtrack, diff-preview.ts:319-324) 추가 정렬 불필요.
- unchanged 줄은 양 column 동일 content.
- collapsed hunk는 양 column에 걸친 단일 `CollapsibleSection` 행.

> split의 정렬은 **시각적 짝짓기일 뿐 새 alignment 알고리즘이 아니다.** LCS op 순서를 그대로 따른다 — 06의 inline과 동일한 데이터, 표현만 2-column.

#### 4.1.4 컴포넌트 트리
```
<DiffView layout="split" lines={...}>            ← 06 DiffView 확장
  └ groupHunks(lines, 3)
      ├ <DiffHunkRows hunk={visible} layout="split"/>     ← changed hunk
      └ <CollapsibleSection title="… 42 unchanged lines" count={42}>  ← collapsed hunk (G4)
          └ <DiffHunkRows hunk={folded} layout="split"/>
```

### 4.2 (B) Labeled Segmented UsageBar

#### 4.2.1 입력 — `ContextUsageBreakdown` 직접
06의 `UsageBar` primitive(06:102-117)는 `{segments:{id,value,color?}, total, topLeft/RightLabel}` 만 받는다(색·chars 손실). 이 RFC의 `UsageBreakdownPanel` 은 **`ContextUsageBreakdown`**(usage-breakdown.ts:101) 을 받아 색/chars/카테고리를 보존하고, **내부에서** 06 `UsageBar` 로 변환해 bar를 그린다:

```ts
// apps/web-frontend/src/components/canvas/UsageBreakdownPanel.tsx  (NEW)
interface UsageBreakdownPanelProps {
  readonly breakdown: ContextUsageBreakdownDTO   // protocol local copy (color 포함, §4.3)
  readonly className?: string
}
```

#### 4.2.2 카테고리 → Color (G6)
`CATEGORY_COLOR`(usage-breakdown.ts:62, ANSI named) → 06 `tokens.ts#colorPalette`(7-hue) 매핑. ANSI named ≠ Cursor 7-hue 이므로 명시 테이블:
```ts
// canvas-tokens 의 7 hue: gray/purple/green/yellow/pink/blue/orange (06:119, 06:234)
// usage-bar.d.ts:44-50 예제가 정본 매핑을 보여줌:
const CATEGORY_TO_HUE = {
  System: "gray", Tools: "purple", Rules: "green", Skills: "yellow",
  MCP: "pink", Subagents: "blue", Conversation: "orange",
} as const   // ← usage-bar.d.ts:44-50 예제와 1:1 (Cursor가 박아둔 정본)
```
> **근거:** `usage-bar.d.ts:44-50` 의 `@example` 가 정확히 System=gray/Tools=purple/Rules=green/Skills=yellow/MCP=pink/Subagents=blue/Conversation=orange 를 박아뒀다. 이게 Cursor의 의도된 카테고리 팔레트 — 우리 `CATEGORY_ORDER`(usage-breakdown.ts:51)와 카테고리 이름이 정확히 일치하므로 그대로 채택. 휴리스틱 아님, 흡수.

#### 4.2.3 레이아웃
```
<UsageBreakdownPanel breakdown={...}>
  ├ <UsageBar                                  ← 06 primitive 재사용
  │    segments={ breakdown.segments → {id,value:tokens,color:hue} }
  │    total={ breakdown.max>0 ? breakdown.max : breakdown.total }
  │    topLeftLabel={`${breakdownPercent}% Full`}            ← status-line.ts:174 의미
  │    topRightLabel={`${fmt(total)} / ${fmt(max)} Tokens`}/>  ← status-line.ts:175 의미
  └ for each segment (CATEGORY_ORDER 순):
       <CollapsibleSection
          title={category}                      ← "Tools"
          count={undefined}                     ← (카테고리엔 자식 없음; 토큰만)
          leading={<Swatch color={hue}/>}       ← G3, swatch.d.ts:22-23 color coherence
          trailing={`${fmt(tokens)}  ${fmt(chars)}ch · ${share}%`}>  ← chars 살림 (usage-breakdown.ts:96)
         {/* 드릴다운 본문: tokens/chars/% 상세 + (v2) 어떤 section이 기여했나 */}
       </CollapsibleSection>
```
- 좌/우 라벨 텍스트는 `formatSegmentedUsage` head(status-line.ts:175) 의미를 **순수 재현** — `breakdownPercent`(usage-breakdown.ts:172) 와 동일 식, 새 % 휴리스틱 금지.
- `share` = `total>0 ? round(tokens/total*100) : 0` — status-line.ts:184 와 동일 식.
- **`chars` 를 trailing에 노출** — CLI 범례(status-line.ts:185)는 chars를 안 쓴다. GUI에서 살리는 게 이 RFC의 부가가치(usage-breakdown.ts:95-96 의 데이터가 비로소 쓰임).

### 4.3 데이터 포트 (06에 위임 + 2개 additive 필드)

**새 WS 채널을 만들지 않는다.** 06의 `tool.diff`(06:183-194) / `context.usage`(06:195-202) 프레임을 그대로 쓴다. 단 두 가지 additive 필드를 06 frame shape에 요청한다(전부 optional ⇒ 06 byte-compat):

1. `ToolDiffMessage` 에 hunk 메타 — **불필요.** `hunks` 는 **프론트엔드 `groupHunks()` 가 `lines` 에서 파생**(§4.1.2)하므로 wire에 추가 필드 0. (daemon이 200줄 cap 후 truncated만 보내면, 프론트가 받은 범위 내에서 hunk 그루핑.)
2. `ContextUsageMessage` 에 **`color`/`chars` 보존** — 06:197 은 segment를 `{id, tokens}` 로만 직렬화(색/chars 손실). Swatch 범례엔 카테고리만 있으면 색을 **자체 매핑**(§4.2.2 `CATEGORY_TO_HUE`)할 수 있으므로 **색은 wire 불필요**. 단 `chars`(usage-breakdown.ts:96)는 파생 불가 → segment를 `{id, tokens, chars?}` 로 확장 요청(optional). 06이 거부하면 trailing에서 `chars` 만 생략(graceful).

> **결론:** 이 RFC는 **wire 스키마 변경 0(필수) / +1 optional 필드(`chars`, nice-to-have)**. 데이터 포트·gate·emitter는 100% 06 소유. 컴포넌트가 06의 프레임 핸들러 hook(`useContextUsage`/`useToolDiffs`, 06:212-213)에서 데이터를 받아 `CATEGORY_TO_HUE` 로 색을 입힌다.

frontend 색 매핑은 `breakdown.segments[].id`(= `ContextCategory` 문자열) → `CATEGORY_TO_HUE` → `tokens.ts#colorPalette[hue]`. id가 알 수 없는 카테고리면 `usageColorSequence`(06:236) 인덱스 순환(06 기본과 동일 fallback).

### 4.4 위치 & closed-port / default-OFF
```
apps/web-frontend/src/components/canvas/   ← 06이 만드는 디렉토리에 추가
├── Swatch.tsx                 ← G3 (swatch.d.ts 미러)
├── Swatch.test.tsx
├── CollapsibleSection.tsx     ← G4 (collapsible-section.d.ts 미러)
├── CollapsibleSection.test.tsx
├── diff-hunks.ts              ← G2 순수 hunk 그루핑
├── diff-hunks.test.ts
├── SplitDiffView.tsx          ← G1 (또는 06 DiffView에 layout prop 추가)
├── SplitDiffView.test.tsx
├── UsageBreakdownPanel.tsx    ← G5 (ContextUsageBreakdown 직접 소비)
├── UsageBreakdownPanel.test.tsx
└── category-hues.ts           ← G6 CATEGORY_TO_HUE + breakdown→UsageBarProps 어댑터
    + category-hues.test.ts
```
- **default-OFF:** 06의 데이터 채널(gate `QUANTA_WEB_CANVAS=1`, 06:207)이 OFF면 `useContextUsage()`(06:213)=null ⇒ `UsageBreakdownPanel` 은 `null` 렌더(TokenCounter.tsx 의 `turns===0 ⇒ null` 패턴과 동형, 06:221). chat UI 무변경.
- **closed-port:** `category-hues.ts`/`diff-hunks.ts` 는 순수(no React, no WS, no `@/agent`). 컴포넌트는 props-in/JSX-out. slice fence: frontend `canvas/` 는 `@/agent` import 금지(06:314 규칙 동일).

---

## 5. 통합 — 정확한 edit point

| edit point | file:line | 변경 |
| --- | --- | --- |
| 06의 `DiffView` 에 `layout` prop | (06이 만들 `apps/web-frontend/src/components/canvas/DiffView.tsx`) | `layout?: "inline"\|"split"` 추가, split이면 `SplitDiffView` 위임. 06과 **conflict-free**(prop 추가만). 06이 먼저 land하면 1줄 prop. |
| hunk 그루핑 끼우기 | 06의 `DiffView.tsx` 본문 | flat map → `groupHunks(lines, 3)` 순회로 교체. inline 모드도 collapsed hunk를 `CollapsibleSection` 으로. |
| usage 렌더 위치 | `apps/web-frontend/src/components/ObservabilityPane.tsx` (실재) | `<UsageBreakdownPanel breakdown={useContextUsage()}/>` 를 Pane 상단에 삽입(데이터 null이면 자동 미렌더). 06:221 가 지정한 위치와 동일. |
| 색 매핑 | `category-hues.ts` (NEW) | `CATEGORY_TO_HUE`(§4.2.2) + `breakdownToUsageBarProps()`. |
| wire `chars`(optional) | 06의 `src/protocol/canvas/messages.ts#ContextUsageMessage`(06:195) | segment shape `{id,tokens}` → `{id,tokens,chars?}`. daemon emitter가 `view()`(context-usage-snapshot.ts:45)의 `ContextUsageBreakdown.segments[].chars`(usage-breakdown.ts:96) 를 그대로 직렬화. **06 emitter 한 줄.** |
| protocol local copy | `apps/web-frontend/src/types/protocol.ts` (실재) | 06이 추가할 `ContextUsageMessage` local copy에 `chars?` 미러(06:301 가 추가하는 블록에 1필드). |

**핵심:** 06이 먼저 land하는 게 이상적(이 RFC가 06의 `DiffView`/`UsageBar`/data-port에 의존). 06과 병렬이면 `canvas/` 디렉토리 공유로 인한 파일 충돌만 주의 — 이 RFC의 신규 파일(Swatch/CollapsibleSection/diff-hunks/SplitDiffView/UsageBreakdownPanel/category-hues)은 06의 신규 파일과 **이름이 겹치지 않음**(충돌 0). 유일 공유 편집점은 06 `DiffView.tsx`(layout prop)·06 `ContextUsageMessage`(chars).

---

## 6. Edge cases

| 케이스 | 처리 | 근거 |
| --- | --- | --- |
| 거대 diff (>200줄) | daemon이 06의 cap(64KiB/200줄, diff-preview.ts:42/45) 적용 후 `truncated:true`(06:191) 송신. 프론트는 받은 범위에서 `groupHunks`. **컴포넌트 virtualization은 v2** — collapsed hunk가 이미 DOM 노드 수를 줄임(접힌 hunk는 자식 미렌더, collapsible-section.d.ts:33 closed-default). 200줄·다수 hunk fold면 v1 충분. | diff-preview.ts:345, collapsible-section.d.ts:33 |
| binary / no-diff | daemon이 `binary:true`(06:188) 또는 lines 생략 → DiffView placeholder(06:255). split 모드도 동일 placeholder(양 column 안 그림). | diff-preview.ts:357 (NUL 검출) |
| `max=0` unknown window (Track D 알려진 이슈) | `breakdownPercent`(usage-breakdown.ts:173)=`!(max>0)⇒0`. UsageBar total fallback=`breakdown.total`(06:159 와 동일), 좌라벨 `% Full` 대신 **`?` 로 degrade**(status-line.ts:78 의 `(?)` 와 동형) — `0% Full` 거짓표시 방지. remainder span=0. NaN 금지. | usage-breakdown.ts:166, status-line.ts:29 |
| 빈 segments | `breakdown.segments=[]` → UsageBar는 remainder만(06:107), 범례 행 0. 패널은 헤더만(또는 null). | usage-breakdown.ts:155 (empty omit) |
| segment value 음수/비유한 | 06 `UsageBar` contract(`≤0/non-finite⇒0`, usage-bar.d.ts:12-13, 06:107) 가 클램프. `breakdownToUsageBarProps` 에서 한 번 더 `Math.max(0, tokens)`. | usage-bar.d.ts:12 |
| 색약 (color-blind) | Swatch 단독으론 색만으로 카테고리 구분 → **CollapsibleSection title이 항상 카테고리 텍스트**(collapsible-section.d.ts:12) 동반 ⇒ 색은 보조 신호. UsageBar segment엔 `aria-label`+`title`(id+tokens+%) (06:245 패턴). 색약 안전. | collapsible-section.d.ts:12 |
| SSR/hydration | web-frontend는 **CSR-only**(Vite SPA, `main.tsx` 클라 마운트, README.md:107). SSR 없음 ⇒ hydration mismatch 무관. `CollapsibleSection` uncontrolled open state는 마운트 후 `useState`(collapsible-section.d.ts:33). | README.md:107 |
| 같은 toolCallId 재emit | 06의 `useToolDiffs` Map by toolCallId(06:212, latest-wins). hunk fold 상태는 컴포넌트-local이라 재emit 시 리셋(read-only 뷰라 무해). | 06:260 |

---

## 7. 테스트

web-frontend의 기존 vitest + `@testing-library/react`(jsdom; `MessageBubble.test.tsx` 가 이미 DOM 렌더 테스트 → 환경 확인됨, README.md:128-138).

**순수 함수 (DOM 무관, 봉인):**
- `diff-hunks.test.ts` — `groupHunks`: (a) 변경 주변 contextLines 보존, (b) 긴 unchanged 런 → `collapsed:true` hunk, (c) 전부 unchanged → 단일 collapsed, (d) contextLines=0/큰 값 경계, (e) 빈 입력 → `[]`(throw 안 함). **결정성**: 같은 입력 = 같은 hunk 분할.
- `category-hues.test.ts` — `CATEGORY_TO_HUE` 가 `usage-bar.d.ts:44-50` 예제 매핑과 1:1; 알 수 없는 id → `usageColorSequence` 순환(06 fallback); `breakdownToUsageBarProps`: tokens<0 클램프, max=0 fallback=total, 라벨 의미 = `formatSegmentedUsage` head(status-line.ts:175).

**컴포넌트 (jsdom):**
- `Swatch.test.tsx` — 7 hue 각각 올바른 배경 token; 같은 color = UsageBar segment 와 동일 hex(swatch.d.ts:22-23 coherence 봉인).
- `CollapsibleSection.test.tsx` — closed-default(collapsible-section.d.ts:33: children 미렌더); chevron 클릭 → 펼침; leading/count/trailing 슬롯; 빈 children → 펼쳐도 빈 본문(throw 안 함).
- `SplitDiffView.test.tsx` — del↔add zip 정렬(짝 없는 쪽 빈 셀); unchanged 양 column 동일; collapsed hunk가 `CollapsibleSection` 으로; `layout="inline"` 회귀(06 동작 보존); 빈 lines.
- `UsageBreakdownPanel.test.tsx` — `ContextUsageBreakdown` fixture → UsageBar + 카테고리별 CollapsibleSection(leading Swatch 색 = CATEGORY_TO_HUE); trailing 에 tokens/chars/%; `max=0` ⇒ 좌라벨 `?`(0% Full 아님); 빈 segments ⇒ 패널 null/헤더만; 데이터 null ⇒ 미렌더(default-OFF 봉인).

**데이터-포트 계약 테스트:** 06이 `useContextUsage`/`useToolDiffs` 와 frame 계약을 소유하므로 **이 RFC는 stub `ContextUsageBreakdown` fixture 로 컴포넌트만 검증**. wire 계약(frame→hook)은 06의 `canvas-hooks.test.ts`(06:281) 에 위임. 단 `chars?` optional 필드가 없을 때 trailing graceful(생략) 케이스 1개 추가.

**회귀 fence:** chat 경로(`MessageBubble`/`ChatPanel`)에 import/변경 0. 06 `DiffView` 의 `layout="inline"` 기본 동작 byte-동등(06 테스트 통과 필수).

---

## 8. 파일별 변경

### NEW — frontend (`apps/web-frontend/src/components/canvas/`)
| 파일 | 내용 | Goal |
| --- | --- | --- |
| `Swatch.tsx` (+test) | 7-hue 24px 칩, `tokens.ts#colorPalette` 소비 (swatch.d.ts 미러) | G3 |
| `CollapsibleSection.tsx` (+test) | title/leading/count/trailing/children, uncontrolled closed-default (collapsible-section.d.ts 미러) | G4 |
| `diff-hunks.ts` (+test) | `groupHunks(lines, contextLines)` 순수 hunk 그루핑 | G2 |
| `SplitDiffView.tsx` (+test) | side-by-side 2-column, del↔add zip, collapsed hunk | G1 |
| `UsageBreakdownPanel.tsx` (+test) | `ContextUsageBreakdown` 직접 소비 → UsageBar + Swatch 범례 + CollapsibleSection 드릴다운 | G5 |
| `category-hues.ts` (+test) | `CATEGORY_TO_HUE` + `breakdownToUsageBarProps` | G6 |

### EDIT — frontend (06 산출물 위)
| 파일 | 변경 |
| --- | --- |
| `apps/web-frontend/src/components/canvas/DiffView.tsx` (06 NEW) | `layout?: "inline"\|"split"` prop + `groupHunks` 끼우기. conflict-free. |
| `apps/web-frontend/src/components/ObservabilityPane.tsx` (실재) | `<UsageBreakdownPanel breakdown={useContextUsage()}/>` 삽입(null-safe). |
| `apps/web-frontend/src/types/protocol.ts` (실재) | 06이 추가할 `ContextUsageMessage` local copy segment에 `chars?` 미러. |

### EDIT — upstream (`src/`)
| 파일 | 변경 |
| --- | --- |
| `src/protocol/canvas/messages.ts` (06 NEW) | `ContextUsageMessage` segment `{id,tokens}` → `{id,tokens,chars?}` (optional, 06 byte-compat). |
| 06의 daemon emitter (06:310 `canvas-emitter.ts`) | `view()` breakdown 의 `segments[].chars`(usage-breakdown.ts:96) 직렬화 1줄. |
| `docs/decisions/0436-canvas-rich-diff-usage.md` (NEW) | ADR |

**diff-preview.ts 변경 0** — 06 이 `diffOps()` export(06:308)를 이미 소유. 이 RFC는 LCS·diff math를 건드리지 않는다.

---

## 9. 공수

| 작업 | 규모 |
| --- | --- |
| Swatch + CollapsibleSection (G3,G4 — Cursor d.ts 1:1 미러) + 테스트 | S (~0.5d) |
| diff-hunks 순수 그루핑 + SplitDiffView (G1,G2) + 테스트 | M (~1d) |
| UsageBreakdownPanel + category-hues (G5,G6) + 테스트 | M (~1d) |
| 06 산출물 위 edit(layout prop / Pane 삽입 / chars wire) | S (~0.25d) |
| **합계** | **~2.75d, 1 ADR (0436), slice-fenced, 06 의존** |

**전제:** 06(ADR-0435)이 먼저 또는 병렬로 land. 06 미구현 시 이 RFC는 06의 base `DiffView`/`UsageBar`/data-port를 먼저 깔아야 하므로 06+이 RFC를 묶어 ~5d.

---

## 10. SOTA++ 체크리스트

- [x] **재계산 없음** — diff math(diff-preview.ts:280 LCS) + usage(usage-breakdown.ts:101) 데이터를 그대로 받아 hunk 그루핑·색 매핑만. 단일 진실 원천. [[no-heuristics-only-validated]] 준수(contextLines=git 표준, CATEGORY_TO_HUE=Cursor 정본).
- [x] **검증된 prop API 미러** — `swatch.d.ts:11-15` / `collapsible-section.d.ts:10-31` 1:1; `usage-bar.d.ts:44-50` 예제의 카테고리 팔레트를 정본으로 채택.
- [x] **06과 non-overlap** — 06이 base/adapter/data-port 소유; 이 RFC는 06 NG3(collapsible)·inline-only를 보완하는 rich-layer. cross-ref 명시(§0). wire 변경 0필수/+1 optional.
- [x] **데이터 모델 정정** — 06 의 `SegmentedUsageView`(색 손실) 대신 `ContextUsageBreakdown`(usage-breakdown.ts:101) 직접 소비로 카테고리 색·`chars` 보존. task brief 요구와 일치.
- [x] **slice-fenced + default-OFF** — 신규 `canvas/` 파일(이름 충돌 0), chat 경로 무변경, 06 데이터 채널 OFF면 dead weight. closed-port 순수 함수(diff-hunks/category-hues).
- [x] **multi-surface** — [[surface-model]] 준수. 순수 함수(groupHunks/category-hues)는 Tauri 번들에도 그대로 lift.
- [x] **a11y / 색약** — Swatch+카테고리 텍스트 이중 신호; UsageBar aria/title; SSR 무관(CSR-only).
- [x] **모든 quanta 주장 = file:line** — §2/§4/§5/§6 전부 근거 라인.

> Future(별도): syntax highlight(NG3) · diff virtualization(거대 diff §6) · hunk 드릴다운 본문에 기여 section 표시(§4.2.3 v2) · agent-authored canvas 실행(06 NG1).
