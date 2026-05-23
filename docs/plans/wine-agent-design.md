# 와인 에이전트 — 최종 설계 (SOTA++)

2026-05-23. 우리 코딩 에이전트 코드베이스 위에 **도메인 슬라이스 swap**으로
와인 검색·추천·소믈리에 대화 에이전트를 짓는 설계. ROI 무관·풀스케일. agent
loop core / LLM / stream / memory engine / permission / observability / apps/cli /
follow-up-queue / plan-mode / skill / fc-catalog / smoke battery 전부 **재사용**.
교체는 `src/{wine,tool,prompt,memory/profile}` 슬라이스로 국한.

## 0. 흡수하지 *않는* 것 (negative invariants)

- **풀스택 e-commerce**(결제·재고·배송) — 추천까지만. 거래는 surface(host)가.
- **블라인드 테이스팅 점수 자동 매김** — 모델이 와인을 "마셔봤다" 환각 금지. 점수는 catalog row의 `criticScores`만 인용.
- **음주 권유 / 페어링 강요** — 사용자가 안 묻는데 마시기 압박 금지. 미성년·임산부·금주 signal 발견 시 HARD_DENY.
- **실시간 가격 단정** — 가격은 변동성 명시 + 출처 시간 동반(`"as of YYYY-MM-DD"`).
- **PII 영속화** — 사용자 본명·주소·생년월일 기억 안 함. 닉네임·취향만.
- **자동 카트 추가/구매** — `add_to_cellar`는 사용자가 마신/구매한 와인 기록일 뿐, 결제 트리거 아님.

## 1. 도메인 모델 (closed types — 헬게이트 1차 방어막)

```ts
// src/wine/types.ts — zod 없음, plain TS (우리 hot-path 컨벤션, RFC §3.1)

export type WineStyle =
  | "still_red" | "still_white" | "still_rose"
  | "sparkling" | "fortified" | "dessert" | "orange"
export const ALL_WINE_STYLES = Object.freeze(
  ["still_red", "still_white", "still_rose", "sparkling", "fortified", "dessert", "orange"] as const,
)

export type Body = "light" | "medium" | "full"
export type Sweetness =
  | "bone_dry" | "dry" | "off_dry" | "medium_sweet" | "sweet" | "lusciously_sweet"
export type Acidity = "low" | "medium" | "medium_plus" | "high"
/** null = white/rose (탄닌 무의미). 닫힌 enum + null 명시로 누락 방지. */
export type Tannin = "low" | "medium" | "medium_plus" | "high" | null

export type Vintage = number | "NV"           // non-vintage 1급 허용
export type CriticSource = "WS" | "WA" | "JS" | "VN" | "Decanter" | "Falstaff" | "RVF"

export interface CriticScore {
  readonly source: CriticSource
  readonly score: number                       // 0-100, source별 척도는 별도 normalizer
  readonly publishedAt: number                 // unix sec
  readonly tasterNote?: string
  readonly url?: string                        // citation source
}

/** 닫힌 hierarchy: country > region > subregion > appellation */
export interface Region {
  readonly country: string                     // ISO 3166-1 alpha-2 ("FR", "IT", "KR", ...)
  readonly region: string                      // "Bordeaux"
  readonly subregion?: string                  // "Médoc"
  readonly appellation?: string                // "Pauillac"
  readonly isAOC: boolean                      // 원산지 통제 명칭 여부
}

export interface Varietal {
  readonly name: string                        // "Cabernet Sauvignon"
  readonly synonymOf?: string                  // "Shiraz"→"Syrah"
  readonly percent?: number                    // 블렌드 비율 (없으면 단일)
}

export type Allergen = "sulfites" | "egg_white" | "milk_protein" | "isinglass" | "gelatin"

export interface Wine {
  readonly id: string                          // catalog ULID
  readonly producer: string
  readonly cuvee: string                       // "Cuvée Frédéric Émile"
  readonly vintage: Vintage
  readonly region: Region
  readonly varietals: readonly Varietal[]      // 1+ (블렌드 허용)
  readonly style: WineStyle
  readonly body: Body
  readonly sweetness: Sweetness
  readonly acidity: Acidity
  readonly tannin: Tannin
  readonly abv: number                         // 0-20
  readonly priceUsd: number | null             // null = unknown (단정 금지)
  readonly priceAsOf: number | null            // unix sec (가격 staleness 표면)
  readonly criticScores: readonly CriticScore[]
  readonly tastingNotes: string                // embedding source
  readonly allergens: readonly Allergen[]
  readonly drinkingWindow?: { from: number; to: number }   // years
  readonly inventoryUrl?: string               // host가 채움(추천 후 구매처 link)
}

/** 페어링 컨텍스트 (요리 한 점). */
export type Cuisine = "korean" | "japanese" | "chinese" | "italian" | "french"
  | "spanish" | "american" | "indian" | "mexican" | "thai" | "vietnamese"
  | "middle_eastern" | "fusion" | "other"

export interface FoodItem {
  readonly name: string                        // "Bibimbap"
  readonly cuisine: Cuisine
  readonly dominantFlavor: readonly Flavor[]   // ["spicy","umami","fermented"]
  readonly fatLevel: "low" | "medium" | "high"
  readonly proteinKind?: "beef" | "pork" | "chicken" | "fish" | "shellfish" | "vegetable" | "tofu" | "mixed"
  readonly preparation?: "raw" | "grilled" | "fried" | "steamed" | "braised" | "stew" | "roasted"
}
export type Flavor =
  | "spicy" | "sweet" | "sour" | "salty" | "umami" | "bitter"
  | "smoky" | "fermented" | "creamy" | "herbal" | "fruity" | "earthy"

/** 사용자 취향 장기 메모리 (L3). */
export interface UserTasteProfile {
  readonly version: number                     // CAS bump
  readonly likes: readonly TasteSignal[]       // explicit "마음에 들었어"
  readonly dislikes: readonly TasteSignal[]    // explicit "별로였어"
  readonly preferredVarietals: readonly string[]
  readonly preferredRegions: readonly string[]
  readonly preferredStyles: readonly WineStyle[]
  readonly budgetBandUsd: { p25: number; p75: number } | null    // 가격 분포 학습
  readonly allergens: readonly Allergen[]
  readonly hardConstraints: readonly HardConstraint[]
  readonly updatedAt: number
}
export interface TasteSignal {
  readonly wineId?: string
  readonly facet: "varietal" | "region" | "style" | "producer"
  readonly value: string
  readonly weight: number                      // 1-10
  readonly observedAt: number
}
export type HardConstraint =
  | { kind: "max_abv"; pct: number }
  | { kind: "exclude_allergen"; allergen: Allergen }
  | { kind: "exclude_region"; region: string }
  | { kind: "halal" } | { kind: "kosher" }
  | { kind: "vegan" }                          // egg-white/isinglass/gelatin/milk fining 배제
```

