-- The free assistant (Edge Function `assistant`): signed-in users chat with Mistral on freetime's
-- key, which stays a function secret (MISTRAL_API_KEY). Each account gets a number of messages a
-- day (ASSISTANT_DAILY_MESSAGES, 50 by default), counted here per UTC day.
--
-- The table lives in a schema the Data API doesn't expose, and only the Edge Function (service
-- role) can call the functions below: users can't read or reset their own count.

create schema if not exists private;

create table if not exists private.assistant_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  messages integer not null default 0 check (messages >= 0),
  primary key (user_id, day)
);

alter table private.assistant_usage enable row level security;

-- Takes one message from `who`'s allowance for today. Returns how many are left after it,
-- or -1 when `daily_cap` were already used today.
create or replace function public.assistant_take(who uuid, daily_cap integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  used integer;
begin
  insert into private.assistant_usage (user_id, day, messages) values (who, today, 1)
  on conflict (user_id, day) do update set messages = private.assistant_usage.messages + 1
  where private.assistant_usage.messages < daily_cap
  returning messages into used;
  -- Older days are of no use.
  delete from private.assistant_usage where user_id = who and day < today;
  if used is null then
    return -1;
  end if;
  return greatest(daily_cap - used, 0);
end;
$$;

-- Gives the message back when the answer failed on Mistral's side.
create or replace function public.assistant_refund(who uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.assistant_usage set messages = greatest(messages - 1, 0)
  where user_id = who and day = (now() at time zone 'utc')::date;
$$;

-- Messages `who` used today.
create or replace function public.assistant_used(who uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.messages from private.assistant_usage u where u.user_id = who and u.day = (now() at time zone 'utc')::date),
    0
  );
$$;

revoke all on function public.assistant_take(uuid, integer) from public, anon, authenticated;
revoke all on function public.assistant_refund(uuid) from public, anon, authenticated;
revoke all on function public.assistant_used(uuid) from public, anon, authenticated;
grant execute on function public.assistant_take(uuid, integer) to service_role;
grant execute on function public.assistant_refund(uuid) to service_role;
grant execute on function public.assistant_used(uuid) to service_role;
