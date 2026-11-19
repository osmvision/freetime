-- Streaks together (phase C of docs/engagement-plan.md): the weeks you and each friend did
-- something together, meaning an invite that was accepted and whose time has come. The app
-- turns these weeks into a streak (with one wildcard a month) on your PC, in core/src/streaks.rs.

create function public.together_weeks() returns table (friend uuid, week date)
language sql stable security definer set search_path = ''
as $$
  select distinct
    case when i.from_user = auth.uid() then i.to_user else i.from_user end,
    date_trunc('week', i.starts_at at time zone 'utc')::date
  from public.invites i
  where auth.uid() is not null
    and auth.uid() in (i.from_user, i.to_user)
    and i.status = 'accepted'
    and i.starts_at <= now()
    and i.starts_at > now() - interval '400 days'
    and public.are_friends(i.from_user, i.to_user)
    and not public.is_blocked(i.from_user, i.to_user)
$$;

-- Weeks are looked up by person and time.
create index if not exists invites_accepted_from on public.invites (from_user, starts_at) where status = 'accepted';
create index if not exists invites_accepted_to on public.invites (to_user, starts_at) where status = 'accepted';

revoke all on function public.together_weeks() from public, anon, authenticated;
grant execute on function public.together_weeks() to authenticated;