→ **블렌드 / NV / null-tannin / unknown-price / 알레르겐 / hard constraints** 전부 타입에 박힘. typed-tool-failure(ADR-0069)와 결합해 fail 경로도 닫힘.

## 2. 카탈로그 + RAG 파이프라인

### 2.1 데이터 소스 결정 매트릭스

| 소스 | 장점 | 단점 | 결정 |
|---|---|---|---|
| 자체 큐레이션(고정 N=2k~20k) | 정확·환각 0·license 안전 | 신상 vintage 누락 | **L1: primary** |
| Vivino/Wine-Searcher API | 풀 커버리지·가격 | TOS·요금·rate limit | **L2: optional fallback** (host 결정) |
| GPT-4/Claude 사전 지식 | 즉시·코스트0 | 환각·vintage drift | **금지** — 모든 사실은 catalog row backed |
| 위키 / 잡지 스크랩 | 깊은 컨텍스트 | 라이센스·신선도 | L3: embed로만 사용(citation은 metadata) |

➡️ **자체 큐레이션 catalog가 source-of-truth**. 외부 API는 surface가 선택 wire. 모델은 *catalog 외 사실 단정 금지*.

### 2.2 인덱스 (3-track)

```
src/wine/catalog/
├── store.ts            // 디스크(SQLite) — Wine 행 + criticScores child + 알레르겐 child
├── embed.ts            // tastingNotes + (producer, region, varietals 키워드) 임베딩
│                        //   model: text-embedding-3-small(1536d) Float32 BLOB (우리 src/memory와 동형)
├── filter-index.ts     // 정확 filter (region/varietal/style/priceBand/vintage/abv) 인덱스
└── reranker.ts         // (선택) cross-encoder reranker — 1차 hit ≤50 → top-N
```

**검색 파이프라인** (hybrid):
```
query → (1) NL→filter 추출(LLM 1-shot, src/wine/catalog/parse-query.ts)
      → (2) filter-index 1차 통과 (정확 매치 ≤ 200)
      → (3) vector ANN over remaining ≤ 200 → top 30
      → (4) TasteProfile re-rank (likes +/ dislikes -)
      → (5) (optional) cross-encoder reranker → top 5
      → 결과 + citation_ids (각 행의 source URL/page)
```

