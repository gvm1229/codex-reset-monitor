# Codex Monitor — 프로젝트 지침

## 목적과 실행

- 현재 운영은 0.9다. 소스는 codex-reset.com의 timeline·forecast·feed 공개 JSON으로 일반 리셋·리셋권의 모든 구조화된 신호·예고·상태 안내와 사용량 확대를 Discord에 알린다.
- 기존 운영 Worker 이름은 `tibo-codex-monitor`다. PC에 독립적인 Cloudflare 5분 Cron을 유지한다.
- 2026-09-23 사용자 승인으로 0.9를 운영 적용했다. 예상 메시지를 먼저 보여 준 뒤 발송 보류를 해제했다. 이후 운영 변경도 해당 버전의 명시 승인이 필요하다. 실제 상태는 `verification/0.9-production.md`와 원격 배포를 확인한다.
- 현재 사용자 지시: **실제 Discord 시험 전에 멈추고 허락을 요청한다.** 시험 전송 허락을 운영 전환 허락으로 확대하지 않는다.
- 2026-09-21 승인된 연결 시험 1건은 전송·본문 재조회까지 완료했다. 같은 승인을 추가 시험 전송에 재사용하지 않는다. 상세 결과는 `verification/0.8-implementation.md`에 있다.

## 코드·상태 규칙

- X API·HTML 수집·트윗 본문 의미 판정·시간 문장 해석·LLM을 도입하지 않는다.
- `src/source.js`: 고정 API, 식별 User-Agent, 10초 제한, 1 MiB 제한, 게시본 신선도.
- `src/events.js`와 `src/signals.js`: 확인한 공개 필드만 명시적으로 검사한다. 사용자 요구로 공식 예고의 window, 최신 암시, 공개 teasing 판정 등 추가 필드를 허용한다. 이 필드의 형식은 안정 계약이 아니므로 검사·진단하며 알 수 없는 값으로 완료를 추정하지 않는다.
- `src/delivery.js`: 단일 SQLite Durable Object와 순차 처리 대기열. 미발송·실발송·시험 상태는 분리한다.
- `src/discord.js`: 세 줄·한국어·KST 발표 시각·FixupX 링크 정확히 하나. 사이트 링크와 원본 X 링크·원문을 넣지 않는다. FixupX를 만들 수 없는 출처는 알림 보류. mentions 차단.
- 초기 목록의 종료된 이력은 보내지 않지만 API가 현재 활성으로 제공하는 예고·암시는 처음에도 한 번 알린다. unknown credits도 지급 미확인 신호로 구별한다.
- 게시 후 1시간 제한은 0.9에서 제거했다. 초기화 이후 새 사건·상태 전진·새 미래 시간 구간을 알리고, 과거 이력 보충은 초기화 시각 기준으로 제외한다. 429 재시도만 최초 시도 후 1시간으로 제한한다. 역행·같은 구간 재등장은 반복하지 않는다.
- 0.9의 `source_head:v1`은 확정 리셋·암시·예고·리셋권 단계별 확인 위치를 저장한다. 낡은 새 ID는 막되 기존 ID의 실제 새 상태는 허용한다. 0.8의 저장 기록으로 head를 복원하고 처리하지 않은 뒷부분으로 head를 앞당기지 않는다.
- 실제 리셋 적용 시각·계정 리셋 완료를 추정하지 않는다. 마감·중심 시각·구간을 API대로 구별한다. 통계 확률의 단순 변화와 unlock은 제외한다.
- 전송 직전 durable attempting 기록, wait=true Discord 응답의 메시지 ID를 영수증으로 기록한다. 불확실한 결과는 자동 재전송 금지.
- `STATE` KV는 옛 운영의 되돌리기용으로 남겨 두며 새 코드에서 사용하지 않는다. 정상 KV heartbeat 없음.

## 설정·보안

- 사용자 승인으로 운영 `wrangler.jsonc`의 `NOTIFICATIONS_ENABLED=true`, `ALERTS_HELD=false`를 사용한다. 시험판은 발송 `false`를 유지한다. `DISCORD_TEST_ENABLED=false`는 운영·시험판 모두 유지한다.
- 새 코드는 `X_BEARER_TOKEN`을 사용하지 않는다. 운영 안정 확인 전 원격의 옛 비밀 값·KV를 삭제하지 않는다.
- `DISCORD_WEBHOOK_URL`, `SMOKE_TEST_TOKEN` 값은 소스·`.dev.vars`·Wrangler 설정·대화·로그·커밋에 저장하지 않는다.
- `/run`은 인증된 읽기 진단 전용이다. 연결 시험은 별도 `/test-discord` 경로와 명시된 설정으로만 가능하다.
- `/preview-poll`은 인증된 무발송 시험판에만 열어 head 영속성을 확인한다. 운영 설정은 이 경로를 켜지 않는다.
- 실제 공개 API 시험은 분당 1회보다 자주 실행하지 않는다. Retry-After를 따른다.
- `wrangler.preview.jsonc`는 분리된 무발송·무Cron 시험판이다. 운영 KV·Webhook 비밀 값을 연결하지 않는다.

## 수정과 검증

1. 계획은 프로젝트 Markdown에 먼저 기록하고 기존 미커밋 변경을 보존한다.
2. 제품 버전은 `src/version.js`의 `0.X`, npm은 `0.X.0`; VERSION_HISTORY 규칙을 따른다.
3. `npm run check`, `npm test`를 실행한다. `test/*.test.js` 모두 자동 발견한다.
4. `npm test`의 네트워크는 가짜 API·Discord로 제한한다. workerd 시험에서 Durable Object·동시 요청·SQLite를 검증한다.
5. `npm run check:live-source`는 공개 API만 읽는다. `scripts/verify-preview.js`도 실제 Discord를 호출하지 않는다.
6. 빌드 확인은 `npx wrangler deploy --dry-run`. 운영 승인 없이 기본 설정으로 실제 deploy하지 않는다.
7. 운영 승인 후 실 Cron 확인에만 임시 1분 주기를 쓰고 마지막에 5분으로 복구한다.
8. 시험 결과는 로컬 Windows/Node, 로컬 workerd, 실제 Cloudflare를 구분한다. 가짜 Discord 성공을 실제 전달 성공으로 표현하지 않는다.

이전 X 분류·복구 절차는 역사 기록이며 현재 구현 지시가 아니다. 구현 전 파일 사본은 `.wrangler/backups/before-0-8-20260921`에 보관했다. 상세 동작·전환·되돌리기는 README와 CODEX_RESET_MIGRATION_PLAN을 따른다.
