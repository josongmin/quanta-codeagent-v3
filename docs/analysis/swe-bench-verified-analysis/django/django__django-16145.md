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
---

# django__django-16145

## 문제 요약
`python manage.py runserver 0:8000`은 `0.0.0.0:8000`과 동일하게 바인딩되지만, 시작 메시지는 `Starting development server at http://0:8000/`로 출력된다. 이 `http://0:8000/` 링크는 Chrome 등에서 열리지 않아 복붙/클릭이 불가능하다. 사용자는 docs와 일관되게 주소 `0`을 `0.0.0.0`으로 다시 써서 출력하길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case) — 주소 `"0"` 특수 케이스 미처리
- 서브시스템: django management command (runserver) / TUI 출력
- 증상 타입: 잘못된 출력 (silent-wrong, 실제 바인딩은 정상이지만 표시 주소가 사용 불가)
- 로컬라이제이션 신호: "Starting development server at" 문자열과 `runserver` 명령이 직접 지목됨 → `runserver.py`의 시작 메시지 포맷 지점 한 군데로 수렴

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/runserver.py` : `Command.inner_run`
- 근본 원인: 시작 메시지 포맷에서 `"addr"` 값을 `"[%s]" % self.addr if self._raw_ipv6 else self.addr`로만 계산해, IPv6 래핑만 처리하고 `self.addr == "0"`인 경우를 그대로 출력했다. 바인딩 로직과 표시 로직이 불일치.
- 수정 요지: `inner_run` 앞부분에서 표시용 `addr` 변수를 미리 계산하도록 분기 추가 — `self._raw_ipv6`면 `f"[{self.addr}]"`, `self.addr == "0"`이면 `"0.0.0.0"`, 그 외엔 `self.addr`. 이후 메시지 dict의 `"addr"` 값을 인라인 삼항식 대신 이 `addr` 변수로 교체했다. 출력만 바뀌고 실제 바인딩 동작은 불변.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_zero_ip_addr (admin_scripts.tests.ManageRunserver)`
- 테스트가 어떻게 픽스를 증명하는지: `django.core.management.commands.runserver.run`과 `BaseCommand.check_migrations`를 mock해 실제 서버 기동/마이그레이션 검사를 차단한 뒤, `call_command("runserver", addrport="0:8000", use_reloader=False, skip_checks=True, stdout=self.output)`를 호출한다. 그리고 캡처한 출력에 `"Starting development server at http://0.0.0.0:8000/"`가 포함되는지 `assertIn`으로 확인한다. 픽스 전에는 `http://0:8000/`가 출력되어 실패, 픽스 후 `0.0.0.0`으로 재작성되어 통과한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement의 "Starting development server at" 리터럴을 grep → `runserver.py`의 메시지 포맷 dict에 바로 도달. 그 dict의 `"addr"` 키 계산식이 유일한 수정 대상.
- 함정/난이도 메모: (1) 실제 바인딩 코드(`run(...)` / `self.addr` 파싱)는 정상이므로 거기를 건드리면 안 됨 — 표시 전용 결함이다. (2) 기존 삼항식이 `_raw_ipv6`만 다루므로, 단순히 `0` 케이스를 끼워넣을 때 IPv6 분기를 깨지 않도록 순서/우선순위 유지가 필요. (3) 단일 파일·단일 함수 수정으로 끝나는 저난이도 문제.
- 우리 에이전트 관점: 막힐 포인트는 "출력만 고치면 되는데 바인딩 로직까지 손대는 과잉수정". `0.0.0.0` 바인딩이 이미 동작한다는 점을 problem_statement 힌트에서 읽어내야 표시 레이어로 범위를 좁힐 수 있다. 또한 `skip_checks`/mock 없이 테스트하면 부수효과로 검증이 흐려지므로 test_patch의 mock 패턴을 따르는 것이 핵심.
