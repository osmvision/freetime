-- "Signaler un problème" / "Report a problem": anyone, signed in or not, can send a problem
-- report from the app. It goes through the Edge Function `support`, which writes it with the
-- service role after the rate limits below. Only freetime's admins can read the tickets and change
-- their status; nobody else, not even the person who sent one, can list them.
--
-- Admins are accounts listed in private.admins. Add one in the SQL editor:
--   insert into private.admins (user_id) select id from auth.users where email = '…';

create schema if not exists private;

create table if not exists private.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table private.admins enable row level security;

-- Whether the signed-in account is an admin (the app shows the Tickets tab only then).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.admins a where a.user_id = auth.uid());
$$;

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The account that sent it, when signed in. Deleting the account keeps the ticket, unlinked.
  user_id uuid references auth.users (id) on delete set null,
  category text not null check (category in ('bug', 'account', 'idea', 'other')),
  message text not null check (char_length(message) between 10 and 4000),
  -- How to answer, if the person left it (optional).
  contact text check (contact is null or char_length(contact) between 3 and 200),
  app_version text check (app_version is null or char_length(app_version) <= 40),
  platform text check (platform is null or platform in ('desktop', 'web')),
  lang text check (lang is null or char_length(lang) <= 10),
  screen text check (screen is null or char_length(screen) <= 40),
  -- A keyed hash of the sender's network address, only for the rate limit; cleared after a day.
  ip_hash text check (ip_hash is null or char_length(ip_hash) = 64),
  status text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 2000)
);

create index if not exists support_tickets_recent on public.support_tickets (created_at desc);
create index if not exists support_tickets_ip on public.support_tickets (ip_hash, created_at) where ip_hash is not null;

alter table public.support_tickets enable row level security;

create policy "admins read tickets" on public.support_tickets
  for select to authenticated using (public.is_admin());

create policy "admins handle tickets" on public.support_tickets
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function private.touch_support_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger support_tickets_touch
  before update on public.support_tickets
  for each row execute function private.touch_support_ticket();

-- The Edge Function's write. Limits: 10 an hour from one network address, 5 an hour from one
-- account, 300 a day in all. Returns the new ticket's id.
create or replace function public.support_submit(
  p_user uuid,
  p_ip_hash text,
  p_category text,
  p_message text,
  p_contact text,
  p_app_version text,
  p_platform text,
  p_lang text,
  p_screen text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  if p_ip_hash is not null and (
    select count(*) from public.support_tickets t
    where t.ip_hash = p_ip_hash and t.created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'too many tickets from this connection, try again in an hour' using errcode = '54000';
  end if;
  if p_user is not null and (
    select count(*) from public.support_tickets t
    where t.user_id = p_user and t.created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'too many tickets from this account, try again in an hour' using errcode = '54000';
  end if;
  if (select count(*) from public.support_tickets t where t.created_at > now() - interval '1 day') >= 300 then
    raise exception 'too many tickets today, try again tomorrow' using errcode = '54000';
  end if;

  insert into public.support_tickets (user_id, ip_hash, category, message, contact, app_version, platform, lang, screen)
  values (p_user, p_ip_hash, p_category, p_message, nullif(btrim(p_contact), ''), p_app_version, p_platform, p_lang, p_screen)
  returning id into new_id;

  -- The address hash is only needed for an hour or so.
  update public.support_tickets set ip_hash = null
  where ip_hash is not null and created_at < now() - interval '1 day';
  -- Closed tickets are kept a year, then deleted (see docs/privacy.md).
  delete from public.support_tickets
  where status = 'closed' and updated_at < now() - interval '1 year';
  return new_id;
end;
$$;

-- ---------------------------------------------------------------- grants

revoke all on public.support_tickets from public, anon, authenticated;
grant select on public.support_tickets to authenticated;
grant update (status, admin_note) on public.support_tickets to authenticated;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.support_submit(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.support_submit(uuid, text, text, text, text, text, text, text, text) to service_role;
