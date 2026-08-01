-- New quest type: "invite N friends" (level-1 referrals only), separate
-- from the existing channel-subscription quests. channel_url is required
-- for channel quests but meaningless for referral quests, so it's relaxed
-- to nullable. Eligibility is verified server-side from the referred_by
-- chain (not trusted from the client) via a dedicated RPC, mirroring how
-- verify-subscription independently checks channel membership before
-- complete_task is called for channel quests.
--
-- Reward is credited to gram_balance only, same as complete_task -- it does
-- NOT touch withdrawable_balance, so per the wagering-requirement fix it
-- only becomes withdrawable once played through a dungeon round-trip.

alter table public.tasks
  alter column channel_url drop not null;

alter table public.tasks
  add column if not exists task_type text not null default 'channel';

alter table public.tasks
  add column if not exists required_referrals integer;

alter table public.tasks
  drop constraint if exists tasks_task_type_check;

alter table public.tasks
  add constraint tasks_task_type_check check (task_type in ('channel', 'referral_count'));

insert into public.tasks (title, reward_gram, task_type, required_referrals, is_active)
values
  ('Пригласить 3 друзей', 0.1, 'referral_count', 3, true),
  ('Пригласить 10 друзей', 0.15, 'referral_count', 10, true),
  ('Пригласить 25 друзей', 0.25, 'referral_count', 25, true);

create or replace function public.complete_referral_task(p_task_id integer)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id bigint := (auth.jwt() ->> 'telegram_id')::bigint;
  v_reward numeric;
  v_task_type text;
  v_required integer;
  v_referral_count integer;
  v_already_completed boolean;
begin
  if v_user_id is null then
    raise exception 'Unauthorized';
  end if;

  select exists(
    select 1 from user_tasks
    where user_id = v_user_id and task_id = p_task_id
  ) into v_already_completed;

  if v_already_completed then
    raise exception 'Task already completed';
  end if;

  select reward_gram, task_type, required_referrals
  into v_reward, v_task_type, v_required
  from tasks
  where id = p_task_id and is_active = true;

  if v_reward is null then
    raise exception 'Task not found or inactive';
  end if;

  if v_task_type != 'referral_count' then
    raise exception 'wrong_task_type';
  end if;

  select count(*) into v_referral_count
  from users
  where referred_by = v_user_id;

  if v_referral_count < v_required then
    raise exception 'not_enough_referrals';
  end if;

  insert into user_tasks (user_id, task_id)
  values (v_user_id, p_task_id);

  update users
  set gram_balance = gram_balance + v_reward
  where id = v_user_id;

  return v_reward;
end;
$function$;