→ 우리 `src/memory/ranking.ts`의 하이브리드 가중합 패턴 그대로 미러.

### 2.3 카탈로그 갱신 정책

- **vintage roll-over**: 새 vintage 발견 시 `replaceVintage(producer, cuvee, oldYear, newYear)` — 닫힌 connect/disconnect (CAS version bump).
- **price stale**: `priceAsOf` 6개월 초과 시 추천 응답에 "가격 staleness" 워닝 자동 첨부.
- **criticScores**: append-only — 새 점수 추가, 기존 점수 수정 금지(역사 보존).
- 우리 [[may-22-solid-refactor-5fix]] 패턴 — 닫힌 mutation, 명시 ADR.

## 3. Cold-start + slot-filling 대화 패턴

### 3.1 Cold-start (TasteProfile 비어있음)

- **3-question onboarding** (선택, 사용자가 거부 가능):
  1. "주로 마시는 스타일이 있으세요? (레드/화이트/스파클링/없음)"
  2. "예산은? (편한 가격대/특별한 날 가격대)"
  3. "최근 마신 와인 중 좋았던 거 하나만 알려주세요"
- 답 1·2가 hard filter 시드. 답 3은 `search_wines({producer/cuvee})` → 매칭되면 `TasteSignal` 3개 자동 추출(varietal+region+style).
- 답 거부 → **medium budget·most popular varietal·풀 catalog 추천** 안전 기본값.

### 3.2 Slot-filling (모호한 한-문장 쿼리)

"오늘 저녁 와인 추천해줘" → 슬롯 4개 부족(요리·예산·인원·기분). 단번에 다 묻지 말고 **2 questions max** rule:
- Q1 (요리 + 예산): "오늘 어떤 요리에, 예산은 대략?"
- Q2 (스타일 hint): "가벼운 거 vs 묵직한 거 중 선호?"
- 2턴 안에 추천 첫 카드 제시. **각 추가 질문은 답변 한 줄 옆에 immediate 추천을 시드하지 않으면 사용자 인내 0**.

### 3.3 Multi-bottle / 코스 모드

"코스 5종 짜줘" → **plan-mode**(우리 plan-mode SOTA++ 설계 그대로). `create_plan` → 5개 Phase = "1코스 아뮤즈"·"2코스 전채"·... 각 phase에 Todo = 와인 1종 + 매칭근거.

## 4. 도구 카탈로그 (10개) — fc 섹션 2

| # | 도구 | 입력 | 출력 | tier | 비고 |
|---|---|---|---|---|---|
| 1 | `parse_query` | `{nl_text}` | `{filters: WineFilters, residual_text}` | `no_confirm` | NL→구조 변환 (LLM 1-shot, 슬롯이 적으면 빈 filter) |
| 2 | `search_wines` | `{filters, limit?: 5..30}` | `{wines: Wine[], totalMatching, citation_ids[]}` | `no_confirm` | hybrid pipeline §2.2 |
| 3 | `get_wine` | `{id}` | `Wine \| null` | `no_confirm` | 단건 조회 |
| 4 | `vintage_chart` | `{region, varietal?, yearRange}` | `{yearScores[], chart_url?}` | `no_confirm` | 별도 chart 소스 |
| 5 | `recommend_pairing` | `{food: FoodItem \| string, budgetUsdMax?, mood?}` | `{pairings: {wine, score, reason}[]}` | `no_confirm` | §8 matrix + scorer |
| 6 | `compare_wines` | `{ids[]}` | `{matrix: ComparisonMatrix}` | `no_confirm` | A vs B vs C 표 (style/score/price) |
| 7 | `update_taste_profile` | `{liked_ids[]?, disliked_ids[]?, allergens?, hard_constraints?, budget_band?}` | `{profile: UserTasteProfile, delta: ProfileDelta}` | **`always_confirm`** | L3 memory mutate (CAS) |
| 8 | `add_to_cellar` | `{wine_id, bottles, purchaseDate, pricePaid?, note?}` | `{cellar_entry: CellarEntry}` | **`always_confirm`** | 셀러 mutate |
| 9 | `web_search_critic_review` | `{wine_id, sources?: CriticSource[]}` | `{snippets[], cited_urls[]}` | `no_confirm` | catalog 미커버 fallback |
| 10 | `request_user_clarify` | `{prompt, choices?: string[], multiline?: boolean}` | `{decision:"answer"\|"cancelled", text?}` | **`hand_off_required`** | ADR-0086 미러 |

