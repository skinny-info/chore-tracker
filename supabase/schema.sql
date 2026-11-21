-- ============================================================================
-- Kids Chores & Bank — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run (idempotent).
-- ============================================================================

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.children (
  id    text primary key,
  name  text not null,
  emoji text not null default '🙂',
  sort  int  not null default 0
);

-- Single settings row (id = 1)
create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  ecb_rate         numeric(6,3) not null default 2.000,   -- % p.a., refreshed by the bank app
  ecb_rate_updated timestamptz,
  allowance_amount numeric(6,2) not null default 5.00,    -- € per qualifying week
  start_week       date not null                          -- first Monday that counts for allowance
);

create table if not exists public.chore_log (
  id       uuid primary key default gen_random_uuid(),
  child_id text not null references public.children(id) on delete cascade,
  chore    text not null check (chore in ('bed','room','dishes','other')),
  note     text,
  done_at  timestamptz not null default now()
);
create index if not exists chore_log_child_done_idx on public.chore_log (child_id, done_at);

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  child_id        text not null references public.children(id) on delete cascade,
  type            text not null check (type in ('deposit','spend','donate','interest','allowance','opening')),
  amount          numeric(10,2) not null,                 -- signed: + credit, − debit
  note            text,
  occurred_at     timestamptz not null default now(),
  interest_period date                                    -- quarter start, interest rows only
);
create index if not exists transactions_child_time_idx on public.transactions (child_id, occurred_at);
-- one interest payment per child per quarter
create unique index if not exists transactions_interest_once
  on public.transactions (child_id, interest_period) where type = 'interest';

-- One row per approved weekly allowance. Deleting the linked transaction
-- (e.g. a mistake) deletes this row too, so the week becomes pending again.
create table if not exists public.allowances (
  child_id       text not null references public.children(id) on delete cascade,
  week_start     date not null,                           -- the Monday of the week earned
  amount         numeric(6,2) not null,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  approved_at    timestamptz not null default now(),
  primary key (child_id, week_start)
);

-- ── Seed data ───────────────────────────────────────────────────────────────

insert into public.children (id, name, emoji, sort) values
  ('thompson', 'Thompson', '🦊', 1),
  ('lillian',  'Lillian',  '🦋', 2)
on conflict (id) do nothing;

insert into public.settings (id, start_week)
values (1, date_trunc('week', (now() at time zone 'Europe/Paris'))::date)
on conflict (id) do nothing;

-- ── Row level security: only signed-in users (the family login) get access ──

do $$
declare t text;
begin
  foreach t in array array['children','settings','chore_log','transactions','allowances'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "family access" on public.%I', t);
    execute format(
      'create policy "family access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Functions ───────────────────────────────────────────────────────────────

-- Approve one week's allowance: creates the transaction and the allowance row atomically.
create or replace function public.approve_allowance(p_child text, p_week date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  amt numeric;
  tx  uuid;
begin
  if exists (select 1 from allowances where child_id = p_child and week_start = p_week) then
    return;
  end if;
  select allowance_amount into amt from settings where id = 1;
  insert into transactions (child_id, type, amount, note)
    values (p_child, 'allowance', amt,
            format('Weekly allowance (%s – %s)', to_char(p_week, 'FMDD Mon'), to_char(p_week + 6, 'FMDD Mon')))
    returning id into tx;
  insert into allowances (child_id, week_start, amount, transaction_id)
    values (p_child, p_week, amt, tx);
end $$;

-- Pay interest for the quarter that STARTS on q_start (idempotent).
-- Interest = average daily balance over the quarter × (annual rate / 4).
create or replace function public.pay_interest_for_quarter(q_start date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  q_end    date := (q_start + interval '3 months')::date;
  rate     numeric;
  c        record;
  avg_bal  numeric;
  interest numeric;
  paid     int := 0;
begin
  select ecb_rate into rate from settings where id = 1;
  for c in select id from children loop
    if exists (select 1 from transactions
               where child_id = c.id and type = 'interest' and interest_period = q_start) then
      continue;
    end if;

    select coalesce(avg(day_bal), 0) into avg_bal
    from (
      select coalesce((
               select sum(t.amount) from transactions t
               where t.child_id = c.id
                 and (t.occurred_at at time zone 'Europe/Paris')::date <= d::date
             ), 0) as day_bal
      from generate_series(q_start::timestamp, (q_end - 1)::timestamp, interval '1 day') as d
    ) s;

    interest := round(avg_bal * rate / 4 / 100, 2);
    if interest > 0 then
      insert into transactions (child_id, type, amount, note, occurred_at, interest_period)
      values (c.id, 'interest', interest,
              format('Interest Q%s %s @ %s%% on avg €%s',
                     extract(quarter from q_start)::int, extract(year from q_start)::int,
                     rate, round(avg_bal, 2)),
              (q_end::timestamp at time zone 'Europe/Paris'),
              q_start);
      paid := paid + 1;
    end if;
  end loop;
  return paid;
end $$;

-- Pay every completed quarter that hasn't been paid yet. Called by the monthly
-- cron job below AND by the bank app when it opens (so nothing is ever missed).
create or replace function public.catch_up_interest()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  first_day date;
  q         date;
  cur_q     date := date_trunc('quarter', (now() at time zone 'Europe/Paris'))::date;
  total     int := 0;
begin
  select min((occurred_at at time zone 'Europe/Paris')::date) into first_day from transactions;
  if first_day is null then
    return 0;
  end if;
  q := date_trunc('quarter', first_day)::date;
  while q < cur_q loop
    total := total + pay_interest_for_quarter(q);
    q := (q + interval '3 months')::date;
  end loop;
  return total;
end $$;

revoke all on function public.approve_allowance(text, date)       from public, anon;
revoke all on function public.pay_interest_for_quarter(date)      from public, anon;
revoke all on function public.catch_up_interest()                 from public, anon;
grant execute on function public.approve_allowance(text, date)    to authenticated;
grant execute on function public.catch_up_interest()              to authenticated;

-- ── Realtime (live sync between iPads) ──────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['children','settings','chore_log','transactions','allowances'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ── Scheduled interest: 00:15 UTC on Jan 1, Apr 1, Jul 1, Oct 1 ─────────────
-- If this errors, enable pg_cron under Database → Extensions, then re-run this block.

create extension if not exists pg_cron;
select cron.schedule('quarterly-interest', '15 0 1 1,4,7,10 *', $$select public.catch_up_interest()$$);
