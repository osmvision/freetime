-- Keep image bytes out of profile queries and Realtime payloads.
create table public.profile_photos (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  image text not null,
  constraint profile_photo_format check (
    case when octet_length(image) between 32 and 140000 then
      substring(decode(image, 'base64') from 1 for 24) =
        decode('89504e470d0a1a0a0000000d49484452000000a0000000a0', 'hex')
    else false end
  )
);

-- Profile cards in Meet and Rankings may be visible even without a friendship.
create function private.can_see_profile_photo(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    public.can_see_profile(target) or (
      exists (select 1 from public.profiles p where p.id = target and p.show_in_global)
      and not public.is_blocked((select auth.uid()), target)
    )
  )
$$;
revoke all on function private.can_see_profile_photo(uuid) from public, anon, authenticated;
grant execute on function private.can_see_profile_photo(uuid) to authenticated;

alter table public.profile_photos enable row level security;
revoke all on public.profile_photos from public, anon, authenticated;
grant select, insert, delete on public.profile_photos to authenticated;
grant update (image) on public.profile_photos to authenticated;

create policy "read visible profile photos" on public.profile_photos
  for select to authenticated using (private.can_see_profile_photo(user_id));
create policy "add your profile photo" on public.profile_photos
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "replace your profile photo" on public.profile_photos
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "remove your profile photo" on public.profile_photos
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Save the profile and the selected photo together. Older clients can still patch profiles.
create function public.save_profile_with_photo(
  p_display_name text, p_avatar_icon smallint, p_avatar_color smallint,
  p_bio text, p_status_text text, p_image text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  me uuid := auth.uid();
  saved public.profiles;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.profiles
    set display_name = p_display_name, avatar_icon = p_avatar_icon,
      avatar_color = p_avatar_color, bio = p_bio, status_text = p_status_text
    where id = me returning * into strict saved;

  if p_image is null then
    delete from public.profile_photos where user_id = me;
  else
    insert into public.profile_photos (user_id, image) values (me, p_image)
    on conflict (user_id) do update set image = excluded.image;
  end if;

  return to_jsonb(saved);
end
$$;
revoke all on function public.save_profile_with_photo(text, smallint, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.save_profile_with_photo(text, smallint, smallint, text, text, text) to authenticated;

-- Preserve the existing export and include the user's own photo in a portable format.
alter function public.export_my_data() set schema private;
create function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data() || jsonb_build_object('profile_photo', (
  select 'data:image/png;base64,' || p.image from public.profile_photos p where p.user_id = (select auth.uid())
));
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
