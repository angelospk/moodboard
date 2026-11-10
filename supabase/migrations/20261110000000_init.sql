-- Moodboard core schema: projects, inspirations (image + note + tags + level + marked regions).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index projects_user_name_idx on public.projects (user_id, lower(name));

-- level = scale of the inspiration (what the user means by "επίπεδο έμπνευσης").
create type public.inspiration_level as enum ('urban', 'building', 'interior', 'detail', 'material');

create table public.inspirations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  image_path text not null,           -- object path in storage bucket 'inspirations': <user_id>/<file>
  source_url text,
  source_title text,
  note text not null default '',
  tags text[] not null default '{}',
  level public.inspiration_level,
  -- marked details: [{ "x":0..1, "y":0..1, "w":0..1, "h":0..1, "note":"..." }], normalized to image size
  regions jsonb not null default '[]'::jsonb check (jsonb_typeof(regions) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint image_path_owned check (split_part(image_path, '/', 1) = user_id::text)
);
create index inspirations_user_created_idx on public.inspirations (user_id, created_at desc);
create index inspirations_project_idx on public.inspirations (project_id);
create index inspirations_tags_idx on public.inspirations using gin (tags);

-- A project_id must belong to the same user.
create function public.check_inspiration_project() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.project_id is not null and not exists (
    select 1 from public.projects p where p.id = new.project_id and p.user_id = new.user_id
  ) then
    raise exception 'project % does not belong to user', new.project_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger inspirations_check_project before insert or update on public.inspirations
  for each row execute function public.check_inspiration_project();

alter table public.projects enable row level security;
alter table public.inspirations enable row level security;

create policy "own projects" on public.projects for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own inspirations" on public.inspirations for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Private image bucket; each user reads/writes only under their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inspirations', 'inspirations', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

create policy "own images read" on storage.objects for select to authenticated
  using (bucket_id = 'inspirations' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own images insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'inspirations' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own images delete" on storage.objects for delete to authenticated
  using (bucket_id = 'inspirations' and (storage.foldername(name))[1] = (select auth.uid())::text);
