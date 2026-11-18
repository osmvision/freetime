-- The few pieces of a Supabase database the migrations rely on, so the permission tests can run
-- in PGlite (Postgres in Node) without Docker. Never applied to the real project.

create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;

create schema auth;
grant usage on schema auth to anon, authenticated;

create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now(),
  last_sign_in_at timestamptz
);

-- Same contract as Supabase's auth.uid(): the "sub" claim of the request's JWT.
create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;
