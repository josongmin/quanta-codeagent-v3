---
instance_id: astropy__astropy-14182
repo: astropy/astropy
base_commit: a5917978be39d13cd90b517e1de4e7a539ffaa48
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2022-12-16T11:13:37Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [astropy/io/ascii/rst.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`ascii.rst` writer로 테이블을 출력할 때 `header_rows=["name", "unit"]` 같은 추가 헤더 행을 지정하면 `TypeError: RST.__init__() got an unexpected keyword argument 'header_rows'`로 죽는다. 자매 포맷인 `ascii.fixed_width`는 이미 `header_rows`를 지원한다. 즉 RST 포맷에서도 unit/dtype 등 다중 헤더 행을 출력(및 round-trip)할 수 있게 해달라는 기능 요청이다.

## 유형 (정형화)

- **L1 (Traceable)**: 스택트레이스가 `RST.__init__()`을 정확히 지목하고 `_format_name="rst"`로 파일이 `astropy/io/ascii/rst.py` 하나로 수렴한다. grep 한 방은 아니나 단일파일·단일클래스로 거의 즉시 좁혀짐.
- **S2 (+S6, Constraint-Reasoning)**: 고칠 위치는 자명하나, 단순히 `header_rows` kwarg를 뚫어주는 것으로 끝나지 않는다. 부모 `FixedWidth.__init__`가 `header_rows` 길이에 따라 레이아웃을 바꾸므로, 하드코딩된 `start_line = 3`과 `write()`의 `lines[1]` 경계선 인덱스를 **헤더 행 개수에 대한 식**(`len(self.header.header_rows)`, `2 + len(...)`)으로 재유도해야 한다. 또 reader 경로용 `read()` 오버라이드를 새로 추가(소규모 구조 보강 → S6 보조).
- **K-Domain**: astropy ascii I/O 내부 계약(`FixedWidth`의 `header_rows` 전파, `header.start_line`/`data.start_line` 의미, RST의 2-line splitter와 `=` 경계줄 구조)을 알아야 올바른 식이 나온다. 일반 파이썬 추론만으로는 `start_line` 산식이 안 떠오름.

primary type = **T-ConstraintReason**: 위치는 명확하지만 픽스가 "kwarg 추가"가 아니라 헤더 행 수에 따른 인덱스 산식 합성이 본질이기 때문.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개(`rst.py`), 골드 net 변경 ~15줄 — scope만 보면 작다.
- localize 직접성 높음(L1, has-repro 스택트레이스) → 하방 압력.
- 그러나 단순 가드/기본값이 아니라 부모 클래스 동작에 대한 **constraint 추론**이 필요(S2)하고, write/read 양 경로의 산식을 동시에 맞춰야 함(상방 압력).
- P2P 9개가 모두 기존 read/write 동작(`test_read_normal*`, `test_write_normal`) → header_rows 기본동작을 1픽셀도 안 깨야 하는 **regression-trap**. 주의: `start_line=3` 제거 후 부모 `FixedWidth.__init__`는 read의 `data.start_line`을 옛 3이 아니라 `len(["name"])=1`로 세팅한다 — 즉 부모 값은 read엔 틀린 값. read 동치(옛 3)는 골드가 신설한 `read()` 오버라이드(`self.data.start_line = 2 + len(...)` → 2+1=3)가 매 호출 복원해 보장한다. write 쪽은 `data.start_line`을 안 쓰고 `write()`의 `idx=len(header_rows)=1`이 옛 `lines[1]`과 일치해 보존된다.

공식 라벨 "15min–1h"와 일치한다. 기능 추가지만 산식 추론 + 양방향(read/write) 일관성 때문에 T2~T3로 내리기엔 인지부하가 있어 T4로 둠.

## 골드패치 분석

건드린 파일: `astropy/io/ascii/rst.py` — `SimpleRSTData`, `RST` 클래스.

근본 원인:
1. `RST.__init__(self)`가 `header_rows`를 받지도, 부모(`FixedWidth.__init__`)로 전달하지도 않음 → kwarg 거부.
2. `SimpleRSTData.start_line = 3`이 "경계줄+name헤더+경계줄=3줄" 가정으로 **하드코딩** → 헤더 행이 늘면 데이터 시작 위치가 틀어짐.
3. `write()`가 `lines = [lines[1]] + lines + [lines[1]]`로 경계선을 **인덱스 1 고정**으로 복제 → 헤더 행이 2개 이상이면 잘못된 줄을 경계선으로 씀.

수정 요지:
- `__init__(self, header_rows=None)`로 받아 `super().__init__(..., header_rows=header_rows)` 전달. 부모가 `self.header.header_rows`/`self.data.header_rows` 세팅 및 `data.start_line=len(header_rows)`를 책임짐.
- `class SimpleRSTData`에서 `start_line = 3` 제거(부모가 동적으로 산정하도록 위임).
- `write()`에서 `idx = len(self.header.header_rows)`로 경계선 인덱스를 일반화: `[lines[idx]] + lines + [lines[idx]]`.
- `read()` 오버라이드 신설: `self.data.start_line = 2 + len(self.header.header_rows)` (위 경계줄 1 + 헤더 행 N + 아래 경계줄 1 = 2+N 이후가 데이터).

## 검증 (test_patch)

FAIL_TO_PASS = `test_rst_with_header_rows` 1개: `header_rows=["name","unit","dtype"]`로 8줄 RST를 **read** 해서 `wave.unit==u.nm`, `response.dtype==np.float32`, `ints.dtype==np.int8` 등 확인 → reader가 3개 헤더 행을 올바른 행에서 파싱함을 증명(`read()`의 `2+len` 산식 검증). 이어서 같은 옵션으로 **write** 후 `splitlines()`가 입력 lines와 정확히 일치 → writer 경계선 인덱스(`idx=len(header_rows)`) 및 kwarg 전파 검증. read+write round-trip이라 양방향 산식을 동시에 못 박음.

overfit 관점: 테스트가 단 1개라 얇아 보이나 round-trip + 3-row(name/unit/dtype) 조합이라 `lines[1]`/`start_line=3` 같은 하드코딩 특수해로는 통과 불가 → CEGIS형 overfit 위험 낮음. regression 관점: P2P 9개가 기본 `header_rows=["name"]` 경로(read/write)를 커버하므로 `start_line=3` 제거가 기존 동작을 깼다면 `test_read_normal`/`test_write_normal`이 즉시 적발. 동치 보존의 인과는 경로별로 다르다: read의 `data.start_line`은 부모 `__init__`가 `len(["name"])=1`로 세팅하지만(옛 3과 불일치) read 진입 시 골드 `read()` 오버라이드(`2+len`→3)가 즉시 덮어써 옛 3을 복원한다 — 부모 값이 아니라 `read()`가 보존한다. write는 `data.start_line`을 안 쓰며 `write()`의 `idx=len(header_rows)=1`이 옛 `lines[1]`과 일치해 보존된다.

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스 마지막 프레임 `RST.__init__() got an unexpected keyword argument 'header_rows'` → `astropy/io/ascii/rst.py`의 `RST.__init__` 직행. 자매 포맷 `FixedWidth`가 `header_rows`를 어떻게 처리하는지 부모 `fixedwidth.py`를 읽어 계약 파악(L1).
2. **픽스와 일반화**: 핵심 통찰은 "부모 `FixedWidth.__init__`가 이미 `header_rows`를 받아 `header.header_rows`/`data.header_rows`/`data.start_line=len(header_rows)`를 세팅한다"는 것. 따라서 (a) kwarg를 부모로 forward, (b) 부모와 충돌하는 하드코딩 `SimpleRSTData.start_line=3` 제거, (c) write의 경계선 인덱스를 상수 1이 아니라 `len(self.header.header_rows)`로, read의 데이터 시작을 `2+len(...)`로 **헤더 수의 함수**로 재유도. 상수를 식으로 바꾸는 것이 N=1,2,3 모두에 맞는 올바른 일반화.
3. **regression 안전**: 기본 호출(`header_rows=None`→부모가 `["name"]`)에서 `len=1`이라 write 인덱스가 옛 `1`과 동치(이건 `write()`의 `idx=len(header_rows)`가 보장). read `start_line`은 부모 `__init__`가 `1`로 세팅해 옛 `3`과 안 맞지만, `read()` 오버라이드 `2+len`→3이 매 호출 복원해 동치를 지킨다(부모 값이 아니라 `read()`가 책임). P2P `test_read_normal`·`test_write_normal`이 이 동치를 지킨다 — 식으로 바꿔도 N=1에서 read=3·write=1이 그대로 나오는지 손으로 확인.
4. **함정 회피**: (a) `__init__`만 고치고 `start_line=3`·`lines[1]`을 남기면 FAIL_TO_PASS의 write 비교에서 경계선이 엉뚱한 줄에 찍혀 실패 — 세 군데를 **함께** 고쳐야 함(부분 픽스 트랩). (b) read 경로를 잊기 쉬움: `RST`엔 원래 `read()` 오버라이드가 없어 부모 흐름을 타는데, RST는 위/아래 `=` 경계줄 2개가 추가돼 `data.start_line`이 일반 FixedWidth와 다르므로 `read()`에서 `2+len`으로 보정해야 round-trip read가 맞음. (c) `start_line`을 `read()` 안에서 동적 세팅(매 호출)하지 않고 클래스 상수로 두면 `header_rows` 가변 호출 간 상태 오염 위험 → 골드처럼 `read()` 진입 시 설정하는 것이 안전.
