-- 가치고치 첫 DB 구조
--
-- 원칙
-- - 모든 표에 RLS를 켠다. 앱(로그인한 사용자)은 "자기 것 읽기"만 할 수 있다.
-- - 기록 쓰기와 보상 지급은 서버 함수(Edge Function, service_role)만 한다. 앱이 보상을 직접 올릴 수 없게 하기 위해서다.
-- - 사용자는 Supabase Auth 사용자(auth.users)다. 지금은 익명 로그인, 나중에 카카오·구글·애플을 같은 계정에 연결한다.
-- - 날짜(date)는 한국 시간 기준이다.

-- ───────────── 표 ─────────────

-- 프로필
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text check (nickname is null or char_length(nickname) between 1 and 20),
  created_at timestamptz not null default now()
);

-- 재화·성장 (한 사람당 한 줄)
create table public.user_stats (
  user_id uuid primary key references auth.users (id) on delete cascade,
  coins integer not null default 0 check (coins >= 0),
  xp integer not null default 0 check (xp >= 0),
  growth_stacks integer not null default 0 check (growth_stacks >= 0),
  updated_at timestamptz not null default now()
);

-- 하루 걸음 수 (그날 누적값. 줄어드는 값은 받지 않는다)
create table public.walk_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  steps integer not null default 0 check (steps >= 0),
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- 걷기 단계 보상 받은 기록 (하루·단계마다 한 번)
create table public.walk_reward_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  tier integer not null,
  coins integer not null default 0,
  xp integer not null default 0,
  claimed_at timestamptz not null default now(),
  primary key (user_id, date, tier)
);

-- 봉그깅 인증 (사진 한 장 = 한 줄)
create table public.bongging_certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kst_date date not null,
  received_at timestamptz not null default now(),
  captured_at timestamptz,
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  location_source text not null default 'none' check (location_source in ('exif', 'device', 'none')),
  image_path text,
  image_sha256 text not null,
  status text not null check (status in ('success', 'failure')),
  items jsonb not null default '[]'::jsonb,
  xp integer not null default 0,
  growth_stacks integer not null default 0,
  model text,
  -- 같은 사진으로 두 번 인증하지 못하게
  unique (user_id, image_sha256)
);
create index bongging_certifications_user_date on public.bongging_certifications (user_id, kst_date);

-- 탐험 파견
create table public.explore_trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kst_date date not null,
  gochi_id text not null,
  dispatched_at timestamptz not null default now(),
  ends_at timestamptz not null,
  claimed_at timestamptz,
  egg_id text
);
create index explore_trips_user_date on public.explore_trips (user_id, kst_date);
-- 보상을 아직 안 받은 탐험은 한 사람당 하나만
create unique index explore_trips_one_open on public.explore_trips (user_id) where claimed_at is null;

-- 고치 알 보유 수
create table public.user_eggs (
  user_id uuid not null references auth.users (id) on delete cascade,
  egg_id text not null,
  count integer not null default 0 check (count >= 0),
  primary key (user_id, egg_id)
);

