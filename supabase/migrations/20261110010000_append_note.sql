-- Atomic note append (no lost update under concurrent calls). SECURITY INVOKER: caller's RLS applies.
create function public.append_note(p_id uuid, p_text text)
returns table (id uuid, note text)
language sql security invoker set search_path = '' as $$
  update public.inspirations i
     set note = case when i.note = '' then p_text else i.note || E'\n\n' || p_text end
   where i.id = p_id
  returning i.id, i.note;
$$;
revoke execute on function public.append_note(uuid, text) from public, anon;
grant execute on function public.append_note(uuid, text) to authenticated;