→ 8 read-only(`no_confirm`) + 2 mutate(`always_confirm`) + 1 blocking(`hand_off`). 우리 ADR-0047 HITL 4-tier 그대로.

### 4.1 도구 에러 모델 — typed-tool-failure(ADR-0069) 미러

`failure: { mode, reason, detail? }`:
- `mode: "no_results"` — search 0건 → 모델은 필터 완화하라는 가이드 자동
- `mode: "ambiguous"` — search ≥30건 → 슬롯 추가 질문하라는 가이드
- `mode: "rejected"` — taste-profile/cellar mutate에서 hard constraint 위반
- `mode: "timeout"` — 외부 API
- `mode: "permission_denied"` — 컴플라이언스 (§9)

## 5. 프롬프트 아키텍처 (4-section + cache + reminder_tail)

ADR-0051 sectioned-system-prompt + ADR-0004 정적 prefix cache 그대로:

```
[STATIC PREFIX — 100턴 byte-identical, cache hit 90%+]
§1 PERSONA
   "당신은 친근한 한국어 소믈리에. 격식체 사용, 와인 용어는 한글+원어 병기.
    소비자 인내 짧음: 2턴 안에 첫 추천 제시. 추천 카드는 5줄 이하."
§2 CAPABILITIES
   도구 10개 signature + 1줄 용도. body 변동 0 (캐시 안전).
§3 HARD RULES
   - 사실 주장(producer/region/vintage/score/price)은 직전 search_wines() 또는
     get_wine()의 citation_ids 중 backed인 row에서만. backed 안 되면 도구 호출로
     보강 또는 "확실하지 않다" 명시.
   - vintage 모르면 NV 또는 "최신 시판 vintage" 표현. 절대 추측 금지.
   - 가격 단정 금지. priceUsd null이면 "가격은 시판 시점 확인 권장"; priceAsOf
     6개월 초과 시 "가격은 X년 Y월 기준, 변동 가능".
   - 알레르겐(sulfites/egg-white/milk-protein 등) 추천 시 능동 공지.
   - 미성년/임산부/금주 의심 signal 발견 시 정중히 차단 + 무알콜 대안 시드.
   - TasteProfile의 hard_constraints(halal/kosher/vegan/max_abv) 추천에서 자동 필터.
§4 STYLE
   추천 1종 = "이름 / 산지 / 가격대 / 한 줄 페어링 근거". 절대 늘어짐 금지.
   3종 추천 = bullet 3개, 총 6줄 이하. 비교가 필요하면 compare_wines 호출.

[DYNAMIC reminder_tail — 매 턴 갱신, 단일 user message로 첨부]
- 오늘 날짜 (vintage drinking-window 판단)
- 사용자 시간대 (저녁 추천 등 시간 컨텍스트)
- UserTasteProfile 요약 (last_seen styles, budget_band, hard_constraints, allergens)
- 직전 3턴 short-term (compacted) — 현재 슬롯 상태
- 활성 cellar/wishlist 카운트 (있으면)
- mode 표시: chat / tasting_plan / cellar_audit / compliance
```

→ ADR-0004 정적 prefix cache 패턴이 와인처럼 **반복 검색-추천 워크로드에서 큰 절감**.

## 6. 메모리 계층 (L1-L4)

| 계층 | 매핑 | 와인 구체 | TTL |
|---|---|---|---|
| **L1 raw** | 우리 messages | 이번 세션 메시지 | 세션 |
| **L2 working** | ADR-0021 WorkingState | 이번 추천 세션의 후보 풀 + 제외 와인 + 활성 슬롯 | 세션 |
| **L3 taste profile** | codex-2-phase consolidator + memory/embed | **UserTasteProfile (§1)** — likes/dislikes/preferred/budget/hard constraints | 영구(version bump) |
| **L4 catalog** | RAG over wine DB | static domain (Wine[], CriticScore[]) | 카탈로그 정책(§2.3) |

### 6.1 L3 distill 정책 (TasteProfile 자동 갱신)

ADR-0068 2-phase 메모리 패턴 그대로 와인용 변형:
- **Phase 1 (per-turn)**: 사용자 발화에서 `TasteSignal` 후보 추출 LLM 호출
  - "이거 마음에 들어" → liked + facet 자동 추론(varietal/region/style)
  - "이거 빼고" → dislike
  - "200불 이하만" → budget_band p75 갱신
- **Phase 2 (session-end)**: 누적 signal을 머지·중복제거·가중평균 → CAS bump
- **명시 confirm 우선**: `update_taste_profile` 도구를 모델이 명시 호출(`always_confirm`)했을 때만 영구화. Phase 1·2는 **caveat**: 사용자에게 "다음에도 이런 거 추천할까요?" 물어본 후 적용.

