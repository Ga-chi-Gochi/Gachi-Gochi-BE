-- 앱(FE) 코드의 API 형식에 서버를 맞춘다 (README "API 기준" 참고)
--
-- 1) 걷기: 앱이 거리(distanceMeters)도 보내므로 저장한다.
-- 2) 탐험: 앱은 보상(알)을 기기에서 처리하고 서버의 보상 받기 API를 부르지 않는다.
--    "보상 안 받은 탐험은 하나만" 규칙이 있으면 두 번째 파견부터 막히므로 없애고,
--    "아직 끝나지 않은 탐험이 있으면 막기"는 서버 함수 코드에서 확인한다.

alter table public.walk_days
  add column distance_meters integer not null default 0 check (distance_meters >= 0);

drop function public.record_walk_steps(uuid, date, integer, text);

-- 걸음·거리 저장 (기존보다 큰 값만 반영). 저장된 걸음 수를 돌려준다.
create function public.record_walk_day(p_user uuid, p_date date, p_steps integer, p_distance integer, p_source text)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.walk_days as w (user_id, date, steps, distance_meters, source)
  values (p_user, p_date, p_steps, p_distance, p_source)
  on conflict (user_id, date) do update
    set steps = greatest(w.steps, excluded.steps),
        distance_meters = greatest(w.distance_meters, excluded.distance_meters),
        source = excluded.source,
        updated_at = now()
  returning steps;
$$;

revoke execute on function public.record_walk_day(uuid, date, integer, integer, text) from public, anon, authenticated;
grant execute on function public.record_walk_day(uuid, date, integer, integer, text) to service_role;

drop index public.explore_trips_one_open;
create index explore_trips_user_ends on public.explore_trips (user_id, ends_at);