-- ───────────── 새 사용자 → 프로필·재화 줄 만들기 ─────────────

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.user_stats (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────── 서버 함수가 쓰는 DB 함수 (한 번에 처리해야 하는 것) ─────────────

-- 재화 더하기
create function public.add_user_stats(p_user uuid, p_coins integer, p_xp integer, p_growth integer)
returns public.user_stats
language sql
security definer
set search_path = ''
as $$
  insert into public.user_stats as s (user_id, coins, xp, growth_stacks)
  values (p_user, p_coins, p_xp, p_growth)
  on conflict (user_id) do update
    set coins = s.coins + excluded.coins,
        xp = s.xp + excluded.xp,
        growth_stacks = s.growth_stacks + excluded.growth_stacks,
        updated_at = now()
  returning *;
$$;

-- 걸음 수 저장 (기존보다 큰 값만 반영). 저장된 걸음 수를 돌려준다.
create function public.record_walk_steps(p_user uuid, p_date date, p_steps integer, p_source text)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.walk_days as w (user_id, date, steps, source)
  values (p_user, p_date, p_steps, p_source)
  on conflict (user_id, date) do update
    set steps = greatest(w.steps, excluded.steps),
        source = excluded.source,
        updated_at = now()
  returning steps;
$$;

-- 걷기 단계 보상 받기: 'ok' | 'not_enough_steps' | 'already_claimed'
create function public.claim_walk_reward(p_user uuid, p_date date, p_tier integer, p_coins integer, p_xp integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_steps integer;
begin
  select steps into v_steps from public.walk_days where user_id = p_user and date = p_date;
  if coalesce(v_steps, 0) < p_tier then
    return 'not_enough_steps';
  end if;

  insert into public.walk_reward_claims (user_id, date, tier, coins, xp)
  values (p_user, p_date, p_tier, p_coins, p_xp)
  on conflict do nothing;
  if not found then
    return 'already_claimed';
  end if;

  perform public.add_user_stats(p_user, p_coins, p_xp, 0);
  return 'ok';
end;
$$;

-- 탐험 보상 받기: 'ok' | 'not_found' | 'already_claimed' | 'not_finished'
create function public.claim_explore_trip(p_user uuid, p_trip uuid, p_egg text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.explore_trips;
begin
  select * into v_trip from public.explore_trips where id = p_trip and user_id = p_user for update;
  if not found then
    return 'not_found';
  end if;
  if v_trip.claimed_at is not null then
    return 'already_claimed';
  end if;
  if v_trip.ends_at > now() then
    return 'not_finished';
  end if;

  update public.explore_trips set claimed_at = now(), egg_id = p_egg where id = p_trip;
  insert into public.user_eggs as e (user_id, egg_id, count)
  values (p_user, p_egg, 1)
  on conflict (user_id, egg_id) do update set count = e.count + 1;
  return 'ok';
end;
$$;

-- ───────────── 권한 ─────────────
-- 표: 앱(authenticated)은 읽기만, 닉네임만 고칠 수 있다. 익명 키(anon)로는 아무것도 못 한다.

revoke all on public.profiles, public.user_stats, public.walk_days, public.walk_reward_claims,
  public.bongging_certifications, public.explore_trips, public.user_eggs
  from anon, authenticated;

grant select on public.profiles, public.user_stats, public.walk_days, public.walk_reward_claims,
  public.bongging_certifications, public.explore_trips, public.user_eggs
  to authenticated;
grant update (nickname) on public.profiles to authenticated;

grant all on public.profiles, public.user_stats, public.walk_days, public.walk_reward_claims,
  public.bongging_certifications, public.explore_trips, public.user_eggs
  to service_role;

-- DB 함수: 서버(service_role)만 부를 수 있다. 앱이 직접 부르면 보상을 마음대로 올릴 수 있으므로 막는다.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.add_user_stats(uuid, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.record_walk_steps(uuid, date, integer, text) from public, anon, authenticated;
revoke execute on function public.claim_walk_reward(uuid, date, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.claim_explore_trip(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.add_user_stats(uuid, integer, integer, integer) to service_role;
grant execute on function public.record_walk_steps(uuid, date, integer, text) to service_role;
grant execute on function public.claim_walk_reward(uuid, date, integer, integer, integer) to service_role;
grant execute on function public.claim_explore_trip(uuid, uuid, text) to service_role;

-- ───────────── RLS ─────────────

alter table public.profiles enable row level security;
alter table public.user_stats enable row level security;
alter table public.walk_days enable row level security;
alter table public.walk_reward_claims enable row level security;
alter table public.bongging_certifications enable row level security;
alter table public.explore_trips enable row level security;
alter table public.user_eggs enable row level security;

create policy "본인 프로필 읽기" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "본인 닉네임 고치기" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "본인 재화 읽기" on public.user_stats for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 걸음 읽기" on public.walk_days for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 걷기 보상 읽기" on public.walk_reward_claims for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 봉그깅 읽기" on public.bongging_certifications for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 탐험 읽기" on public.explore_trips for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 알 읽기" on public.user_eggs for select to authenticated
  using ((select auth.uid()) = user_id);

-- ───────────── 사진 저장소 ─────────────
-- 비공개. 경로는 "<user_id>/<인증 id>.<확장자>". 본인 사진만 읽을 수 있다. 올리기는 서버만.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bongging-photos', 'bongging-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do nothing;

create policy "본인 봉그깅 사진 읽기" on storage.objects for select to authenticated
  using (bucket_id = 'bongging-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
