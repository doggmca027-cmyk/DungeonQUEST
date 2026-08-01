-- Withdrawals could be funded by task rewards / daily check-ins, letting a
-- user deposit a small amount, farm free tasks, and withdraw more than they
-- ever deposited (e.g. deposit 0.3 GRAM, complete tasks, immediately
-- withdraw and net ~0.4 GRAM after fee).
--
-- Fix: track a separate "withdrawable_balance" pool. It only grows from a
-- verified TON deposit, a referral bonus, or the full payout of a claimed
-- expedition (task/daily-bonus GRAM becomes withdrawable only once it's been
-- wagered through a dungeon round-trip -- entering a dungeon draws the pool
-- down by the entry cost, floored at 0, and claiming adds back the full
-- reward). complete_task, claim_daily_bonus and admin_credit_balance are
-- intentionally left untouched -- they keep crediting gram_balance for
-- spending, just never withdrawable_balance. Withdrawals are capped at
-- least(gram_balance, withdrawable_balance).
--
-- Existing users are backfilled from lifetime deposits + current
-- referral_earnings -- past expedition claims can't be reconstructed (claimed
-- expeditions are deleted, no ledger), so any balance sitting there purely
-- from past task/daily-bonus/expedition activity starts non-withdrawable
-- until it's re-earned via a deposit, referral bonus, or a fresh dungeon
-- round-trip after this migration.

alter table public.users
  add column if not exists withdrawable_balance numeric not null default 0;

update public.users u
set withdrawable_balance = coalesce(
  (select sum(d.amount) from public.deposits d where d.user_id = u.id and d.status = 'credited'),
  0
) + coalesce(u.referral_earnings, 0);

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
      withdrawable_balance = withdrawable_balance + p_amount
  where id = p_user_id;

  perform process_referral_bonus(p_user_id, p_amount);

  return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.process_referral_bonus(p_player_id bigint, p_deposit_amount numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_level1 bigint;
  v_level2 bigint;
  v_level3 bigint;
  v_bonus numeric;
begin
  select referred_by into v_level1 from users where id = p_player_id;
  if v_level1 is null then
    return;
  end if;

  v_bonus := p_deposit_amount * 0.10;
  update users
  set gram_balance = gram_balance + v_bonus,
      referral_earnings = referral_earnings + v_bonus,
      referral_earnings_l1 = referral_earnings_l1 + v_bonus,
      withdrawable_balance = withdrawable_balance + v_bonus
  where id = v_level1;

  select referred_by into v_level2 from users where id = v_level1;
  if v_level2 is null then
    return;
  end if;

  v_bonus := p_deposit_amount * 0.05;
  update users
  set gram_balance = gram_balance + v_bonus,
      referral_earnings = referral_earnings + v_bonus,
      referral_earnings_l2 = referral_earnings_l2 + v_bonus,
      withdrawable_balance = withdrawable_balance + v_bonus
  where id = v_level2;

  select referred_by into v_level3 from users where id = v_level2;
  if v_level3 is null then
    return;
  end if;

  v_bonus := p_deposit_amount * 0.02;
  update users
  set gram_balance = gram_balance + v_bonus,
      referral_earnings = referral_earnings + v_bonus,
      referral_earnings_l3 = referral_earnings_l3 + v_bonus,
      withdrawable_balance = withdrawable_balance + v_bonus
  where id = v_level3;
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
  set gram_balance = gram_balance - v_total_cost,
      withdrawable_balance = greatest(0, withdrawable_balance - v_total_cost)
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

create or replace function public.claim_expedition(p_expedition_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
  v_exp record;
  v_total_reward numeric;
begin
  if v_user_id is null then
    return jsonb_build_object('success', false, 'message', 'Unauthorized');
  end if;

  select * into v_exp
  from public.expeditions
  where id = p_expedition_id and user_id = v_user_id and is_claimed = false
  for update;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Поход не найден или уже забран');
  end if;

  if timezone('utc'::text, now()) < v_exp.end_time then
    return jsonb_build_object('success', false, 'message', 'Время похода ещё не истекло');
  end if;

  v_total_reward := v_exp.reward_per_unit * v_exp.active_count;

  update public.users
  set gram_balance = gram_balance + v_total_reward,
      withdrawable_balance = withdrawable_balance + v_total_reward
  where id = v_user_id;

  delete from public.expeditions where id = p_expedition_id;

  return jsonb_build_object('success', true, 'reward', v_total_reward);
end;
$function$;

create or replace function public.request_withdrawal(p_amount_gram numeric)
 returns setof withdrawals
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
  v_wallet_address text;
  v_balance numeric;
  v_withdrawable_balance numeric;
  v_final_amount numeric;
  v_min_withdrawal numeric;
  v_fee_rate numeric;
begin
  if v_user_id is null then
    raise exception 'Unauthorized';
  end if;

  select (value::numeric) into v_min_withdrawal from app_settings where key = 'min_withdrawal_gram';
  select (value::numeric) into v_fee_rate from app_settings where key = 'withdrawal_fee_rate';
  v_min_withdrawal := coalesce(v_min_withdrawal, 0.5);
  v_fee_rate := coalesce(v_fee_rate, 0.1);

  if p_amount_gram is null or p_amount_gram < v_min_withdrawal then
    raise exception 'amount_too_low';
  end if;

  select wallet_address, gram_balance, withdrawable_balance
  into v_wallet_address, v_balance, v_withdrawable_balance
  from users
  where id = v_user_id
  for update;

  if not found then
    raise exception 'user_not_found';
  end if;

  if v_wallet_address is null then
    raise exception 'wallet_not_connected';
  end if;

  if v_balance < p_amount_gram then
    raise exception 'insufficient_balance';
  end if;

  if v_withdrawable_balance < p_amount_gram then
    raise exception 'insufficient_withdrawable_balance';
  end if;

  v_final_amount := p_amount_gram * (1 - v_fee_rate);

  update users
  set gram_balance = gram_balance - p_amount_gram,
      withdrawable_balance = withdrawable_balance - p_amount_gram
  where id = v_user_id;

  return query
    insert into withdrawals (user_id, amount_gram, final_amount, wallet_address, status)
    values (v_user_id, p_amount_gram, v_final_amount, v_wallet_address, 'pending')
    returning *;
end;
$function$;

create or replace function public.reject_withdrawal(p_withdrawal_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
  v_target_user_id bigint;
  v_amount numeric;
begin
  if v_user_id != 6288342755 then
    raise exception 'Unauthorized: Access denied';
  end if;

  update withdrawals
  set status = 'rejected',
      processed_at = now()
  where id = p_withdrawal_id
    and status = 'pending'
  returning user_id, amount_gram into v_target_user_id, v_amount;

  if not found then
    raise exception 'Withdrawal request not found or already processed';
  end if;

  update users
  set gram_balance = gram_balance + v_amount,
      withdrawable_balance = withdrawable_balance + v_amount
  where id = v_target_user_id;
end;
$function$;
