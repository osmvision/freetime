alter table public.support_tickets
  add column photo_count smallint not null default 0 check (photo_count between 0 and 3);

-- Keep the image bytes out of ticket lists. They expire when the ticket is deleted.
create table public.support_ticket_photos (
  ticket_id bigint not null references public.support_tickets (id) on delete cascade,
  position smallint not null check (position between 1 and 3),
  image text not null check (octet_length(image) between 32 and 400000 and left(image, 4) = '/9j/'),
  primary key (ticket_id, position)
);

alter table public.support_ticket_photos enable row level security;
revoke all on public.support_ticket_photos from public, anon, authenticated;
grant select on public.support_ticket_photos to authenticated;
create policy "admins read ticket photos" on public.support_ticket_photos
  for select to authenticated using ((select public.is_admin()));

-- Reuse the current support checks and limits. A ticket and its photos are saved together
-- even when the sender is signed out. Only the Edge Function's service role calls this.
create function private.support_submit_with_photos(
  p_user uuid, p_ip_hash text, p_category text, p_message text, p_contact text,
  p_app_version text, p_platform text, p_lang text, p_screen text, p_photos text[]
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  new_id bigint;
begin
  if p_photos is null or cardinality(p_photos) not between 1 and 3 or array_ndims(p_photos) <> 1 then
    raise exception 'attach one to three photos' using errcode = '22023';
  end if;
  new_id := public.support_submit(p_user, p_ip_hash, p_category, p_message, p_contact,
    p_app_version, p_platform, p_lang, p_screen);

  insert into public.support_ticket_photos (ticket_id, position, image)
  select new_id, p.position::smallint, p.image
  from unnest(p_photos) with ordinality as p(image, position);

  update public.support_tickets set photo_count = cardinality(p_photos) where id = new_id;
  return new_id;
end
$$;

revoke all on function private.support_submit_with_photos(uuid, text, text, text, text, text, text, text, text, text[]) from public, anon, authenticated, service_role;
grant execute on function private.support_submit_with_photos(uuid, text, text, text, text, text, text, text, text, text[]) to service_role;

create function public.support_submit_with_photos(
  p_user uuid, p_ip_hash text, p_category text, p_message text, p_contact text,
  p_app_version text, p_platform text, p_lang text, p_screen text, p_photos text[]
) returns bigint
language sql security invoker set search_path = ''
return private.support_submit_with_photos(p_user, p_ip_hash, p_category, p_message, p_contact,
  p_app_version, p_platform, p_lang, p_screen, p_photos);

revoke all on function public.support_submit_with_photos(uuid, text, text, text, text, text, text, text, text, text[]) from public, anon, authenticated, service_role;
grant execute on function public.support_submit_with_photos(uuid, text, text, text, text, text, text, text, text, text[]) to service_role;
