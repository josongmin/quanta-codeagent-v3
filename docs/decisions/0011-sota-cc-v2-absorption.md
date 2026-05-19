# ADR-0011: Claude Code v2 SOTA++ 흡수 (Tier 0+1)

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §1.2(SOTA++ 스탠스), §16(흡수 명세), §3.1(슬라이스 격리), §9.2(슬라이스 추가 = ADR 트리거), §12(anti-bloat 위험), ADR-0001(Biome 슬라이스 격리), ADR-0008(메모리 SOTA++ — 동일 override 패턴 선례)

## 결정

Claude Code v2의 능력·견고성 메커니즘을 **LoC 무관·ROI 무관으로 의도적
흡수**한다. RFC의 minimal-surface / <20k LoC 강박은 ADR-0008·본 ADR에서
폐기됐으며, **전역 LoC 상한은 ADR-0012로 영구 철회**됐다.

- **Tier 0** (agent 슬라이스 내, 슬라이스 무신설): HARD_DENY 경로 독립
  바이패스 차단(git `-c`/`--exec-path`/`--config-env`, find action-flag),
  `auto` 권한 모드 + 주입식 `ClassifierPort`(2-stage, 거부 한도 3/20, AFK
  sticky), 도구 결과 크기 캡 + 200k 디스크 스필(`<persisted-output>`),
  FallbackLLM 멀티-provider 스왑 + `stream_reset` tombstone,
  CompactionBreaker rapid-refill/thrash 차단 + reactiveCompact fail-fast.
- **Tier 1** (신규 슬라이스): `@/subagent`(`Agent`/`Task` 도구 +
  `TaskRegistry` + 주입식 `SubagentRunner`가 `runAgent` 포크 + git
  worktree 격리), `@/skill`(`Skill`/`ToolSearch` + frontmatter 발견 +
  조건부 활성), 스트리밍 도구 실행(스트림 중 인터리브 디스패치, 순서 보존,
  unsafe head-of-line).

**의도적 미흡수**(ROI 무관에도 제외): 백그라운드 데몬/launchd/
remote-bridge, Statsig/GrowthBook 원격 게이트+kill-switch, Datadog+코호트
텔레메트리, 전체 speculative 프롬프트 실행(CC가 `JX8()=false`로 데드코드
출하).

## 배경

ADR-0008에서 메모리에 한해 anti-bloat 에토스를 사용자 지시로 override한
선례가 있다. 본 패스는 그 원칙을 에이전트 능력·견고성 전반으로 확장한다.
RFC §1.2의 "FSM/워크플로우 거부, enterprise 안전망은 필요할 때" 입장은
v2의 워크플로우 무게(406k LoC) 트라우마에서 나온 것이지만, CC v2의 안전
하드닝·서브에이전트·스킬·스트리밍은 워크플로우 엔진이 아니라 ReAct 루프의
능력·견고성 메커니즘이라 분리 흡수가 정당하다.

## 근거

- 흡수 대상은 전부 ReAct 루프의 능력/견고성 메커니즘 — FSM/워크플로우
  엔진(여전히 거부)이 아니다. 미흡수 4종은 제품/운영/실험 인프라이거나
  레퍼런스 팀이 죽인 코드라 능력 이득이 없고 네트워크·프라이버시·벤더
  표면만 늘린다 → 흡수/제외 경계가 "에이전트 능력인가"로 일관.
- **슬라이스 격리 보존**: `@/subagent`·`@/skill`은 §3.1 매트릭스에 그대로
  편입 — `@/agent`만 교차 import, 이들끼리 금지, Biome `overrides[]` 동일
  확장. Tier 0은 슬라이스 무신설(agent 내부). 격리 계약 무손상.
- **동작 보존(established 패턴)**: 신규 `AgentConfig` 필드 전부 optional,
  주입식 포트(`ClassifierPort`/`SubagentRunner`) 미주입 시 경로가 죽은 채
  루프 byte-for-byte 불변 — memory/compaction/hooks/plan과 동형.
- **역공학 doc 간접화 주의**: CC v2를 직접 복사하지 않는다. 동작을
  재유도(re-derive)하고 행위 테스트로 고정한다. 식별자·내부 상수는 행위
  동치의 근거가 아니며, 검증 기준은 전체 테스트 피라미드의 결정론 통과다.

## 트레이드오프

- **얻은 것**: 경로 독립 권한 하드닝 + LLM 분류기, multi-provider
  fallback·compaction thrash 내성으로 장수 trajectory 견고화, 격리 컨텍스트
  subagent + skill 동적 능력, 스트리밍 도구 디스패치 지연 단축. 슬라이스
  격리·동작 보존 무손상.
- **잃은 것 / 비용**: minimal-surface 에토스(§12 anti-bloat의 LoC 측면)를
  **의도적 override**(ADR-0008과 동형; 전역 LoC 캡은 ADR-0012로 철회).
  이동 부품·표면·worktree·classifier·fallback의 운영 복잡도 증가.
  **완화**: 전부 optional/주입식 기본 OFF, 미주입 시 루프 불변, 슬라이스
  격리 Biome 강제 유지, 미흡수 목록으로 네트워크/벤더 표면 명시적 차단,
  전체 테스트 피라미드 결정론 통과.

## 대안

- **흡수 전면 거부(원 minimal 스탠스 고수)**: 기각 — 사용자 명시 지시,
  ADR-0008 선례와 모순.
- **CC v2 직접 포팅/복사**: 기각 — 라이선스·doc 간접화 리스크, 식별자
  결합. 재유도 + 행위 테스트 고정으로 갈음.
- **subagent/skill을 agent 내부 모듈로**: 기각 — 도메인 경계가 뚜렷하고
  교차 import 표면이 커 §3.1 슬라이스화가 격리 강제에 유리.

## 검증

- 코드 동작 후 작성(RFC §9.1): 본 세션 빌드 전부 그린 — 전체 레포
  `tsc` exit 0, 단위+통합 피라미드 그린(현재 ≈950 통과; 하드 카운트는
  드리프트 방지 위해 본 ADR에 고정하지 않음). Tier 0 하드닝·분류기·
  fallback·breaker는 결정론 단위/주입 통합 테스트, subagent/skill/스트리밍은
  fake 주입 통합 테스트로 행위 고정.
- 상세 아키텍처: RFC §16. 슬라이스 격리: §3.1·ADR-0001. 본 ADR은
  문서 전용 — src/tests 무변경.
