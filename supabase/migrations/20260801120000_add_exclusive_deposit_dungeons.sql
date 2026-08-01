-- Deposit-gated exclusive expeditions: 3 new dungeons per lifetime-deposit
-- threshold (15 / 30 / 50 GRAM), 9 total. They do not reuse or modify any
-- of the existing 8 dungeons. Same profit multiplier as the regular
-- dungeons (1.5x / +50%) -- the exclusivity is a shorter completion time
-- instead of a bigger reward: 6h for the 15-threshold tier, 8h for the
-- 30-threshold tier, 10h for the 50-threshold tier (all faster than the
-- standard 12h).
--
-- Gate is enforced server-side in enter_dungeon (never trust a client-side
-- lock), computed live from the deposits table -- no separate balance
-- tracking needed since it's a simple lifetime sum. get_lifetime_deposit_total
-- lets the client show unlock progress without needing raw table access.
--
-- enter_dungeon previously hardcoded a 12-hour expedition timer regardless
-- of dungeons.duration_hours (harmless before since every existing dungeon
-- happens to use 12h, but it would silently ignore the new tiers' shorter
-- durations) -- it now reads duration_hours per dungeon instead.

alter table public.dungeons
  add column if not exists min_lifetime_deposit_gram numeric not null default 0;

-- The existing 8 rows were inserted with explicit ids, bypassing the
-- identity/serial sequence, so nextval() still thinks id 1 is free. Bring
-- the sequence in sync with the actual max id before relying on it below.
select setval(pg_get_serial_sequence('public.dungeons', 'id'), (select max(id) from public.dungeons));

insert into public.dungeons (name, entry_cost_gram, reward_multiplier, duration_hours, min_lifetime_deposit_gram)
values
  -- tier 1: unlocks at 15 GRAM lifetime deposit, 6h, entry 1-10 GRAM
  ('Эксклюзив: Тайная тропа', 1, 1.5, 6, 15),
  ('Эксклюзив: Скрытый грот', 5, 1.5, 6, 15),
  ('Эксклюзив: Забытый ход', 10, 1.5, 6, 15),
  -- tier 2: unlocks at 30 GRAM lifetime deposit, 8h, entry 10-30 GRAM
  ('Эксклюзив: Ущелье теней', 10, 1.5, 8, 30),
  ('Эксклюзив: Дорога избранных', 20, 1.5, 8, 30),
  ('Эксклюзив: Врата рассвета', 30, 1.5, 8, 30),
  -- tier 3: unlocks at 50 GRAM lifetime deposit, 10h, entry 25-75 GRAM
  ('Эксклюзив: Зал героев', 25, 1.5, 10, 50),
  ('Эксклюзив: Трон бездны', 50, 1.5, 10, 50),
  ('Эксклюзив: Корона древних', 75, 1.5, 10, 50);

create or replace function public.get_lifetime_deposit_total()
 returns numeric
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(sum(amount), 0)
  from deposits
  where user_id = (auth.jwt() ->> 'telegram_id')::bigint
    and status = 'credited';
$function$;

create or replace function enter_dungeon(p_dungeon_id bigint, p_count integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_user_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
  v_cost numeric;
  v_total_cost numeric;
  v_reward numeric;
  v_multiplier numeric;
  v_min_deposit numeric;
  v_lifetime_deposit numeric;
  v_balance numeric;
  v_end_time timestamp with time zone;
  v_existing_id uuid;
  v_duration_hours numeric;
begin
  if v_user_id is null then
    return jsonb_build_object('success', false, 'message', 'Unauthorized');
  end if;

  select entry_cost_gram, reward_multiplier, min_lifetime_deposit_gram, duration_hours
  into v_cost, v_multiplier, v_min_deposit, v_duration_hours
  from public.dungeons
  where id = p_dungeon_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Подземелье не найдено');
  end if;

  if v_min_deposit > 0 then
    select coalesce(sum(amount), 0) into v_lifetime_deposit
    from public.deposits
    where user_id = v_user_id and status = 'credited';

    if v_lifetime_deposit < v_min_deposit then
      return jsonb_build_object('success', false, 'message', 'Подземелье ещё не разблокировано');
    end if;
  end if;

  v_total_cost := v_cost * p_count;
  v_reward := v_total_cost * v_multiplier;

  select gram_balance into v_balance
  from public.users
  where id = v_user_id
  for update;

  if v_balance < v_total_cost then
    return jsonb_build_object('success', false, 'message', 'Недостаточно средств');
  end if;

  update public.users
  set gram_balance = gram_balance - v_total_cost,
      withdrawable_balance = greatest(0, withdrawable_balance - v_total_cost)
  where id = v_user_id;

  v_end_time := timezone('utc'::text, now()) + (v_duration_hours::text || ' hours')::interval;

  select id into v_existing_id
  from public.expeditions
  where user_id = v_user_id
    and dungeon_id = p_dungeon_id
    and is_claimed = false
  for update;

  if v_existing_id is not null then
    update public.expeditions
    set active_count = active_count + p_count,
        reward_per_unit = v_cost * v_multiplier,
        end_time = greatest(end_time, v_end_time)
    where id = v_existing_id;
  else
    insert into public.expeditions (
      user_id, dungeon_id, active_count, entry_cost_per_unit, reward_per_unit, start_time, end_time
    ) values (
      v_user_id, p_dungeon_id, p_count, v_cost, v_cost * v_multiplier, timezone('utc'::text, now()), v_end_time
    );
  end if;

  return jsonb_build_object('success', true, 'message', 'Поход успешно начат');
end;
$$;
