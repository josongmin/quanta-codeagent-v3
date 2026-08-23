# Aug-22 흡수 — 잔여 해결 계획 (audit follow-up + fc 등록)

기준 HEAD: `191483579` (campaign 36 + audit-fix 6 landed; 동시세션 promax 커밋 위에). 이 계획은 7시선 적대감사가 남긴 defer 항목 + feature-catalog 누락을 hellgate로 마감한다. 각 항목: (기능)(왜)(ROI)(선행)(접근)(검증).

## FINAL(3시선 리뷰 후) — 실행/DROP/DEFER 결정
- **실행(hellgate)**: R0(cwd shapeTag 마스킹 **선행 필수**+regen; 모델은 이미 committed factory.ts:40이라 landed 반영·objective 3 combo=내 H1 fix) · R1(rev-compare 아닌 **O_EXCL `acquireSessionLock` 일반화**) · R4(knob 2개+completeness ratchet에 readCliKnob 스캔) · R5(checkout% 정직삭제, D1 staged 유지) · R6(**정확 FeatureSchema**: id/title/section/subsystem/maturity/purpose/config_refs.env; evidence 경로 실존 필수; objective-tools.yaml **dedup**; WORKTREE_CWD_PIN 추가)
- **DROP**: R2 — reveal은 유저 디스크 파일 여는 것=circumvention 0(항상 허용), copy-block도 cosmetic(cat 가능), 진짜 guard는 install/add 경로. authority.read()는 build-time registry라 F5 freshness 회귀. → 수정 안 함, 문서화.
- **DEFER**: R3(posture durable) — "wiring only" 거짓: initialMode seed 누락→default 회귀, `"session"` 상수키→동시세션 clobber, hot-path 미게이트 I/O. unique-session-key+seed+gating 설계 필요한 실 packet, default-OFF+rare-trigger=저urgency. / R7(near-god preemptive) — bootstrap-session 999·scheduler 997·loop-helpers 997·agent-config-assembler 997·agent-arg-builder 990이나 scheduler/agent-config-assembler는 동시세션 활발 편집=concurrent-hot, preemptive라 지금 착수 안 함.
- **NOT-OURS**: lint:debt 현재 RED=동시세션 `.claude/wf-*.js` format(commit 5872a3a5b); composition-slot 35의 32/35=동시세션 모델 bump(landed). R0는 내 몫(cwd 마스킹+objective) 포함해 마감하되 모델은 landed 반영.

## R0 — composition-slot 스냅샷 red (CI-red, P0)
- **기능**: `src/host/runtime/__tests__/composition-slot-registry-byte-identical.hellgate` 35 snapshot 실패
- **왜**: 스냅샷이 현재 합성과 불일치 — 전 35개가 모델기본값 `gpt-5.4→gpt-5.6-terra`(동시세션 변경), 6개는 추가로 C3 objective-port(`readDomain/prepare/commit/restore`). cwd 절대경로도 worktree/main 차이로 흔들릴 소지.
- **ROI**: 높음(green 회복). 위험=공유 스냅샷이라 동시세션도 갱신 시 충돌.
- **선행**: 동시세션이 모델 변경 장본인 — 조율 또는 그들 값 채택 수용. cwd 하드코딩이면 정규화 선행.
- **접근**: 세 축(model/objective-port/cwd)이 전부 legit 확장인지 검수 → 스냅샷 정규화(cwd는 상대화 또는 마스킹) 후 갱신 → diff가 정확히 그 세 축만인지 확인.
- **검증**: 갱신 후 diff 3축만; 무관 슬롯 변조 red-on-injection.

## R1 — skill 교차프로세스 setEnabled lost-update (M4, P1)
- **기능**: `src/skill/runtime/adapters/json-disabled-store.ts` write가 on-disk revision 비교 없이 unconditional atomic rename.
- **왜**: CLI+web-daemon이 `<userDir>/.disabled.json` 공유 시 둘 다 rev N서 서로 다른 skill disable → 나중 write가 앞 clobber → 한 세션 disable 소실. authority CAS는 in-process뿐.
- **ROI**: 중(2세션 동시 + gate ON 필요; 보안 아님, 데이터 유실).
- **선행**: 없음.
- **접근**: disabled-store write를 read-modify-CAS로 — 파일 rev 읽어 expected와 비교, 불일치면 authority `sync()` 후 재시도(bounded). E2 posture-store의 persist-before-publish 패턴 재사용. O_EXCL/원자성 유지.
- **검증**: 파일공유 2-writer race 테스트(1 commit + 1 stale-reject, 양쪽 disable 보존), red-on-injection(CAS 제거→clobber).

## R2 — copy/reveal이 banned/disabled projection 우회 (M9, P1, **결정 필요**)
- **기능**: `node-skill-actions.resolveCanonicalSkill`이 독립 `buildSkillSnapshot`+lookup으로 authority의 user-disabled/admin-banned 무시.
- **왜**: `/skill copy`/`reveal`이 admin-banned·user-disabled skill도 성공 → 정책 우회. 단 파일 inspect라 "허용" 여지 존재.
- **ROI**: 중. **정책 판단 필요**(banned skill copy/reveal 허용? 차단?).
- **선행**: 결정 — 차단이면 action ports가 authority projection 경유; 허용이면 현상+주석.
- **접근(차단 시)**: copy/reveal이 authority.read()의 disabled/banned 조회 후 banned/disabled → typed `refused`(reveal의 unsupported와 구분되는 policy-denied). 검증: banned skill copy/reveal → refused; enabled → 정상.

