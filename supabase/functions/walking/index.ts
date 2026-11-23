// 걷기 기록·보상 API — "보상 받게" 버튼으로 받는 방식 (2026-11-19 걷기 화면 설계)
//
//   POST /functions/v1/walking/records          걸음 저장만. 보상은 주지 않는다. (요청 형식은 앱 lib/walking-api.ts)
//     요청 { date, steps, distanceMeters, source, syncedAt }
//   POST /functions/v1/walking/rewards/claim    지금까지 활성화된(도달했고 아직 안 받은) 단계를 한꺼번에 받기
//     요청 { date }
//   GET  /functions/v1/walking/today?date=      그날 걷기 현황 (화면을 열 때)
//
// - steps·distanceMeters는 그날 0시부터의 누적값이다. 저장된 값보다 작으면 무시한다(줄어들지 않음).
// - 같은 날짜·단계 보상은 한 번만 준다.
import { fail, ok, readJson, subPath, todayKst } from '../_shared/http.ts';
import { admin, serveWithUser } from '../_shared/supabase.ts';
import { WALK_DAILY_DISTANCE_LIMIT_M, WALK_DAILY_STEP_LIMIT, WALK_GOAL_STEPS, WALK_TIERS } from '../_shared/rewards.ts';

// 앱 lib/walking-api.ts 의 WalkingDataSource
const SOURCES = ['mock', 'healthkit', 'healthconnect'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '날짜는 YYYY-MM-DD 형식의 오늘 이전 날짜여야 해요.';

// 미래 날짜는 받지 않는다 (한국 시간 기준)
function checkDate(date: unknown): string | null {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return null;
  return date <= todayKst() ? date : null;
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

// 그날 현황: 걸음·거리와 단계별 상태
async function walkingStatus(userId: string, date: string) {
  const [day, claims] = await Promise.all([
    admin.from('walk_days').select('steps, distance_meters').eq('user_id', userId).eq('date', date).maybeSingle(),
    admin.from('walk_reward_claims').select('tier').eq('user_id', userId).eq('date', date),
  ]);
  if (day.error) throw day.error;
  if (claims.error) throw claims.error;

  const steps = day.data?.steps ?? 0;
  const claimed = new Set(claims.data.map((row) => row.tier));
  const tiers = WALK_TIERS.map((t) => ({
    steps: t.tier,
    coins: t.coins,
    xp: t.xp,
    reached: steps >= t.tier,
    claimed: claimed.has(t.tier),
  }));
  return {
    date,
    steps,
    distanceMeters: day.data?.distance_meters ?? 0,
    goalSteps: WALK_GOAL_STEPS,
    tiers,
    // 지금 버튼을 누르면 받을 단계 (도달했고 아직 안 받음)
    claimableSteps: tiers.filter((t) => t.reached && !t.claimed).map((t) => t.steps),
    claimedSteps: tiers.filter((t) => t.claimed).map((t) => t.steps),
  };
}

serveWithUser(async (req, user) => {
  const path = subPath(req, 'walking');

  if (path === '/today') {
    if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
    const date = checkDate(new URL(req.url).searchParams.get('date') ?? todayKst());
    if (!date) return fail('VALIDATION_ERROR', { field: 'date' }, DATE_MESSAGE);
    return ok(await walkingStatus(user.id, date));
  }

  if (path === '/records') {
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const body = await readJson(req);
    if (!body) return fail('VALIDATION_ERROR', { field: 'body' }, 'JSON 형식으로 보내 주세요.');
    const date = checkDate(body.date);
    if (!date) return fail('VALIDATION_ERROR', { field: 'date' }, DATE_MESSAGE);
    if (!isCount(body.steps, WALK_DAILY_STEP_LIMIT)) {
      return fail('VALIDATION_ERROR', { field: 'steps', max: WALK_DAILY_STEP_LIMIT }, '걸음 수가 올바르지 않아요.');
    }
    // 거리는 소수가 올 수 있어 반올림한다. 없으면 0.
    const distance = body.distanceMeters === undefined ? 0 : Math.round(Number(body.distanceMeters));
    if (!isCount(distance, WALK_DAILY_DISTANCE_LIMIT_M)) {
      return fail('VALIDATION_ERROR', { field: 'distanceMeters' }, '거리가 올바르지 않아요.');
    }
    if (typeof body.source !== 'string' || !SOURCES.includes(body.source)) {
      return fail('VALIDATION_ERROR', { field: 'source', allowed: SOURCES });
    }

    const { error } = await admin.rpc('record_walk_day', {
      p_user: user.id,
      p_date: date,
      p_steps: body.steps,
      p_distance: distance,
      p_source: body.source,
    });
    if (error) throw error;
    // reward는 앱의 기존 응답 해석(lib/walking-api.ts parseResponse)이 깨지지 않게 항상 null로 둔다.
    return ok({ reward: null, ...(await walkingStatus(user.id, date)) });
  }

  if (path === '/rewards/claim') {
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const body = await readJson(req);
    if (!body) return fail('VALIDATION_ERROR', { field: 'body' }, 'JSON 형식으로 보내 주세요.');
    const date = checkDate(body.date);
    if (!date) return fail('VALIDATION_ERROR', { field: 'date' }, DATE_MESSAGE);

    // 활성화된 단계를 하나씩 받는다. 동시에 두 번 눌러도 DB가 단계마다 한 번만 지급한다.
    const before = await walkingStatus(user.id, date);
    let coins = 0;
    let xp = 0;
    const gotSteps: number[] = [];
    for (const tier of WALK_TIERS) {
      if (!before.claimableSteps.includes(tier.tier)) continue;
      const { data: result, error } = await admin.rpc('claim_walk_reward', {
        p_user: user.id,
        p_date: date,
        p_tier: tier.tier,
        p_coins: tier.coins,
        p_xp: tier.xp,
      });
      if (error) throw error;
      if (result === 'ok') {
        coins += tier.coins;
        xp += tier.xp;
        gotSteps.push(tier.tier);
      }
    }
    if (gotSteps.length === 0) return fail('NOTHING_TO_CLAIM', { date });

    const after = await walkingStatus(user.id, date);
    return ok({ reward: { coins, xp }, rewardedSteps: gotSteps, ...after });
  }

  return fail('NOT_FOUND');
});
