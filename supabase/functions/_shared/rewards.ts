// 보상·제한 숫자는 임시값이라 코드 곳곳에 쓰지 않고 여기 한 곳에만 둔다.
// 앱(FE) 쪽 상수와 같은 값으로 맞춰 두었다. 밸런스를 바꿀 때는 양쪽을 같이 바꾼다.

// 걷기 단계별 보상 (FE constants/walking-reward.ts: 1,000 · 3,000 · 5,000보, 단계마다 코인 10 · 경험치 5)
export const WALK_TIERS = [
  { tier: 1000, coins: 10, xp: 5 },
  { tier: 3000, coins: 10, xp: 5 },
  { tier: 5000, coins: 10, xp: 5 },
] as const;

// 하루 걸음 수·거리가 이보다 크면 잘못된 값으로 본다
export const WALK_DAILY_STEP_LIMIT = 100_000;
export const WALK_DAILY_DISTANCE_LIMIT_M = 100_000;

// 봉그깅 (FE lib/bongging-reward.ts: 쓰레기 1개당 경험치 10 · 성장 1)
export const BONGGING_XP_PER_TRASH = 10;
export const BONGGING_GROWTH_PER_TRASH = 1;
// 사진 한 장에서 보상으로 쳐 주는 쓰레기 최대 개수 (부풀리기 방지)
export const BONGGING_MAX_TRASH_PER_PHOTO = 10;
// 하루 성공 인증 횟수
export const BONGGING_DAILY_LIMIT = 5;
// 하루 시도 횟수 (실패 포함). Gemini 무료 사용량을 지키기 위한 제한
export const BONGGING_DAILY_ATTEMPT_LIMIT = 20;
// 이 확신도(0~100) 미만인 품목은 쓰레기로 치지 않는다. 앱 기준(거르지 않음)에 맞춰 0
export const BONGGING_MIN_CONFIDENCE = 0;

// 탐험 (FE constants/explore.ts: 하루 3번, 지금은 테스트용 3초)
export const EXPLORE_DAILY_LIMIT = 3;
export const EXPLORE_DURATION_MS = 3 * 1000;
export const EXPLORE_GOCHI_IDS = ['sprout', 'buddy', 'gachi'] as const;

// 탐험 보상 알과 뽑힐 비율 (FE constants/gochi-eggs.ts의 weight)
export const GOCHI_EGGS = [
  { id: 'sprout-egg', weight: 40 },
  { id: 'dew-egg', weight: 30 },
  { id: 'forest-egg', weight: 20 },
  { id: 'star-egg', weight: 10 },
] as const;

export function pickRandomEggId(random = Math.random): string {
  const total = GOCHI_EGGS.reduce((sum, egg) => sum + egg.weight, 0);
  let roll = random() * total;
  for (const egg of GOCHI_EGGS) {
    roll -= egg.weight;
    if (roll < 0) return egg.id;
  }
  return GOCHI_EGGS[0].id;
}
