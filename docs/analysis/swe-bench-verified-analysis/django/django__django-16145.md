---
instance_id: django__django-16145
repo: django/django
base_commit: 93d4c9ea1de24eb391cb2b3561b6703fd46374df
version: 4.2
difficulty: <15 min fix
created_at: 2022-10-03T05:09:14Z
fail_to_pass: 1
pass_to_pass: 174
gold_files: [django/core/management/commands/runserver.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

# django__django-16145

## 문제 요약
`python manage.py runserver 0:8000`은 `0.0.0.0:8000`과 동일하게 바인딩되지만, 시작 메시지는 `Starting development server at http://0:8000/`로 출력된다. 이 `http://0:8000/` 링크는 Chrome 등에서 열리지 않아(Firefox만 동작) 클릭/복붙이 불가능하다. docs는 `0`이 `0.0.0.0`의 단축이라고 명시하므로, runserver 출력에서 주소 `0`을 `0.0.0.0`으로 다시 써서 표시해야 일관된다. 실제 바인딩은 정상 — 순수 표시(TUI) 결함이다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `runserver` 명령과 `"Starting development server at"` 리터럴을 직접 지목한다. 이 문자열을 grep하면 `runserver.py`의 메시지 포맷 dict 한 곳으로 즉시 수렴 — grep 한 방. 탐색 노력 거의 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 사실상 픽스를 명세한다 ("rewrite an address of 0 to 0.0.0.0 in runserver's output"). 결함 클래스는 정형 "특수값 미처리(missing special-case)"로, 기존 삼항식에 `addr == "0"` 분기를 추가하는 기계적 매핑이다. 불변식 합성(S2)이나 후보 반복 탐색(S3/S4)이 필요 없다 — 기대 출력 문자열이 이슈에 박혀 있다.
- **K (Knowledge) = K-Gen (General)**: 일반 파이썬 추론으로 충분. `self.addr`, `self._raw_ipv6` 같은 인스턴스 속성 의미만 읽으면 되고, django ORM/query-compiler/migrations 같은 깊은 프레임워크 내부 지식은 불필요. management command 표면이라 도메인 의존도가 낮다.
- **Primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 특수케이스 추가다. T-LocTrivial(픽스가 거의 자명한 1줄)보다는, 인라인 삼항식을 hoist한 `addr` 변수로 분기를 정돈하는 소폭 구조 정리가 끼어 있어 "정형 결함클래스에 템플릿 매칭(T-DirectMap)"이 정확하다.
- **왜 이 strategy인가 (APR 관점)**: 픽스 공간이 단일점이다. 이슈 본문이 입력(`0:8000`)→기대출력(`http://0.0.0.0:8000/`)을 1:1로 줘서, 탐색 없는 결정론적 매핑(PAR/TBar식 fix-pattern)으로 합성된다. CEGIS/Generate-&-Validate가 필요한 "테스트가 픽스를 과소명세하는" 상황이 아님 — 기대 동작이 완전 명세돼 overfit 합성 위험이 구조적으로 낮다.

## 난이도 티어
**Tier = T2 (쉬움)**. 공식 라벨 `<15 min fix`(prior로 T1~T2 구간)와 일치하나 T1이 아니라 T2로 둔다.

이 티어로 미는 구조적 피처:
- **파일/줄수**: 1파일·단일 함수(`inner_run`)·실효 +7/-1줄. ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 구간에 근접하는 소규모.
- **localize 직접성**: L0 — 문자열 grep으로 즉시 도달. 거의 탐색 비용 없음(T1 신호).
- **has-repro**: 이슈에 정확한 재현 커맨드(`runserver 0:8000`)와 관찰된 잘못된 출력·기대 출력이 모두 있음 — 가장 강한 easiness 신호.
- **T1이 아닌 이유 (regression-trap이 위로 미는 힘)**: P2P가 174개로 매우 넓다. 특히 `test_runner_addrport_ipv6`, `test_runner_custom_defaults_ipv6`, `test_runner_hostname_ipv6` 등 IPv6 표시 경로가 P2P에 포함돼, `0` 분기를 끼워넣을 때 기존 `self._raw_ipv6` 래핑(`[...]`) 동작을 절대 깨면 안 된다. 픽스가 자명하지만 분기 우선순위(ipv6 먼저, 그 다음 `0`)를 틀리면 광범위 P2P가 깨진다 — `regression-trap` 플래그가 T1→T2로 올린다.
- **도메인/추론**: K-Gen·S1이라 추론 부담은 거의 없어 T3 이상으로는 올라가지 않는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/core/management/commands/runserver.py` : `Command.inner_run`
- **근본 원인**: 시작 메시지 포맷 dict에서 `"addr"` 값을 `"[%s]" % self.addr if self._raw_ipv6 else self.addr`로만 계산했다. 즉 IPv6 래핑만 표시 레이어에서 처리하고, `self.addr == "0"`(0.0.0.0의 단축 입력) 케이스는 파싱·바인딩 단계에서는 `0.0.0.0`으로 풀리지만 **표시 문자열에서는 그대로 `0`을 출력**했다. 바인딩 로직과 표시 로직의 불일치.
- **수정 요지**: `inner_run` 앞부분(checks 수행 전)에서 표시용 `addr` 지역변수를 미리 계산하는 if/elif/else 블록을 추가한다.
  - `self._raw_ipv6` → `addr = f"[{self.addr}]"`
  - `elif self.addr == "0"` → `addr = "0.0.0.0"`
  - `else` → `addr = self.addr`
  그리고 메시지 dict의 `"addr"` 키 값을 인라인 삼항식에서 이 `addr` 변수 참조로 교체했다. 분기 순서가 ipv6를 먼저 두므로 기존 IPv6 동작은 보존되고, `0` 케이스만 새로 재작성된다. 출력만 바뀌고 실제 바인딩(`run(...)`, `self.addr` 파싱)은 일절 불변.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_zero_ip_addr (admin_scripts.tests.ManageRunserver)`
- **동작**: 신규 테스트는 `django.core.management.commands.runserver.run`과 `BaseCommand.check_migrations`를 `mock.patch`로 가로채 실제 서버 기동·마이그레이션 검사를 차단한다. 그 뒤 `call_command("runserver", addrport="0:8000", use_reloader=False, skip_checks=True, stdout=self.output)`를 호출하고, 캡처된 stdout에 `"Starting development server at http://0.0.0.0:8000/"`가 포함되는지 `assertIn`으로 검증한다.
- **픽스 증명**: 픽스 전에는 표시 삼항식이 `self.addr`(="0")를 그대로 내보내 `http://0:8000/`가 출력 → `assertIn` 실패. 픽스 후 `elif self.addr == "0"` 분기가 `0.0.0.0`으로 재작성 → 기대 문자열이 출력돼 통과.
- **overfit 관점**: 기대 출력이 이슈에 완전 명세돼 있어 S1 매핑이 곧 정답이다. 다만 테스트가 `0:8000`이라는 단일 입력만 검증 → 이론적으로 `if self.addr == "0": addr = "0.0.0.0"`만 박는 "special-case 하드코딩"으로도 F2P 통과 가능(약한 CEGIS 신호). 하지만 골드 픽스도 사실상 그 special-case 매핑이며, `0`→`0.0.0.0`은 docs가 정의한 정확한 의미적 등가라 이 하드코딩이 **올바른 일반화**다(임의 특수값이 아니라 단축표기의 canonical 전개). 따라서 overfit-risk 플래그는 부여하지 않는다.
- **regression 관점**: P2P 174개. IPv6 표시 경로(`test_runner_addrport_ipv6`, `test_runner_custom_defaults_ipv6`, `test_runner_hostname_ipv6`)와 일반 hostname/addrport 경로(`test_runner_hostname`, `test_runserver_addrport`)가 모두 같은 메시지 dict를 거치므로, 분기 추가가 이들을 깨지 않아야 한다. 골드 픽스는 ipv6 분기를 첫 번째로 유지하고 `else`로 기존 `self.addr` 그대로 경로를 보존해 회귀 0.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 관찰 출력 리터럴 `"Starting development server at"`를 코드베이스에서 grep → `django/core/management/commands/runserver.py`의 `inner_run` 안 메시지 포맷 dict에 직접 착지. 그 dict의 `"addr"` 키 계산식(`"[%s]" % self.addr if self._raw_ipv6 else self.addr`)이 유일한 수정 후보임을 1패스로 확정. 추가로 `addrport`/`self.addr` 파싱부를 읽어 `0`이 바인딩 단계에서 이미 `0.0.0.0`으로 처리됨을 확인 → 결함이 표시 레이어에 국한됨을 입증.
2. **픽스와 올바른 일반화인 이유**: 표시용 `addr`을 hoist해 `_raw_ipv6` → `addr=="0"` → else 순서로 분기. `0`→`0.0.0.0` 매핑은 임의 special-case가 아니라 django docs가 정의한 단축표기의 canonical 전개이므로, 바인딩 의미와 표시 의미를 일치시키는 정당한 일반화다. 출력만 바꾸고 바인딩은 불변이라 부작용 없음.
3. **regression 안전**: IPv6 분기를 첫 번째로 유지해 `test_runner_*_ipv6` 류 P2P의 `[...]` 래핑을 보존하고, `else`로 일반 hostname/IP 경로(`self.addr` 그대로)를 보존해 `test_runner_hostname`/`test_runserver_addrport` 등 174 P2P를 모두 안전하게 통과. 분기 우선순위가 핵심 — ipv6보다 `0` 체크를 앞에 두면 안 됨.
4. **함정 회피**: (a) **과잉수정** — 오라클 없는 에이전트가 "주소가 0이면 동작 안 한다"고 오판해 `self.addr` 파싱/`run(...)` 바인딩 로직까지 손대는 게 가장 흔한 실패. problem_statement 힌트("0.0.0.0 is actually binded on 0")를 읽어 범위를 표시 레이어로 좁혀야 함. (b) **분기 순서 실수** — `0` 케이스를 ipv6 앞/뒤 잘못 끼우면 IPv6 P2P가 깨짐. (c) **테스트 setup 누락** — `run`/`check_migrations` mock과 `skip_checks=True` 없이 검증하면 실제 서버 기동·마이그레이션 부수효과로 검증이 흐려짐. test_patch의 mock 패턴을 그대로 따라야 결정론적으로 통과.
