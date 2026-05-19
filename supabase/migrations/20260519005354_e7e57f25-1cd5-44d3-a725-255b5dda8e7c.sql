-- Scope helpers: wiki-bound views of memory_graph, knowledge_conflicts, consolidation_queue.
-- All run with SECURITY INVOKER so existing RLS via auth.uid() still applies.

create or replace function public.memory_graph_for_wiki(target_wiki_id uuid)
returns setof public.memory_graph
language sql
stable
security invoker
set search_path = public
as $$
  with scope as (
    select id from public.entries_for_wiki(target_wiki_id)
  )
  select g.*
  from public.memory_graph g
  where g.user_id = auth.uid()
    and g.source_entry_id in (select id from scope)
    and g.target_entry_id in (select id from scope);
$$;

create or replace function public.conflicts_for_wiki(target_wiki_id uuid)
returns setof public.knowledge_conflicts
language sql
stable
security invoker
set search_path = public
as $$
  with scope as (
    select id from public.entries_for_wiki(target_wiki_id)
  )
  select c.*
  from public.knowledge_conflicts c
  where c.user_id = auth.uid()
    and (c.entry_a in (select id from scope) or c.entry_b in (select id from scope));
$$;

create or replace function public.consolidation_queue_for_wiki(target_wiki_id uuid)
returns setof public.consolidation_queue
language sql
stable
security invoker
set search_path = public
as $$
  with scope as (
    select id from public.entries_for_wiki(target_wiki_id)
  )
  select q.*
  from public.consolidation_queue q
  where q.user_id = auth.uid()
    and (
      q.entry_id is null
      or q.entry_id in (select id from scope)
    );
$$;

-- Add wiki_id to episodic_log so we can scope episodes per wiki.
alter table public.episodic_log
  add column if not exists wiki_id uuid;

create index if not exists episodic_log_user_wiki_created_idx
  on public.episodic_log (user_id, wiki_id, created_at desc);