### 6.2 hard_constraints는 explicit-only

`halal/kosher/vegan/max_abv/allergen exclusion`은 **추측 절대 금지** — 사용자가 명시 입력했을 때만 저장. PII 회피 + 종교·건강 추측 위험 방어.

## 7. Citation + grounding guard

### 7.1 답변 구조 강제

추천 1종 출력은 다음 4-필드 구조:
```
{
  "wine_id": "<catalog id>",                  // citation backed required
  "name": "<producer> – <cuvee> <vintage>",   // wine_id 행에서 derive
  "summary_line": "<한 줄 페어링 근거>",       // 자유 텍스트 (의견)
  "facts_cited": ["wine_id"]                  // 어떤 도구 결과로 backed
}
```

### 7.2 guard (`src/wine/verify/citation-check.ts`)

ADR-0013 verify-before-finish 직접 미러:
- 모델 응답에서 모든 *factual claim*(producer/region/vintage/score/price/abv) 추출
- 각 claim → 직전 N턴의 도구 결과 중 backed row id 매칭
- 매칭 실패 = `citation_missing` AgentEvent + 모델에 "이 주장은 backed 안 됨, 도구로 보강 또는 확신 표현 약화" 시드
- terminal 응답 직전에 호출 → fail 시 한 턴 더 진행

### 7.3 환각 차단 hellgate

- "내가 작년에 마신 X와인" → 사용자 발화의 X는 catalog에 있어야 reference 가능. 없으면 → `web_search_critic_review` fallback → 그래도 없으면 "그 와인은 카탈로그에 없네요. 비슷한 것 추천 드릴까요?"
- 모델이 **catalog에 없는 producer/cuvee 단정** → typed `citation_missing` 거부 + 보강 시드

## 8. Pairing matrix + scoring 알고리즘

### 8.1 매트릭스 (closed)

`src/wine/pairing/matrix.ts` — Cursor review-kind matrix 패턴 미러:
```ts
/** 음식 차원 × 와인 차원 매칭 점수(-2 ~ +2) */
const MATRIX: Readonly<Record<Flavor, Readonly<Record<WineStyle, number>>>> = Object.freeze({
  spicy: { still_white: +2, sparkling: +1, still_red: -1, ... },   // 풀세트
  fatty: { still_red: +2, sparkling: +2, ... },
  umami: { still_red: +1, fortified: +2, ... },
  // ... 12 flavor × 7 style = 84 cell — exhaustive switch 테스트로 PIN
})
```
- 음식의 dominant flavors / fat / protein / preparation → 점수 합산
- + 와인 body·acidity·tannin 보정 가중치(예: spicy+high_acid +1)
- 결과 = 0~10 정규화

### 8.2 Scoring (`src/wine/pairing/scorer.ts`)

```
score(wine, food, userProfile) =
  base_match(matrix, wine.style, food.flavors)
  + body_balance(wine.body, food.fatLevel)
  + tannin_protein(wine.tannin, food.proteinKind)
  + acidity_flavor(wine.acidity, food.dominantFlavor)
  + taste_profile_boost(wine, userProfile.likes/dislikes)   // -2 ~ +2
  - hard_constraint_violation(wine, userProfile.hard_constraints)  // -∞ 효과
```
정수 점수 + LLM-생성 reason 문장(별도). hard violation은 score 무관 즉시 제거.

### 8.3 단위 + e2e

84-cell matrix 전수 단위 테스트(빈 셀 = `never` exhaustive). e2e: 5개 한식+5개 양식 페어링 gold set과 매칭(평점 ≥7 일치).

## 9. Compliance + safety

### 9.1 HARD_DENY 패턴

| 패턴 | 조건 | 동작 |
|---|---|---|
| 미성년 의심 | "18세", "고1", "수능 끝", "성인 아닌데" 등 | 즉시 거부 + 무알콜/모크테일 redirect |
| 임산부 | "임신", "수유" 직접 언급 | 거부 + 무알콜 redirect + 의사 권유 |
| 금주 | "금주중", "AA", 의사 권유 발언 | 거부 + redirect |
| 운전 직전 | "운전할 거예요", "음주운전" | 거부 + 음주 후 운전 위험 안내 |
| 폭음 권유 | "최대로 취하게", "원샷" 등 | 거부 + 적정 음주 가이드 |
| 의약품 상호작용 | "약 복용중 와인 OK?" | 의학 자문 권고 + 의사 상의 redirect |

