-- process_referral_bonus(p_player_id, p_deposit_amount) was wired into
-- enter_dungeon on top of spend, not deposit -- its own parameter name
-- (p_deposit_amount) is the giveaway that this was never the intended
-- trigger. That meant referral reward fired on every dungeon entry, and
-- the previous migration's deposit-balance cap was a workaround bolted
-- onto the wrong call site.
--
-- Real fix: referral bonus now fires exactly once, at the moment a TON
-- deposit is verified and credited, based on the deposited amount. Dungeon
-- entry no longer touches referral bonus at all. The deposit_balance_for_referral
-- cap-and-drawdown machinery from the previous migration is no longer
-- needed and is removed along with it.

create or replace function public.credit_verified_deposit(p_user_id bigint, p_tx_hash text, p_amount numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into deposits (user_id, tx_hash, amount, status)
  values (p_user_id, p_tx_hash, p_amount, 'credited')
  on conflict (tx_hash) do nothing;

  if not found then
    return jsonb_build_object('success', false, 'message', 'already_processed');
  end if;

  update users
  set gram_balance = gram_balance + p_amount
  where id = p_user_id;

  perform process_referral_bonus(p_user_id, p_amount);

  return jsonb_build_object('success', true);
end;
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

  return jsonb_build_object('success', true, 'message', 'Поход успешно начат');
end;
$$;

alter table public.users
  drop column if exists deposit_balance_for_referral;
