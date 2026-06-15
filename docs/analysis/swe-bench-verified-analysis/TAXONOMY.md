# SWE-bench 문제 정형화 루브릭 (분석 SSOT)

각 문제를 **3개 직교 축 + 플래그**로 분류하고, 거기서 **primary type 1개**와 **6-tier 난이도**를 도출한다.
APR(자동 프로그램 수리) 문헌과 SWE-bench 난이도 실증연구에 근거 — 임의 휴리스틱 금지.

> 핵심 원칙: 난이도는 **구조적·인과적 피처**(수정 범위, localize 직접성, 재현성, 도메인 지식, regression trap)로 매긴다.
> "에이전트 solve-rate"로 매기지 않는다 — Verified 12개 레포는 학습데이터 memorization으로 solve-rate가 부풀려져 있음(SWE-Bench Illusion, arxiv 2506.12286).

---

## 축 1 — Localization (어디를 고쳐야 하나)

| 코드 | 이름 | 정의 |
|---|---|---|
| **L0** | Pinpointed | 이슈가 파일/함수/클래스/심볼을 직접 지목 ("URLValidator regex"). grep 한 방. |
| **L1** | Traceable | 키워드/스택트레이스로 좁은 단일파일 후보로 수렴. 약간의 탐색. |
| **L2** | Diffuse | 직접 포인터 없음. cross-module 데이터플로우 추적 필요, 후보 다수. |
| **L3** | Multi-site | 수정이 ≥2 파일/함수에 걸쳐 **함께** 바뀌어야 함(조율 필요). |

근거: file-level localization이 repair 결과를 지배(arxiv 2604.05481, +15~17x). 실패의 ~51%가 localization 에러(Agentless류, arxiv 2509.13941). gold patch가 ≥3파일이면 solve <10%, ≥7파일이면 0%(SWE-bench ICLR 2024).

## 축 2 — Repair Strategy (어떻게 픽스를 도출하나)

| 코드 | 이름 | 정의 / 신호 |
|---|---|---|
| **S1** | Direct-Map (template) | 이슈가 사실상 픽스를 명세. 기계적: 체크 추가/기본값·상수 변경. 정형 결함클래스(None가드/off-by-one/경계/타입강제)에 템플릿 매칭. |
| **S2** | Constraint-Reasoning (semantic) | 고칠 지점은 알지만, **올바른 식·조건을 추론으로 합성**해야 함. 불변식·엣지케이스·타입을 따져 "생각으로" 푸는 것(많이 시도해보는 게 아니라). SemFix/Angelix 계열. |
| **S3** | Generate-&-Validate | 그럴듯한 후보 패치가 다수. 테스트 피드백으로 선택·반복. 기존 코드 재배열로 풀리는 경우. overfit 위험 상존. |
| **S4** | Counterexample-Guided (CEGIS) | 주어진 실패테스트가 픽스를 **과소명세**(special-case로도 통과). 그 테스트 너머로 일반화해야 하고, 구별용 추가 입력을 만들어야 함. **overfit 고위험**. |
| **S5** | Spec-Inference | 의도된 동작이 코드만으론 결정 안 됨. 이슈 본문/docstring/관례/API계약에서 **스펙을 먼저 재구성**해야 픽스 가능. |
| **S6** | Design-Refactor | 한 줄이 아니라 작은 **구조 변경**(collect-then-process, 파라미터 도입, lifecycle 재배치)이 필요. |

(축2는 배타적 아님. dominant 1개 + 보조 표기. 예: S5+S2, S6+K-Domain.)

근거: G&V=GenProg/Astor, CEGIS=arxiv 2407.5397·aaai25-LLM-CEGIS, semantic=SemFix(ICSE13)/Angelix, template=PAR/TBar(1903.08409), spec-inference=SpecRover(2408.02232). overfit 근본원인=weak test suite(TOSEM 3702972).

## 축 3 — Knowledge 의존도 (모델빨)

| 코드 | 이름 | 정의 |
|---|---|---|
| **K-Gen** | General | 일반 파이썬 추론으로 충분. |
| **K-Domain** | Domain-bound | 프레임워크 내부 지식 필요(django ORM/query-compiler/migrations/forms·sphinx autodoc·sympy assumptions 등). "모델빨/지식빨". |
| **K-API** | API-contract | 하위호환·공개 API 계약을 정확히 맞춰야 함(시그니처/리턴형/deprecation). |

근거: 실패의 ~25%가 knowledge deficiency(2509.13941). django 난이도는 깊은 call-chain + ORM 도메인지식에서 옴(Epoch AI).

## 플래그 (해당 시 표기)

- `overfit-risk` — FAIL_TO_PASS 얇음 / special-case로 통과 가능 / 미검증 입력공간 큼.
- `regression-trap` — PASS_TO_PASS 광범위(많은 인접 동작을 안 깨야 함).
- `underspecified` — 이슈 본문이 모호(Verified 38.3% 기저율).
- `has-repro` — 재현코드/네이티브 스택트레이스 존재(가장 강한 easiness 신호; 해결률 ~87%).
- `cross-file-dep` — 픽스가 암묵적/의미적 cross-file 의존을 동반.

