-- Remove expedition acceleration entirely: the client no longer calls
-- use_booster, so drop the RPC function from the database too.
drop function if exists public.use_booster(uuid, integer);
drop function if exists public.use_booster(bigint, integer);
