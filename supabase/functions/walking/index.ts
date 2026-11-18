// 걷기 기록·보상 API (앱 lib/walking-api.ts 형식)
//   POST /functions/v1/walking/records
//     요청 { date, steps, distanceMeters, source, syncedAt }
//     응답 { reward: { coins, xp } | null, claimedSteps: number[] }
//
// - steps·distanceMeters는 그날 0시부터의 누적값이다. 저장된 값보다 작으면 무시한다(줄어들지 않음).
// - 보상은 자동 지급: 저장하면서 새로 넘은 단계의 보상을 바로 준다. 여러 단계를 넘었으면 합쳐서 돌려준다.
// - 같은 날짜·단계 보상은 한 번만 준다. (앱은 걸음 수가 바뀔 때마다 보낸다)
import { fail, ok, readJson, subPath, todayKst } from '../_shared/http.ts';
import { admin, serveWithUser } from '../_shared/supabase.ts';
import { WALK_DAILY_DISTANCE_LIMIT_M, WALK_DAILY_STEP_LIMIT, WALK_TIERS } from '../_shared/rewards.ts';

// 앱 lib/walking-api.ts 의 WalkingDataSource
const SOURCES = ['mock', 'healthkit', 'healthconnect'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 미래 날짜는 받지 않는다 (한국 시간 기준)
function checkDate(date: unknown): string | null {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return null;
  return date <= todayKst() ? date : null;
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

serveWithUser(async (req, user) => {
  if (subPath(req, 'walking') !== '/records') return fail('NOT_FOUND');
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');

  const body = await readJson(req);
  if (!body) return fail('VALIDATION_ERROR', { field: 'body' }, 'JSON 형식으로 보내 주세요.');
  const date = checkDate(body.date);
  if (!date) return fail('VALIDATION_ERROR', { field: 'date' }, '날짜는 YYYY-MM-DD 형식의 오늘 이전 날짜여야 해요.');
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

  // 1) 저장 (더 큰 값만 반영) → 저장된 걸음 수
  const { data: savedSteps, error: saveError } = await admin.rpc('record_walk_day', {
    p_user: user.id,
    p_date: date,
    p_steps: body.steps,
    p_distance: distance,
    p_source: body.source,
  });
  if (saveError) throw saveError;

  // 2) 넘은 단계마다 보상 시도. 이미 받은 단계는 DB 함수가 'already_claimed'로 돌려준다.
  let coins = 0;
  let xp = 0;
  for (const tier of WALK_TIERS) {
    if (savedSteps < tier.tier) break;
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
    }
  }

  // 3) 그날 받은 단계 전체
  const { data: claims, error: claimsError } = await admin
    .from('walk_reward_claims')
    .select('tier')
    .eq('user_id', user.id)
    .eq('date', date)
    .order('tier');
  if (claimsError) throw claimsError;

  return ok({
    reward: coins > 0 || xp > 0 ? { coins, xp } : null,
    claimedSteps: claims.map((row) => row.tier),
  });
});
