-- Which gift a surprise opens on: the roses and the ring (the default, as before) or the highway
-- code book. The app draws the gift; the server only says which one, to the account it's for.

alter table public.surprises
  add column kind text not null default 'roses' check (kind in ('roses', 'code'));

create or replace function public.my_surprise() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'title', s.title, 'message', s.message, 'kind', s.kind)
  from public.surprises s
  where s.user_id = auth.uid() and s.seen_at is null
  order by s.created_at, s.id
  limit 1
$$;

revoke all on function public.my_surprise() from public, anon, authenticated;
grant execute on function public.my_surprise() to authenticated;