## R3 — posture 재시작 미보존 (M2, P2)
- **기능**: 라이브 posture가 `createSeededPosturePersistence`(in-memory Map, thread=`"session"`)만 사용; durable `createStorePosturePersistence`(permission-store 백드, E2 구현)는 호출자 0.
- **왜**: mode/posture가 재시작 시 `runtime.mode`로 리시드 → E2의 버전드 posture 섹션(fail-closed 검증+thread-copy 경계)이 프로덕션 미사용 → RFC-05 resume rail이 isolation서만 증명.
- **ROI**: 중(완성도; default-OFF라 지금 무해, selector 켜면 재시작 리셋).
- **선행**: 없음(store 이미 구현, 배선만).
- **접근**: `buildLivePosture`/bootstrap이 in-memory seed 대신 `createStorePosturePersistence` 주입; thread-copy 경계 + corrupt fail-closed 실경로 태움. default-OFF byte-identity 유지(posture 미변경 시 seed와 동일 복원).
- **검증**: 재시작 e2e(새 런타임이 persisted posture 복원), corrupt 파일→current-behavior, red-on-injection.

## R4 — knob 미등록 + completeness 사각 (P3)
- **기능**: `QUANTA_POSTURE_SELECTOR`·`QUANTA_SKILL_ACTIONS`가 knob inventory 미등록(readCliKnob 직독); completeness-ratchet이 readCliKnob 키 못 봄.
- **왜**: `/knobs` 카탈로그·default-parity 부재 + 라쳇 blind-spot(신규 readCliKnob 무등록 키가 green 통과 — Fix-3서 실증). WORKTREE_PROGRESS는 M5서 등록됨.
- **ROI**: 중(거버넌스; 재발 방지 포함).
- **선행**: 없음.
- **접근**: 두 knob 등록(Fix-3 M5 패턴, bool default-off). completeness-ratchet에 `readCliKnob(...)` 스캔 추가 → 무등록 키 red.
- **검증**: 카탈로그에 두 키 존재+parity; 라쳇이 무등록 readCliKnob 주입 시 red.

## R5 — worktree checkout-% (D2, P4, **결정 필요**)
- **기능**: RFC-04 D2 실시간 checkout % 체인(checkoutProgressObserver→node_progress producer)이 dead(zero caller).
- **왜**: `git worktree add`에 `--progress` 없음(재확인: "unknown option `progress'") → git이 진행률 미방출 → 현 메커니즘으론 % 원천 불가. D1 staged(workspace→checkout→done)는 작동.
- **ROI**: 낮음/불가. **결정 필요**.
- **선행**: (a) "staged only, % 미지원" 정직 문서화 + orphan % 코드 정리, 또는 (b) checkout 메커니즘 교체(manual checkout `--progress`) 재설계(고비용).
- **접근(권장 a)**: D2 % producer/observer를 삭제 또는 D1 staged로 흡수; 관련 knob/주석을 "staged progress only"로 정직화.

## R6 — feature-catalog 누락 등록 (P3, 유저 명시 요구)
- **기능**: 캠페인 게이트 기능이 fc 미등록 — `QUANTA_ATTENTION_NAV`, `QUANTA_WORKTREE_PROGRESS`, `QUANTA_POSTURE_SELECTOR`, `QUANTA_SKILL_ACTIONS`, `QUANTA_PROPOSE_GOAL`, question-guard, objective-mutate/posture-set/skill-set_enabled 명령.
- **왜**: fc는 기능 SSOT(env/gate/surface behavior/owner-local hellgate). 미등록 → 카탈로그 드리프트, `fc diff` 부정합.
- **ROI**: 중(SSOT 정합, 거버넌스).
- **선행**: fc yaml 스키마 확인(`09-integration/*.yaml` 포맷: name/env/gate/surfaces/hellgate ref). `docs/10.feature-catalog.md`는 파생이므로 `fc` 재생성.
- **접근**: 적절 카테고리(03-permission-safety=posture/question, 06-tier1 또는 09-integration=objective/attention/worktree/skill)에 각 기능 yaml 추가(env·default-OFF·surface behavior·owner-local hellgate 파일 참조). `fc` 재생성 후 drift green.
- **검증**: `bun test`의 feature-catalog validator green; `fc diff` = no changes.

## R7 — LOW (관측·정직성, P5)
- **F4**: `/attention`이 `QUANTA_ATTENTION_NAV`만으론 무동작(TaskRegistry=`QUANTA_SUBAGENT` 필요) → 게이트 문서 "AND QUANTA_SUBAGENT" 명시(또는 attention 게이트가 registry 자동 프로비전 — 후자는 범위 큼, 문서화 권장).
- **skill `.disabled.json` ungated read**: gate 없이 매 인터랙티브 세션 파일읽기(ENOENT→empty, output 동일). "gate-absent=zero side-effect" 엄격 기준이면 skill-runtime 게이트 뒤로; output-identical 기준이면 문서화.
- **near-god-module**: `runtime-factory.ts`/`scheduler.ts`/`bootstrap-session.ts`/`loop-helpers.ts` 996-999/1000 → 한 줄로 초과. 선제 헬퍼 추출.

## 실행 순서·병렬성
R0(단독, 동시세션 조율) → [R1 skill · R3 posture · R4 knob · R6 fc] 병렬(file-disjoint) → R2·R5(결정 후) → R7. 각 항목 hellgate(RED-first→구현→적대감사≥3R→red-on-injection→검증).

## 결정 문항 (착수 전)
1. **R2**: admin-banned/user-disabled skill의 `/skill copy`·`reveal` — 차단? 허용(현상)?
2. **R5**: checkout-% — 정직 삭제(권장)? checkout 메커니즘 재설계?