→ `src/wine/permission/safety-patterns.ts` — 우리 ADR-0091 git-write-protection 정적 deny 패턴 미러.

### 9.2 컴플라이언스 (지역별)

- 미국 21+, 한국 19+ 등 지역별 — 사용자 timezone/locale에서 추론
- 알코올 광고 규제 지역별 다름 → `compliance` 모드에서 마케팅 카피 자동 차단
- 알레르겐 명시는 EU 1169/2011 등 — 추천 카드에 자동 표기

## 10. Collaboration modes (4 wine-specific)

우리 4-mode(default/plan/review/audit) 미러:

| 우리 | 와인 | 의미 | 슬래시 |
|---|---|---|---|
| `default` | `chat` | 자유 검색·추천 | (기본) |
| `plan` | `tasting_plan` | 다회 시음 계획 (plan-mode SOTA++ 그대로) | `/plan` |
| `review` | `cellar_audit` | 셀러 검토·로테이션 추천(read-only HITL) | `/audit` |
| `audit` | `compliance` | 알레르겐/연령/약물 컴플라이언스 점검 | `/compliance` |

`tasting_plan` 모드에서 `create_plan`·`update_todos`·`request_user_input` 와인 변형 사용 → 우리 plan-mode 설계 그대로 적용.

## 11. AgentEvent 확장 (wine 표면)

`src/stream/types.ts`에 와인 변형 추가(누락 시 NullStream swallow):

```ts
  | { type: "wine_recommendation"; wines: readonly Wine[]; citation_ids: readonly string[] }
  | { type: "pairing_card"; food: FoodItem; pairings: PairingResult[] }
  | { type: "taste_profile_updated"; delta: ProfileDelta; version: number }
  | { type: "compliance_block"; reason: ComplianceReason; redirect?: string }
  | { type: "citation_missing"; claim: string; suggested_tool: string }
```

→ UI는 카드/표/배너 렌더, JSONL recorder는 recovery family로 fold.

## 12. 영속화

- `~/.wine-agent/profiles/{user_id}.json` — UserTasteProfile (CAS version + last_synced_at)
- `~/.wine-agent/cellar/{user_id}.json` — CellarEntry[] (append-only with delete-flag)
- `~/.wine-agent/sessions/*.jsonl` — 우리 session/store 그대로

`AgentConfig.tasteProfileStore?` + `AgentConfig.cellarStore?` — follow-up-queue snapshot 패턴 거울.

## 13. 평가 시스템 (5-tier mirror)

우리 [src/apps/eval/](src/apps/eval/) 5-tier 그대로 도메인 swap:

| Tier | 코딩 | 와인 |
|---|---|---|
| 0 audit | grep coverage | catalog 행 완정성(필수 필드 누락 0) + matrix 84-cell exhaustive |
| 1 synthetic | LLM-judge 시나리오 | **gold 페어링 30개** (한식15+양식15) → 모델 추천이 gold list 내 ≥1 매칭 |
| 2 public | SWE-bench Verified | (선택) 공개 wine recommendation benchmark가 있으면 wrap; 없으면 N/A |
| 3 trajectory | 실세션 분류·replay | 실 사용자 세션 분류(추천 성공/모호/거부) + replay |
| 4 compare | quanta vs claude-code vs cursor | quanta-wine vs ChatGPT-with-tools vs 베이스라인 LLM pairing |

gold pairing set은 별도 큐레이션(소믈리에 자문). 평가 메트릭: top-1 match%, top-3 match%, citation coverage%, latency p50/p95, hallucination 빈도.

## 14. 레이턴시 + 비용 budget

| 시나리오 | 목표 p95 | 도구 호출 | LLM 토큰 |
|---|---|---|---|
| 단일-턴 추천 ("스테이크에 60불") | ≤3s | 1× parse_query + 1× search_wines | in 1500 + out 400 |
| 페어링 카드 1종 | ≤4s | + 1× recommend_pairing | in 2000 + out 500 |
| Cold-start onboarding 3턴 | ≤8s 전체 | 0~1× search_wines/턴 | 작음 |
| tasting_plan 5종 | ≤15s | parse+search ×5 + create_plan | in 5000 + out 1500 |
| cellar_audit (50병) | ≤10s | 1× cellar 조회 + N× get_wine | 큼(streaming 필수) |

**캐시 hit율** (ADR-0004 정적 prefix): 90%+ 목표. **streaming 표시** 필수(carousel-style 와인 카드 incremental render).

## 15. 슬라이스 격리 + biome fence

