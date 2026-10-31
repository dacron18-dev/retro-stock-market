-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

create table settings (
  id int primary key default 1 check (id = 1),
  start_cash numeric not null default 100000
);
insert into settings (id, start_cash) values (1, 100000);

create table stocks (
  id text primary key,
  name text not null,
  close numeric,
  sort int not null
);
insert into stocks (id, name, sort) values
  ('s1','Bombay Jute',1), ('s2','Dalal Textiles',2), ('s3','Sensex Steel',3),
  ('s4','Nirmal Tea',4), ('s5','Rupee Rails',5), ('s6','Gateway Shipping',6),
  ('s7','Lakshmi Spices',7), ('s8','Marine Drive Motors',8), ('s9','Phoenix Cement',9),
  ('s10','Cerebro Cotton',10);

create table trades (
  id uuid primary key default gen_random_uuid(),
  pno text not null,
  stock_id text not null references stocks(id),
  side text not null check (side in ('BUY','SELL')),
  price numeric not null check (price > 0),
  qty int not null check (qty > 0),
  created_at timestamptz not null default now()
);
create index trades_pno_idx on trades (pno);

create table verified (pno text primary key);

-- Only logged-in brokers can read/write
alter table settings enable row level security;
alter table stocks   enable row level security;
alter table trades   enable row level security;
alter table verified enable row level security;

create policy "brokers only" on settings for all to authenticated using (true) with check (true);
create policy "brokers only" on stocks   for all to authenticated using (true) with check (true);
create policy "brokers only" on trades   for all to authenticated using (true) with check (true);
create policy "brokers only" on verified for all to authenticated using (true) with check (true);

-- Live updates across devices
alter publication supabase_realtime add table settings, stocks, trades, verified;
