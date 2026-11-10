-- Distinct tags of the calling user, most used first. SECURITY INVOKER: RLS limits it to own rows.
create or replace function public.user_tags()
returns table(tag text, uses bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select t as tag, count(*) as uses
  from public.inspirations i, unnest(i.tags) as t
  group by t
  order by count(*) desc, t
$$;

revoke execute on function public.user_tags() from public, anon;
grant execute on function public.user_tags() to authenticated;
