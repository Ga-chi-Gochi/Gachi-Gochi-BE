// 내 정보 API
//   GET /functions/v1/me  → 프로필, 재화, 보유 알
import { fail, ok, subPath } from '../_shared/http.ts';
import { admin, serveWithUser } from '../_shared/supabase.ts';

serveWithUser(async (req, user) => {
  if (subPath(req, 'me') !== '/') return fail('NOT_FOUND');
  if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');

  const [profile, stats, eggs] = await Promise.all([
    admin.from('profiles').select('nickname, created_at').eq('id', user.id).maybeSingle(),
    admin.from('user_stats').select('coins, xp, growth_stacks').eq('user_id', user.id).maybeSingle(),
    admin.from('user_eggs').select('egg_id, count').eq('user_id', user.id),
  ]);
  for (const result of [profile, stats, eggs]) {
    if (result.error) throw result.error;
  }

  return ok({
    userId: user.id,
    isAnonymous: user.is_anonymous ?? false,
    nickname: profile.data?.nickname ?? null,
    createdAt: profile.data?.created_at ?? null,
    stats: {
      coins: stats.data?.coins ?? 0,
      xp: stats.data?.xp ?? 0,
      growthStacks: stats.data?.growth_stacks ?? 0,
    },
    eggs: Object.fromEntries((eggs.data ?? []).map((row) => [row.egg_id, row.count])),
  });
});