```
@/wine                 →  @/memory(embed), @/storage, @/shared ✓
                      →  @/tool ✗ (도구는 ctx seam으로만)
                      →  @/agent ✗
@/wine/catalog        →  자체 store + embed
@/wine/pairing        →  pure (matrix + scorer)
@/wine/taste-profile  →  @/memory ✓, others ✗
@/wine/verify         →  @/llm(citation extract) ✓, @/wine/catalog(grounding) ✓
@/tool/wine/*         →  @/wine ✗ — ToolContext.wineCatalog/winePairing/wineTasteProfile duck-typed seam만
```

biome.json `overrides` 5개 추가. 우리 RFC §3.1 그대로 적용.

## 16. 단계별 롤아웃 (8-phase, 총 12-15일 / 병렬 4-6일)

| Phase | 범위 | Effort |
|---|---|---|
| P1 | `@/wine/types` 풀 스펙 + 헬게이트 closed-enum 전수 (Body × Sweetness × Acidity × Tannin × Style 매트릭스) | M |
| P2 | `@/wine/catalog` — store + embed + filter-index + parse-query(LLM 1-shot) + 100건 seed catalog | L |
| P3 | `@/wine/pairing` — 84-cell matrix + scorer + 30 gold 페어링 e2e | M |
| P4 | `@/tool/wine` — 도구 10개 + ToolContext seam + typed-failure 통합 | M |
| P5 | `@/wine/taste-profile` — L3 distill(Phase1+2) + CAS store + update_taste_profile 도구 | M |
| P6 | `@/wine/verify` — citation guard + compliance HARD_DENY + safety patterns | M |
| P7 | `@/apps/wine-cli` — REPL + 4-section prompt + 4 modes + AgentEvent 5 wine 변형 | M |
| P8 | 평가 5-tier (gold pairing 30 + replay + compare adapter) + smoke 8 tikitaka 시나리오 + ADR 7건 + fc YAML | L |

## 17. ADR 세트 (7건 draft)

| ADR | 제목 | 범위 |
|---|---|---|
| W-1 | wine domain slice contract | §15 슬라이스 격리 + ToolContext seam |
| W-2 | wine catalog source policy | §2 자체 큐레이션 source-of-truth, 외부 API host 책임 |
| W-3 | citation + grounding guard | §7 모든 사실 주장 backed required |
| W-4 | compliance HARD_DENY ladder | §9 미성년/임산부/금주/운전/폭음/약물 |
| W-5 | pairing matrix + scorer closed shape | §8 84-cell + scoring algorithm |
| W-6 | taste profile L3 — explicit-confirm + CAS | §6 학습 cadence + hard_constraints explicit-only |
| W-7 | wine collaboration modes | §10 chat/tasting_plan/cellar_audit/compliance |

## 18. 헬게이트 + e2e 테스트 플랜 (짜치는 거 0)

### 18.1 헬게이트 (~150 케이스)

- closed enum 전수 (Body 3 × Sweetness 6 × Acidity 4 × Tannin 5 × Style 7 = 2520 조합 중 invariant 10개 PIN)
- NV vintage 허용·null tannin·블렌드 percent sum 100±2·priceUsd null·priceAsOf 6mo-stale
- 모든 도구 typed-failure 24종(no_results/ambiguous/rejected/timeout/permission_denied × per-tool)
- compliance HARD_DENY 36 패턴(§9.1 7카테고리 × 평균 5 변형)
- citation_missing edge: 부분-backed / 동음 producer / vintage drift
- TasteProfile CAS race + version_conflict
- pairing matrix 84-cell exhaustive + body/tannin 보정 16 케이스

### 18.2 e2e (`tests/integration/wine-agent-e2e.test.ts`)

8 시나리오 — runAgent 통과:
1. **happy path 단턴**: "스테이크에 60불 레드" → search_wines → 추천 3종 + citation 검증
2. **cold-start 3-Q onboarding** → TasteProfile 3 signal 자동 추출 + 첫 추천 매칭
3. **slot-filling 2턴**: 모호 → 2-question → 첫 카드
4. **알레르겐 충돌**: profile에 sulfite 알레르기 → sulfite 와인 추천 거부 + 대안
5. **citation missing**: 모델이 catalog 외 producer 단정 → guard fail → 도구 호출 보강 후 재시도
6. **tasting_plan 5종**: plan-mode 진입 → 5 phase × 1 todo → 사용자 승인 → cellar 자동 기록
7. **compliance 차단**: 미성년 의심 발화 → HARD_DENY + 무알콜 redirect
8. **persistence**: 세션 종료 → TasteProfile snapshot → 새 세션 hydrate → 직전 좋아한 와인 기억

