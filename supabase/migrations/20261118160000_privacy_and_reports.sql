-- Your data, your call (GDPR), and reports (step 1 of docs/strategy, phase 2-3 of the plan).
--
-- export_my_data(): everything stored about you, as JSON, for "Export my data".
-- delete_my_account(): deletes your login; your profile, friendships, blocks, conversations
--   memberships and the messages you sent go with it (foreign keys cascade).
-- reports: report a person you are connected to, or messages from your own conversations.
--   Only the freetime team reads them (dashboard, service role); reporters see their own.

-- Fail the migration (and change nothing) if this database can't delete logins: better than
-- shipping a "Delete my account" button that silently does nothing.
do $$
begin
  if not has_table_privilege('auth.users', 'DELETE') then
    raise exception 'this role cannot delete from auth.users; account deletion would not work';
  end if;
end
$$;

-- ---------------------------------------------------------------- reports

create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  target uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'impersonation', 'other')),
  details text not null default '' check (char_length(details) <= 500 and details !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  -- Messages from the reported person, as evidence (must be in your own conversations).
  message_ids bigint[] not null default '{}' check (cardinality(message_ids) <= 20),
  status text not null default 'open' check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  check (reporter <> target)
);
create index reports_open on public.reports (status, created_at);

-- You can report someone you have a link with (friend, request, or a shared conversation),
-- and only attach their messages from conversations you're in.
create function public.check_report() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not (
    exists (select 1 from public.friendships f
            where (f.requester = new.reporter and f.addressee = new.target) or (f.requester = new.target and f.addressee = new.reporter))
    or exists (select 1 from public.conversation_members a join public.conversation_members b using (conversation_id)
               where a.user_id = new.reporter and b.user_id = new.target)
  ) then
    raise exception 'you can only report people you are connected with' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(new.message_ids) as mid
    where not exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = new.reporter
      where m.id = mid and m.sender = new.target
    )
  ) then
    raise exception 'those messages can''t be attached' using errcode = '42501';
  end if;
  if (select count(*) from public.reports where reporter = new.reporter and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many reports in an hour' using errcode = '54000';
  end if;
  return new;
end
$$;

create trigger reports_check before insert on public.reports
  for each row execute function public.check_report();

alter table public.reports enable row level security;

create policy "file a report as yourself" on public.reports
  for insert to authenticated with check (reporter = (select auth.uid()));

create policy "see your own reports" on public.reports
  for select to authenticated using (reporter = (select auth.uid()));

-- ---------------------------------------------------------------- export and delete

create function public.export_my_data() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = auth.uid()),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = auth.uid()),
    'friendships', coalesce((select jsonb_agg(jsonb_build_object(
                      'other', case when f.requester = auth.uid() then f.addressee else f.requester end,
                      'you_asked', f.requester = auth.uid(), 'status', f.status,
                      'created_at', f.created_at, 'accepted_at', f.accepted_at))
                    from public.friendships f where auth.uid() in (f.requester, f.addressee)), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('blocked', b.blocked, 'created_at', b.created_at))
               from public.blocks b where b.blocker = auth.uid()), '[]'::jsonb),
    'messages_you_sent', coalesce((select jsonb_agg(jsonb_build_object('conversation', m.conversation_id, 'body', m.body, 'created_at', m.created_at) order by m.id)
                          from public.messages m where m.sender = auth.uid()), '[]'::jsonb),
    'reports_you_made', coalesce((select jsonb_agg(jsonb_build_object('target', r.target, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at, 'status', r.status))
                         from public.reports r where r.reporter = auth.uid()), '[]'::jsonb)
  )
$$;

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end
$$;

-- ---------------------------------------------------------------- grants

revoke all on public.reports from anon, authenticated;
grant select on public.reports to authenticated;
grant insert (target, reason, details, message_ids) on public.reports to authenticated;

revoke all on function public.export_my_data(), public.delete_my_account(), public.check_report() from public, anon, authenticated;
grant execute on function public.export_my_data(), public.delete_my_account() to authenticated;
