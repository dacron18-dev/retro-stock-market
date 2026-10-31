-- RETRO MARKET: one-shot setup. Paste ALL of this into Supabase SQL Editor and press Run (once, on a fresh project).

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

-- Peer trading + broker stock limits.
-- Run AFTER supabase.sql (if you already ran supabase.sql earlier, just run this one).
-- Supabase: SQL Editor -> New query -> paste -> Run

-- 1) New columns
alter table stocks add column if not exists broker_qty int not null default 100;   -- starting shares each broker side holds per stock
alter table trades add column if not exists kind text not null default 'BROKER' check (kind in ('BROKER','PEER'));
alter table trades add column if not exists counterparty text;                      -- seller in a PEER trade (pno = buyer)
alter table trades drop constraint if exists peer_shape;
alter table trades add constraint peer_shape check (
  (kind = 'BROKER' and counterparty is null) or
  (kind = 'PEER' and counterparty is not null and counterparty <> pno)
);
create index if not exists trades_cp_idx on trades (counterparty);

-- 2) Account helpers
create or replace function acct_cash(p text) returns numeric language sql as $$
  select s.start_cash + coalesce((
    select sum(case
      when t.kind = 'BROKER' and t.side = 'SELL' then  t.price * t.qty
      when t.kind = 'BROKER' and t.side = 'BUY'  then -t.price * t.qty
      when t.kind = 'PEER' and t.counterparty = p then  t.price * t.qty
      when t.kind = 'PEER' and t.pno = p          then -t.price * t.qty
      else 0 end)
    from trades t where t.pno = p or t.counterparty = p), 0)
  from settings s where s.id = 1
$$;

create or replace function acct_held(p text, sid text) returns numeric language sql as $$
  select coalesce(sum(case
      when t.kind = 'BROKER' and t.side = 'BUY'  then  t.qty
      when t.kind = 'BROKER' and t.side = 'SELL' then -t.qty
      when t.kind = 'PEER' and t.counterparty = p then -t.qty
      when t.kind = 'PEER' and t.pno = p          then  t.qty
      else 0 end), 0)
  from trades t where t.stock_id = sid and (t.pno = p or t.counterparty = p)
$$;

create or replace function broker_left(sid text) returns numeric language sql as $$
  select (select broker_qty from stocks where id = sid)
       + coalesce((select sum(case when side = 'SELL' then qty else -qty end)
                   from trades where kind = 'BROKER' and stock_id = sid), 0)
$$;

-- 3) Rules enforced inside the database (cannot be bypassed, safe with many brokers)
create or replace function check_trade() returns trigger language plpgsql as $$
declare amt numeric := NEW.price * NEW.qty;
begin
  perform pg_advisory_xact_lock(hashtext('stk:' || NEW.stock_id));

  if NEW.kind = 'PEER' then
    if NEW.pno < NEW.counterparty then
      perform pg_advisory_xact_lock(hashtext('acct:' || NEW.pno));
      perform pg_advisory_xact_lock(hashtext('acct:' || NEW.counterparty));
    else
      perform pg_advisory_xact_lock(hashtext('acct:' || NEW.counterparty));
      perform pg_advisory_xact_lock(hashtext('acct:' || NEW.pno));
    end if;
    if exists (select 1 from verified where pno in (NEW.pno, NEW.counterparty)) then
      raise exception 'A participant in this trade is already verified and locked';
    end if;
    if acct_cash(NEW.pno) < amt then
      raise exception 'Buyer #% does not have enough cash', NEW.pno;
    end if;
    if acct_held(NEW.counterparty, NEW.stock_id) < NEW.qty then
      raise exception 'Seller #% does not hold enough shares', NEW.counterparty;
    end if;
  else
    perform pg_advisory_xact_lock(hashtext('acct:' || NEW.pno));
    if exists (select 1 from verified where pno = NEW.pno) then
      raise exception 'Participant #% is verified and locked', NEW.pno;
    end if;
    if NEW.side = 'BUY' then
      if acct_cash(NEW.pno) < amt then
        raise exception 'Participant #% does not have enough cash', NEW.pno;
      end if;
      if broker_left(NEW.stock_id) < NEW.qty then
        raise exception 'Broker is out of stock. Trade participant to participant instead';
      end if;
    else
      if acct_held(NEW.pno, NEW.stock_id) < NEW.qty then
        raise exception 'Participant #% does not hold enough shares', NEW.pno;
      end if;
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trades_check on trades;
create trigger trades_check before insert on trades
  for each row execute function check_trade();

-- Verified participants' trades cannot be deleted
create or replace function block_locked_delete() returns trigger language plpgsql as $$
begin
  if exists (select 1 from verified where pno in (OLD.pno, coalesce(OLD.counterparty, OLD.pno))) then
    raise exception 'This trade belongs to a verified participant. Unlock them first';
  end if;
  return OLD;
end $$;

drop trigger if exists trades_lock_delete on trades;
create trigger trades_lock_delete before delete on trades
  for each row execute function block_locked_delete();


-- Stock names
update stocks set name = 'KOTAKBANK'  where id = 's1';
update stocks set name = 'WIPRO'      where id = 's2';
update stocks set name = 'ZOMATO'     where id = 's3';
update stocks set name = 'JIO'        where id = 's4';
update stocks set name = 'GROWW'      where id = 's5';
update stocks set name = 'ADANIPOWER' where id = 's6';
update stocks set name = 'TMPV'       where id = 's7';
update stocks set name = 'TCS'        where id = 's8';
update stocks set name = 'L&T'        where id = 's9';
update stocks set name = 'NSE'        where id = 's10';