### 18.3 smoke fixture (tier-0 hermetic replay)

우리 [tests/smoke/](tests/smoke/) 13 시나리오 미러 — 8 와인 tikitaka(추천/페어링/audit/plan) 녹화 → tier-0 replay 결정적 게이트.

## 19. 재사용 맵 (90% 무변경 / 10% 도메인 swap)

| 우리 코드 | 와인 에이전트 |
|---|---|
| `src/agent/loop.ts` | **무변경** — React 루프 그대로 |
| `src/agent/types.ts` (AgentConfig) | tools/permission/llm/stream/memory 부분 동일. `verifyGuard` → `citationGuard`로 의미 교체(인터페이스 동일) |
| `src/llm/*` | **무변경** (dual-provider) |
| `src/stream/*` | AgentEvent union에 5 wine 변형 추가 |
| `src/memory/*` | embed/ranking 무변경. 도메인 L3 store만 swap (WorkingState → TasteProfile) |
| `src/permission/*` | tier·HITL 무변경. HARD_DENY 패턴만 wine-safety로 교체 |
| `src/observability/*` | OTel/cost dashboard 무변경 |
| `src/agent/plan-mode` + plan-exit | **그대로** — tasting_plan으로 활용 |
| `src/agent/follow-up-queue` | **그대로** — "이 와인 다음에 들어오면 알려줘" async signal |
| `src/skill/*` | 무변경 (mode 슬래시 라우터) |
| `src/apps/cli/*` | REPL 골격 동일, 프롬프트 sections와 슬래시만 와인 |
| `tests/smoke/*` | 시스템 그대로, 시나리오만 와인 |
| `src/apps/eval/*` | 5-tier 시스템 그대로, gold set만 와인 |
| `tools/feature-catalog/*` | fc 시스템 그대로, feature ids만 와인 |
| **신규** `src/wine/` | catalog + pairing + taste-profile + verify (4 sub-slices) |
| **신규** `src/tool/wine/` | 도구 10개 |
| **신규** `src/apps/wine-cli/` (선택) | REPL 진입점 분리(또는 `--profile wine` 플래그) |

→ **agent loop core / LLM / stream / memory engine / permission / observability / plan-mode / follow-up-queue / skill / fc / smoke / eval — 12개 핵심 슬라이스 무변경**. 와인 슬라이스 4 + 도구 1 + CLI 1만 신규.

## 20. SOTA++ 차별화 (3 비교)

| 차원 | 일반 챗봇 wine | LangChain/소믈리에 RAG | **우리 (계획)** |
|---|---|---|---|
| 환각 방지 | "조심해서 답하세요" prompt | 검색 결과 stuff | **citation guard + verify-before-finish 엄격 enforcement** |
| 도메인 모델 | free text | partial schema | **closed-type 풀 (NV/null-tannin/블렌드/알레르겐)** |
| 페어링 | LLM 자유 | LLM + 약간의 룰 | **84-cell matrix + scorer + LLM reason** 분리 |
| 취향 학습 | system prompt에 누적 | RAG에 user memory 추가 | **L3 CAS-versioned TasteProfile + explicit-confirm + Phase1/2 distill** |
| 컴플라이언스 | 보통 무시 | 텍스트 워닝만 | **HARD_DENY ladder + 지역별 컴플 + 알레르겐 능동 공지** |
| 모드 | 단일 | 단일 | **4-mode (chat/tasting_plan/cellar_audit/compliance) + plan-mode SOTA++ 통합** |
| 평가 | 사용자 만족도만 | 단발성 | **5-tier eval + gold pairing 30 + replay + A/B compare** |
| 격리 | 모놀리식 | 모듈 분리만 | **biome fence + ToolContext seam + 슬라이스 invariant 테스트** |
| 헬게이트 | "그냥 잘 됐으면" | unit test 일부 | **~150 케이스 + 8 e2e + smoke 8 tikitaka — 짜치는 거 0** |

---

## 마무리

**시작 신호**: `@/wine/types.ts` 작성부터. P1 끝나면 P2(catalog)와 P3(pairing matrix)를 **병렬 worktree 2-에이전트**로 동시 진행. P4(도구)는 P1·P2·P3 의존이라 직렬. P5-P8은 다시 2-3 병렬.

병렬화하면 **4-6일** 안에 와인 에이전트 0→1 가능, 우리 agent loop / 12 핵심 슬라이스 / fc·smoke·eval 인프라 **무변경**으로.
