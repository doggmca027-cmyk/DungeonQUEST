-- Guild tab: show earnings broken down per referral level (1/2/3), not just
-- the combined total. process_referral_bonus already credits users.gram_balance
-- and users.referral_earnings on each level of the chain; this adds three
-- per-level running totals so the UI can show how much each network level
-- actually brought in. Rates and chain-stop-on-null behavior are unchanged.

alter table public.users
  add column if not exists referral_earnings_l1 numeric not null default 0,
  add column if not exists referral_earnings_l2 numeric not null default 0,
  add column if not exists referral_earnings_l3 numeric not null default 0;

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
      referral_earnings_l1 = referral_earnings_l1 + v_bonus
  where id = v_level1;

  select referred_by into v_level2 from users where id = v_level1;
  if v_level2 is null then
    return;
  end if;

  v_bonus := p_deposit_amount * 0.05;
  update users
  set gram_balance = gram_balance + v_bonus,
      referral_earnings = referral_earnings + v_bonus,
      referral_earnings_l2 = referral_earnings_l2 + v_bonus
  where id = v_level2;

  select referred_by into v_level3 from users where id = v_level2;
  if v_level3 is null then
    return;
  end if;

  v_bonus := p_deposit_amount * 0.02;
  update users
  set gram_balance = gram_balance + v_bonus,
      referral_earnings = referral_earnings + v_bonus,
      referral_earnings_l3 = referral_earnings_l3 + v_bonus
  where id = v_level3;
end;
$function$;
