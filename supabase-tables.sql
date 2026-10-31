-- Per-table broker stock (9 broker tables). Run ONCE, on top of what you already ran.
-- Supabase: SQL Editor -> New query -> paste -> Run

-- 1) Settings + new table for each broker table's starting stock
alter table settings add column if not exists num_tables int not null default 9;

create table if not exists broker_stock (
  table_no int not null,
  stock_id text not null references stocks(id) on delete cascade,
  qty int not null default 0 check (qty >= 0),
  primary key (table_no, stock_id)
);

alter table trades add column if not exists table_no int;   -- which broker table executed the trade

alter table broker_stock enable row level security;
drop policy if exists "brokers only" on broker_stock;
create policy "brokers only" on broker_stock for all to authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table broker_stock;
exception when duplicate_object then null; end $$;

-- 2) Starting stock: split each stock's old broker total evenly across the 9 tables
insert into broker_stock (table_no, stock_id, qty)
select g, s.id, greatest(s.broker_qty / 9, 0)
from generate_series(1, 9) g cross join stocks s
on conflict do nothing;

-- 3) Stock left at ONE table for ONE stock
create or replace function broker_left(tno int, sid text) returns numeric language sql as $$
  select coalesce((select qty from broker_stock where table_no = tno and stock_id = sid), 0)
       + coalesce((select sum(case when side = 'SELL' then qty else -qty end)
                   from trades where kind = 'BROKER' and table_no = tno and stock_id = sid), 0)
$$;

-- 4) Trade rules, now table-aware
create or replace function check_trade() returns trigger language plpgsql as $$
declare amt numeric := NEW.price * NEW.qty;
        ntab int;
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
    select num_tables into ntab from settings where id = 1;
    if NEW.table_no is null or NEW.table_no < 1 or NEW.table_no > ntab then
      raise exception 'Choose your broker table (1 to %) before trading', ntab;
    end if;
    perform pg_advisory_xact_lock(hashtext('acct:' || NEW.pno));
    if exists (select 1 from verified where pno = NEW.pno) then
      raise exception 'Participant #% is verified and locked', NEW.pno;
    end if;
    if NEW.side = 'BUY' then
      if acct_cash(NEW.pno) < amt then
        raise exception 'Participant #% does not have enough cash', NEW.pno;
      end if;
      if broker_left(NEW.table_no, NEW.stock_id) < NEW.qty then
        raise exception 'Table % is out of stock. Send the participant to another table', NEW.table_no;
      end if;
    else
      if acct_held(NEW.pno, NEW.stock_id) < NEW.qty then
        raise exception 'Participant #% does not hold enough shares', NEW.pno;
      end if;
    end if;
  end if;
  return NEW;
end $$;
-- (the trigger trades_check from the previous update keeps pointing at check_trade)
