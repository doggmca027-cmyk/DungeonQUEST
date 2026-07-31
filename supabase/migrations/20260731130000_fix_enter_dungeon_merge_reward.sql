-- Fix enter_dungeon: joining a second (or third, ...) batch of the same
-- dungeon while an earlier batch is still in progress left end_time
-- untouched, so a newly joined batch never got its own full 12h duration --
-- it just inherited whatever time was left on the existing batch's timer.
-- end_time is now extended to the later of the existing end_time and a
-- fresh 12h window, so a merged card only becomes claimable once every
-- batch's full duration has elapsed, per the "claim only when ALL timers
-- complete" rule.

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
  v_balance numeric;
  v_end_time timestamp with time zone;
  v_existing_id uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('success', false, 'message', 'Unauthorized');
  end if;

  select entry_cost_gram, reward_multiplier
  into v_cost, v_multiplier
  from public.dungeons
  where id = p_dungeon_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Подземелье не найдено');
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
  set gram_balance = gram_balance - v_total_cost
  where id = v_user_id;

  v_end_time := timezone('utc'::text, now()) + interval '12 hours';

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

  perform process_referral_bonus(v_user_id, v_total_cost);

  return jsonb_build_object('success', true, 'message', 'Поход успешно начат');
end;
$$;
