// 탐험 API
//   POST /functions/v1/explore/trips                 { gochiId, durationMs, dispatchedAt } → { tripId, endsAt, ... }
//        (앱 lib/explore-api.ts 형식. 끝나는 시각은 서버가 정한다)
//   GET  /functions/v1/explore/today                 → 오늘 남은 횟수, 진행 중인 탐험          (서버 추가)
//   POST /functions/v1/explore/trips/<tripId>/claim  → 끝난 탐험의 보상(알)을 서버가 뽑아 줌  (서버 추가, 앱 미사용)
import { fail, ok, readJson, subPath, todayKst } from '../_shared/http.ts';
import { admin, serveWithUser } from '../_shared/supabase.ts';
import { EXPLORE_DAILY_LIMIT, EXPLORE_DURATION_MS, EXPLORE_GOCHI_IDS, pickRandomEggId } from '../_shared/rewards.ts';

const CLAIM_RE = /^\/trips\/([0-9a-f-]{36})\/claim$/i;

type TripRow = {
  id: string;
  gochi_id: string;
  dispatched_at: string;
  ends_at: string;
  claimed_at: string | null;
  egg_id: string | null;
};

function toTrip(row: TripRow) {
  return {
    tripId: row.id,
    gochiId: row.gochi_id,
    dispatchedAt: row.dispatched_at,
    endsAt: row.ends_at,
    finished: new Date(row.ends_at).getTime() <= Date.now(),
  };
}

async function usedToday(userId: string, date: string) {
  const { count, error } = await admin
    .from('explore_trips')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kst_date', date);
  if (error) throw error;
  return count ?? 0;
}

// 아직 끝나지 않은 탐험. 앱은 보상(알)을 기기에서 처리하므로 "보상 안 받음"이 아니라 "끝나는 시각 전"으로 본다.
async function runningTrip(userId: string) {
  const { data, error } = await admin
    .from('explore_trips')
    .select('*')
    .eq('user_id', userId)
    .is('claimed_at', null)
    .gt('ends_at', new Date().toISOString())
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as TripRow | null;
}

serveWithUser(async (req, user) => {
  const path = subPath(req, 'explore');

  if (path === '/today') {
    if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
    const date = todayKst();
    const [used, trip] = await Promise.all([usedToday(user.id, date), runningTrip(user.id)]);
    return ok({
      date,
      remaining: Math.max(0, EXPLORE_DAILY_LIMIT - used),
      dailyLimit: EXPLORE_DAILY_LIMIT,
      trip: trip ? toTrip(trip) : null,
    });
  }

  if (path === '/trips') {
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const body = await readJson(req);
    if (!body) return fail('VALIDATION_ERROR', { field: 'body' }, 'JSON 형식으로 보내 주세요.');
    const gochiId = body.gochiId;
    if (typeof gochiId !== 'string' || !(EXPLORE_GOCHI_IDS as readonly string[]).includes(gochiId)) {
      return fail('VALIDATION_ERROR', { field: 'gochiId', allowed: EXPLORE_GOCHI_IDS });
    }

    // 앱은 durationMs·dispatchedAt도 보내지만, 끝나는 시각은 서버가 정한다 (조작 방지)
    const date = todayKst();
    const [used, running] = await Promise.all([usedToday(user.id, date), runningTrip(user.id)]);
    if (running) return fail('EXPLORE_IN_PROGRESS', { endsAt: running.ends_at });
    if (used >= EXPLORE_DAILY_LIMIT) return fail('DAILY_LIMIT_EXCEEDED', { limit: EXPLORE_DAILY_LIMIT });

    const now = new Date();
    const { data, error } = await admin
      .from('explore_trips')
      .insert({
        user_id: user.id,
        kst_date: date,
        gochi_id: gochiId,
        dispatched_at: now.toISOString(),
        ends_at: new Date(now.getTime() + EXPLORE_DURATION_MS).toISOString(),
      })
      .select('*')
      .single();
    if (error) throw error;
    return ok({ ...toTrip(data as TripRow), remaining: Math.max(0, EXPLORE_DAILY_LIMIT - used - 1) }, 201);
  }

  const claim = path.match(CLAIM_RE);
  if (claim) {
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const tripId = claim[1].toLowerCase();
    const eggId = pickRandomEggId();
    const { data, error } = await admin.rpc('claim_explore_trip', {
      p_user: user.id,
      p_trip: tripId,
      p_egg: eggId,
    });
    if (error) throw error;
    if (data === 'not_found') return fail('NOT_FOUND');
    if (data === 'already_claimed') return fail('ALREADY_CLAIMED');
    if (data === 'not_finished') return fail('EXPLORE_NOT_FINISHED');

    const { data: egg, error: eggError } = await admin
      .from('user_eggs')
      .select('count')
      .eq('user_id', user.id)
      .eq('egg_id', eggId)
      .single();
    if (eggError) throw eggError;
    return ok({ tripId, eggId, eggCount: egg.count });
  }

  return fail('NOT_FOUND');
});
