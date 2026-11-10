-- Where the user placed each node on a map. One row per (map scope, node).
-- scope: a project uuid, 'all' or 'none' (the map view). node_key: 'i:<inspiration id>', 't:<tag>', 'p:<project id>'.
create table public.map_positions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  scope text not null check (char_length(scope) between 1 and 64),
  node_key text not null check (char_length(node_key) between 3 and 200),
  x real not null,
  y real not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, node_key)
);

alter table public.map_positions enable row level security;

create policy "own map positions" on public.map_positions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
