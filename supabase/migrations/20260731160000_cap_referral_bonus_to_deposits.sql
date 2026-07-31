-- Referral bonus was paid on every dungeon entry regardless of whether the
-- GRAM being spent ever came from a real TON deposit -- free daily-checkin
-- GRAM (and dungeon payout profit itself) could fund entries that still
-- triggered full referral payouts up the chain, letting a referral network
-- mint withdrawable GRAM with zero TON ever deposited.
--
-- Fix: track a per-user "deposit_balance_for_referral" pool that only grows
-- on verified TON deposits and only shrinks as that user's dungeon spend
-- draws it down. process_referral_bonus is now only invoked for the portion
-- of a dungeon entry's cost that's still backed by that pool -- spend beyond
-- it (funded by free/house GRAM) generates no referral bonus at all.
--
-- Existing users are backfilled from their lifetime credited deposits so
-- legitimate depositors aren't penalized for spend that predates this fix.

alter table public.users
  add column if not exists deposit_balance_for_referral numeric not null default 0;

update public.users u
set deposit_balance_for_referral = coalesce(
  (select sum(d.amount) from public.deposits d where d.user_id = u.id and d.status = 'credited'),
  0
);

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
  set gram_balance = gram_balance + p_amount,
      deposit_balance_for_referral = deposit_balance_for_referral + p_amount
  where id = p_user_id;

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
  v_deposit_balance numeric;
  v_referral_eligible numeric;
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

  select gram_balance, deposit_balance_for_referral into v_balance, v_deposit_balance
  from public.users
  where id = v_user_id
  for update;

  if v_balance < v_total_cost then
    return jsonb_build_object('success', false, 'message', 'Недостаточно средств');
  end if;

  v_referral_eligible := least(v_total_cost, v_deposit_balance);

  update public.users
  set gram_balance = gram_balance - v_total_cost,
      deposit_balance_for_referral = deposit_balance_for_referral - v_referral_eligible
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

  if v_referral_eligible > 0 then
    perform process_referral_bonus(v_user_id, v_referral_eligible);
  end if;

  return jsonb_build_object('success', true, 'message', 'Поход успешно начат');
end;
$$;
