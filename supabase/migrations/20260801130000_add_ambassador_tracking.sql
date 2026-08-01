-- Ambassador tracking: admin can flag any user as an ambassador, then see
-- per-ambassador stats -- how many direct (level-1) referrals they brought
-- in, and total deposits from their level-1/2/3 downline, tracked
-- separately per level so the admin can judge how deep an ambassador's
-- network actually converts, not just how many people they invited.

alter table public.users
  add column if not exists is_ambassador boolean not null default false;

create or replace function public.admin_set_ambassador(p_target_telegram_id bigint, p_is_ambassador boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_admin_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
begin
  if v_admin_id != 6288342755 then
    raise exception 'Unauthorized: Access denied';
  end if;

  update users set is_ambassador = p_is_ambassador where id = p_target_telegram_id;

  if not found then
    raise exception 'user_not_found';
  end if;
end;
$function$;

create or replace function public.get_ambassador_stats()
 returns table (
   ambassador_id bigint,
   username text,
   first_name text,
   level1_count bigint,
   level1_deposits numeric,
   level2_deposits numeric,
   level3_deposits numeric
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
begin
  if v_caller_id != 6288342755 then
    raise exception 'Unauthorized: Access denied';
  end if;

  return query
  with ambassadors as (
    select u.id, u.username, u.first_name from users u where u.is_ambassador = true
  ),
  level1 as (
    select u.id as descendant_id, u.referred_by as amb_id
    from users u
    join ambassadors a on u.referred_by = a.id
  ),
  level2 as (
    select u.id as descendant_id, l1.amb_id
    from users u
    join level1 l1 on u.referred_by = l1.descendant_id
  ),
  level3 as (
    select u.id as descendant_id, l2.amb_id
    from users u
    join level2 l2 on u.referred_by = l2.descendant_id
  ),
  level1_counts as (
    select l1.amb_id, count(*) as cnt from level1 l1 group by l1.amb_id
  ),
  level1_deposits as (
    select l1.amb_id, coalesce(sum(d.amount), 0) as total
    from level1 l1
    join deposits d on d.user_id = l1.descendant_id and d.status = 'credited'
    group by l1.amb_id
  ),
  level2_deposits as (
    select l2.amb_id, coalesce(sum(d.amount), 0) as total
    from level2 l2
    join deposits d on d.user_id = l2.descendant_id and d.status = 'credited'
    group by l2.amb_id
  ),
  level3_deposits as (
    select l3.amb_id, coalesce(sum(d.amount), 0) as total
    from level3 l3
    join deposits d on d.user_id = l3.descendant_id and d.status = 'credited'
    group by l3.amb_id
  )
  select
    a.id,
    a.username,
    a.first_name,
    coalesce(lc.cnt, 0),
    coalesce(ld1.total, 0),
    coalesce(ld2.total, 0),
    coalesce(ld3.total, 0)
  from ambassadors a
  left join level1_counts lc on lc.amb_id = a.id
  left join level1_deposits ld1 on ld1.amb_id = a.id
  left join level2_deposits ld2 on ld2.amb_id = a.id
  left join level3_deposits ld3 on ld3.amb_id = a.id
  order by (coalesce(ld1.total, 0) + coalesce(ld2.total, 0) + coalesce(ld3.total, 0)) desc;
end;
$function$;
