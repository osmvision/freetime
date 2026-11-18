-- Sharing your Steam game list with friends, so freetime can pick games you can play together
-- (step 2, part 2). Opt-in: nothing is stored until you switch it on, and switching it off
-- deletes it. Only Steam app ids and your taste per kind of idea, readable by your friends only.

create table public.game_libraries (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  app_ids integer[] not null default '{}' check (cardinality(app_ids) <= 10000 and 0 < all (app_ids)),
  -- Taste per kind of idea, -100..100, in the app's category order.
  taste smallint[] not null default '{0,0,0,0,0,0,0,0}'
    check (cardinality(taste) = 8 and -100 <= all (taste) and 100 >= all (taste)),
  updated_at timestamptz not null default now()
);

alter table public.game_libraries enable row level security;

-- Yours, and those of accepted friends who haven't blocked you (can_invite checks exactly that).
create policy "read your own and your friends' game lists" on public.game_libraries
  for select to authenticated
  using (user_id = (select auth.uid()) or public.can_invite(user_id));

-- Writing only through share_library() and stop_sharing_library(), which act on your own row.
create function public.share_library(app_ids integer[], taste smallint[]) returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  stamp timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  insert into public.game_libraries (user_id, app_ids, taste, updated_at)
  values (auth.uid(), coalesce(app_ids, '{}'), coalesce(taste, '{0,0,0,0,0,0,0,0}'), stamp)
  on conflict (user_id) do update set app_ids = excluded.app_ids, taste = excluded.taste, updated_at = stamp;
  return stamp;
end
$$;

create function public.stop_sharing_library() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.game_libraries where user_id = auth.uid();
end
$$;

-- The export includes the shared list.
create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = auth.uid()),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = auth.uid()),
    'shared_game_list', (select jsonb_build_object('app_ids', g.app_ids, 'taste', g.taste, 'updated_at', g.updated_at)
                         from public.game_libraries g where g.user_id = auth.uid()),
    'friendships', coalesce((select jsonb_agg(jsonb_build_object(
                      'other', case when f.requester = auth.uid() then f.addressee else f.requester end,
                      'you_asked', f.requester = auth.uid(), 'status', f.status,
                      'created_at', f.created_at, 'accepted_at', f.accepted_at))
                    from public.friendships f where auth.uid() in (f.requester, f.addressee)), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('blocked', b.blocked, 'created_at', b.created_at))
               from public.blocks b where b.blocker = auth.uid()), '[]'::jsonb),
    'messages_you_sent', coalesce((select jsonb_agg(jsonb_build_object('conversation', m.conversation_id, 'body', m.body, 'created_at', m.created_at) order by m.id)
                          from public.messages m where m.sender = auth.uid()), '[]'::jsonb),
    'invites_you_sent', coalesce((select jsonb_agg(jsonb_build_object('to', i.to_user, 'title', i.title, 'starts_at', i.starts_at, 'note', i.note, 'status', i.status) order by i.id)
                         from public.invites i where i.from_user = auth.uid()), '[]'::jsonb),
    'reports_you_made', coalesce((select jsonb_agg(jsonb_build_object('target', r.target, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at, 'status', r.status))
                         from public.reports r where r.reporter = auth.uid()), '[]'::jsonb)
  )
$$;

revoke all on public.game_libraries from anon, authenticated;
grant select on public.game_libraries to authenticated;

revoke all on function public.share_library(integer[], smallint[]), public.stop_sharing_library() from public, anon, authenticated;
grant execute on function public.share_library(integer[], smallint[]), public.stop_sharing_library() to authenticated;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