---

## Primary Type (도출 라벨, controlled vocabulary — 정확히 1개)

축 조합에서 dominant 한 개를 고른다:

1. **T-LocTrivial** — L0/L1 + S1. 찾으면 끝, 픽스 자명. (대개 존나쉬움)
2. **T-DirectMap** — 위치 명확 + S1 기계적 픽스(가드/기본값/상수/타입강제).
3. **T-ConstraintReason** — 위치 명확하나 S2로 올바른 식·조건을 추론 합성.
4. **T-SpecInference** — S5. 이슈/docs/관례에서 의도 재구성이 본질.
5. **T-GenValidate** — S3/S4. 테스트 반복으로 수렴, overfit 위험이 핵심 난점.
6. **T-DomainBound** — K-Domain이 dominant. 프레임워크 내부지식이 병목.
7. **T-DesignRefactor** — S6. 조율된 구조 변경.
8. **T-DiffuseLoc** — L2/L3. 진짜 어려움이 "어디인지 찾기"에 있음.

---

## 6-Tier 난이도 (type 기반, 구조적 피처로 도출)

공식 Verified 시간라벨(<15분/15분-1시간/1-4시간/>4시간)을 **prior로만** 쓰고, 위 축으로 재조정한다.
(공식 라벨은 "개발자 구현시간"이라 에이전트 난이도와 다를 수 있음 — 특히 localize 어려움/overfit 위험은 시간라벨에 안 잡힘.)

| 티어 | 라벨 | 전형 프로파일 |
|---|---|---|
| **T1** | 존나쉬움 | L0 + S1, 1파일 ≲10줄, has-repro, K-Gen. 이슈가 픽스를 거의 적어줌. |
| **T2** | 쉬움 | L0/L1 + S1/S2, 1파일 소규모, 가벼운 엣지추론. regression-trap 약함. |
| **T3** | 중간 | L1 + S2/S5, 단일파일이나 실질 추론 OR 약한 localize 노력. underspecified 가능. |
| **T4** | 약간 어려움 | L1/L2 + S2/S3/S6 또는 K-Domain. constraint추론·소규모 refactor·도메인지식 중 하나. 또는 넓은 P2P trap. |
| **T5** | 어려움 | L2/L3 + S4/S6, 멀티헌크/멀티파일, overfit·regression 고위험, 또는 깊은 도메인. |
| **T6** | 매우 어려움 | L3 조율 멀티파일 + S6 design + K-Domain. 大규모(>100줄/다수 헌크/>4시간). 거의 全에이전트 실패 구간. |

구조적 컷(근거): 1파일·<5줄 ≈ 48% solve; ≥3파일 또는 >100줄 → <10%; ≥7파일 → 0%(ICLR 2024 / 2506.08311). 난이도는 patch scope × repo/localization 2축(ICLR 2024).

---

## 각 문제 md 출력 포맷

frontmatter에 머신리더블 필드 추가:
```yaml
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
```

본문 섹션:
- **문제 요약**
- **유형 (정형화)** — 3축 점수 + primary type + 한줄 근거(왜 이 strategy인지)
- **난이도 티어** — 티어 + 근거(어떤 구조적 피처가 이 티어로 미는지; 공식 라벨과 다르면 왜)
- **골드패치 분석** — 건드린 파일·함수 / 근본원인 / 수정요지
- **검증 (test_patch)** — FAIL_TO_PASS 동작 / 픽스 증명 / overfit·regression 관점
- **모범답안 (오라클 기반)** — 오라클(골드+테스트)을 다 본 입장에서 *이상적 풀이 궤적*:
  1. localize 경로(이슈의 어떤 신호 → 어떤 파일·함수)
  2. 픽스(무엇을 왜 그렇게; 이게 overfit 아닌 올바른 일반화인 이유)
  3. regression 안전(어떤 P2P를 안 깨야 하고 왜)
  4. 함정 회피(오라클 없는 에이전트가 어디서 틀릴지 + 그걸 피하는 법)

---

## 근거 소스 (요약)
- SWE-bench ICLR 2024 (2310.06770) — 2축 난이도, 파일수·줄수 컷
- SWE-bench Verified / OpenAI — 4-tier 시간라벨, 93명 어노테이터 3중
- Epoch AI — Verified 스킬분석(78% 함수만, avg 1.87함수, 87% bugfix)
- Agentless (2407.01489) — localize→generate→validate 파이프라인
- 실패 실증연구 (2509.13941) — 3단계 9범주 실패 taxonomy, 65% 추론결함/25% 지식결함
- FL-context (2604.05481) — file-level localize +15~17x
- ORACLE-SWE (2604.07789) — repro≫edit-location≫regression 신호가치
- overfit: TOSEM 3702972 / 2503.15223 (plausible≠correct ~11%)
- SWE-Bench Illusion (2506.12286) — memorization으로 solve-rate 신뢰불가 → 구조피처로 tier
- APR strategy: GenProg, Astor, SemFix(ICSE13), Angelix, PAR/TBar(1903.08409), CEGIS(aaai25), SpecRover(2408.02232)
