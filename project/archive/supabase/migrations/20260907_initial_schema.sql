begin;

create extension if not exists pgcrypto;

create table public.words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word text not null check (word = lower(btrim(word))),
  phonetic text not null default '',
  meaning text not null default '',
  phrase text,
  sentence text,
  sentence_cn text,
  source text not null default '',
  type text not null check (type in ('marked', 'added')),
  created_at timestamptz not null default timezone('utc', now()),
  constraint words_user_word_key unique (user_id, word),
  constraint words_id_user_id_key unique (id, user_id)
);

create table public.word_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_id uuid not null,
  review_stage integer not null default 0 check (review_stage between 0 and 6),
  recognition_score integer not null default 0 check (recognition_score between 0 and 5),
  spelling_score integer not null default 0 check (spelling_score between 0 and 5),
  next_review_at timestamptz not null default timezone('utc', now()),
  last_review_at timestamptz,
  last_recognition_choice text check (last_recognition_choice in ('known', 'unknown')),
  last_recognition_result text check (last_recognition_result in ('correct', 'wrong')),
  last_spelling_result text check (last_spelling_result in ('correct', 'wrong')),
  last_grade text check (last_grade in ('again', 'hard', 'good', 'easy')),
  killed_at timestamptz,
  last_restored_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint word_progress_user_word_key unique (user_id, word_id),
  constraint word_progress_word_owner_fkey
    foreign key (word_id, user_id)
    references public.words(id, user_id)
    on delete cascade
);

create index words_user_id_idx on public.words(user_id);
create index word_progress_due_idx on public.word_progress(user_id, next_review_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger word_progress_set_updated_at
before update on public.word_progress
for each row execute procedure public.set_updated_at();

alter table public.words enable row level security;
alter table public.word_progress enable row level security;

create policy "Users can read their words"
on public.words for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their words"
on public.words for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their words"
on public.words for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their words"
on public.words for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their progress"
on public.word_progress for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their progress"
on public.word_progress for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their progress"
on public.word_progress for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their progress"
on public.word_progress for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.words, public.word_progress to authenticated;

commit;
