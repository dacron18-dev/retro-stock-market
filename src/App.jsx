import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

const PRICE_WARN = 0.3; // warn if typed price differs from last price by more than 30%

const fmt = (n) =>
  (n < 0 ? "-" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function lastPriceOf(stockId, trades) {
  for (let i = trades.length - 1; i >= 0; i--) if (trades[i].stockId === stockId) return trades[i].price;
  return null;
}

function refPrice(stock, trades) {
  if (stock.close !== "" && stock.close != null) return Number(stock.close);
  return lastPriceOf(stock.id, trades) ?? 0;
}

// Stock left at every broker table: starting qty + shares sold back - shares sold out
function computeLeft(brokerStock, trades) {
  const m = { ...brokerStock };
  for (const t of trades) {
    if (t.kind === "BROKER" && t.tableNo) {
      const k = t.tableNo + ":" + t.stockId;
      m[k] = (m[k] || 0) + (t.side === "SELL" ? t.qty : -t.qty);
    }
  }
  return m;
}

// One participant's account. Handles broker trades and peer trades.
function summarize(pno, trades, stocks, startCash) {
  let cash = startCash;
  const hold = {};
  const mine = [];
  const add = (t, dir, who) => {
    const amt = t.price * t.qty;
    if (dir === "BUY") {
      cash -= amt;
      hold[t.stockId] = (hold[t.stockId] || 0) + t.qty;
    } else {
      cash += amt;
      hold[t.stockId] = (hold[t.stockId] || 0) - t.qty;
    }
    mine.push({ ...t, dir, who });
  };
  for (const t of trades) {
    if (t.kind === "PEER") {
      if (t.pno === pno) add(t, "BUY", "#" + t.counterparty);
      else if (t.counterparty === pno) add(t, "SELL", "#" + t.pno);
    } else if (t.pno === pno) add(t, t.side, t.tableNo ? "Table " + t.tableNo : "Broker");
  }
  let holdingsValue = 0;
  for (const s of stocks) {
    const q = hold[s.id] || 0;
    if (q) holdingsValue += q * refPrice(s, trades);
  }
  const total = cash + holdingsValue;
  return { mine, cash, hold, holdingsValue, total, pnl: total - startCash };
}

// Supabase returns max 1000 rows per request, so page through
async function fetchAll(table, orderCol) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table).select("*").order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setErr(error.message);
    setBusy(false);
  }

  return (
    <div className="app">
      <header>
        <h1>📜 RETRO MARKET</h1>
        <p>Broker Login</p>
      </header>
      <section className="card login">
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password"
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        <div style={{ height: 14 }} />
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "..." : "LOGIN"}</button>
        {err && <div className="msg err">{err}</div>}
      </section>
    </div>
  );
}

function AccountCard({ num, label, trades, stocks, startCash, verified, stockName, onVerify, onDelete }) {
  const sum = summarize(num, trades, stocks, startCash);
  const isLocked = (t) => verified[t.pno] || (t.counterparty && verified[t.counterparty]);
  return (
    <section className="card">
      <div className="head">
        <h2>{label ? label + " " : ""}#{num}</h2>
        <button className={"verify" + (verified[num] ? " locked" : "")} onClick={() => onVerify(num)}>
          {verified[num] ? "🔒 Verified (tap to unlock)" : "Mark Verified"}
        </button>
      </div>
      <div className="stats">
        <div><span>Cash</span><b>{fmt(sum.cash)}</b></div>
        <div><span>Holdings</span><b>{fmt(sum.holdingsValue)}</b></div>
        <div className="final"><span>Final Amount</span><b>{fmt(sum.total)}</b></div>
        <div><span>P&L</span><b className={sum.pnl >= 0 ? "pos" : "neg"}>{fmt(sum.pnl)}</b></div>
      </div>

      {Object.entries(sum.hold).some(([, q]) => q) && (
        <>
          <h3>Holdings</h3>
          <ul className="plain">
            {Object.entries(sum.hold).filter(([, q]) => q).map(([id, q]) => (
              <li key={id}>{stockName(id)} — {q} sh</li>
            ))}
          </ul>
        </>
      )}

      <h3>Trades ({sum.mine.length})</h3>
      <table>
        <thead><tr><th>Stock</th><th>Type</th><th>Price</th><th>Qty</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          {[...sum.mine].reverse().map((t) => (
            <tr key={t.id}>
              <td>{stockName(t.stockId)}</td>
              <td><span className={t.dir === "BUY" ? "neg" : "pos"}>{t.dir}</span> {t.dir === "BUY" ? "from" : "to"} {t.who}</td>
              <td>{fmt(t.price)}</td>
              <td>{t.qty}</td>
              <td>{fmt(t.price * t.qty)}</td>
              <td>{!isLocked(t) && <button className="x" onClick={() => onDelete(t.id)}>✕</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="app">Loading…</div>;
  if (!session) return <Login />;
  return <Desk />;
}

function Desk() {
  const [startCash, setStartCash] = useState(100000);
  const [numTables, setNumTables] = useState(9);
  const [stocks, setStocks] = useState([]);
  const [trades, setTrades] = useState([]);
  const [brokerStock, setBrokerStock] = useState({}); // "table:stock" -> starting qty
  const [verified, setVerified] = useState({});
  const [loadErr, setLoadErr] = useState("");

  const [tab, setTab] = useState("trade");
  const [mode, setMode] = useState("BROKER"); // BROKER | PEER
  const [pno, setPno] = useState("");
  const [buyerNo, setBuyerNo] = useState("");
  const [sellerNo, setSellerNo] = useState("");
  const [stockId, setStockId] = useState("");
  const [side, setSide] = useState("BUY");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fillQty, setFillQty] = useState("10");

  // which broker table this laptop is, remembered on this device
  const [myTable, setMyTable] = useState(() => {
    try { return localStorage.getItem("retro-table") || ""; } catch (e) { return ""; }
  });
  const chooseTable = (v) => {
    setMyTable(v);
    try { localStorage.setItem("retro-table", v); } catch (e) {}
  };

  const refresh = useCallback(async () => {
    try {
      const [{ data: set, error: e1 }, st, tr, ve, bs] = await Promise.all([
        supabase.from("settings").select("start_cash,num_tables").eq("id", 1).single(),
        fetchAll("stocks", "sort"),
        fetchAll("trades", "created_at"),
        fetchAll("verified", "pno"),
        fetchAll("broker_stock", "table_no"),
      ]);
      if (e1) throw e1;
      setStartCash(Number(set.start_cash));
      setNumTables(set.num_tables || 9);
      setStocks(st.map((s) => ({ id: s.id, name: s.name, close: s.close == null ? "" : String(s.close) })));
      setTrades(tr.map((r) => ({
        id: r.id, pno: r.pno, stockId: r.stock_id, side: r.side, kind: r.kind || "BROKER",
        counterparty: r.counterparty || null, tableNo: r.table_no || null,
        price: Number(r.price), qty: r.qty, ts: new Date(r.created_at).getTime(),
      })));
      setBrokerStock(Object.fromEntries(bs.map((b) => [b.table_no + ":" + b.stock_id, b.qty])));
      setVerified(Object.fromEntries(ve.map((v) => [v.pno, true])));
      setLoadErr("");
    } catch (e) {
      setLoadErr(e.message || "Could not load data");
    }
  }, []);

  // initial load + live updates from other devices
  const timer = useRef(null);
  useEffect(() => {
    refresh();
    const ch = supabase
      .channel("desk")
      .on("postgres_changes", { event: "*", schema: "public" }, () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(refresh, 250);
      })
      .subscribe();
    const poll = setInterval(refresh, 15000); // safety net if realtime drops
    return () => {
      supabase.removeChannel(ch);
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  const left = useMemo(() => computeLeft(brokerStock, trades), [brokerStock, trades]);
  const leftOf = (t, sid) => left[t + ":" + sid] || 0;
  const tablesArr = Array.from({ length: numTables }, (_, i) => i + 1);
  const tno = Number(myTable) >= 1 && Number(myTable) <= numTables ? Number(myTable) : 0;

  const p = pno.trim();
  const buyer = buyerNo.trim();
  const seller = sellerNo.trim();
  const stockName = (id) => stocks.find((s) => s.id === id)?.name || id;
  const amount = (Number(price) || 0) * (Number(qty) || 0);
  const selLast = stockId ? lastPriceOf(stockId, trades) : null;
  const cardProps = { trades, stocks, startCash, verified, stockName, onVerify: toggleVerify, onDelete: deleteTrade };

  async function addTrade() {
    if (busy) return;
    const pr = Number(price);
    const q = Number(qty);
    const err = (text) => setMsg({ ok: false, text });

    const parties = mode === "PEER" ? [buyer, seller] : [p];
    if (mode === "PEER") {
      if (!buyer || !seller) return err("Enter both buyer and seller numbers");
      if (buyer === seller) return err("Buyer and seller can't be the same person");
    } else {
      if (!tno) return err("Choose your broker table first (top of the screen)");
      if (!p) return err("Enter participant number");
    }
    for (const x of parties) if (verified[x]) return err(`Participant ${x} is verified & locked`);
    if (!stockId) return err("Select a stock");
    if (!(pr > 0)) return err("Enter a valid price");
    if (!(q > 0) || !Number.isInteger(q)) return err("Quantity must be a whole number");

    if (mode === "PEER") {
      const b = summarize(buyer, trades, stocks, startCash);
      const s = summarize(seller, trades, stocks, startCash);
      if (s.hold[stockId] === undefined || s.hold[stockId] < q)
        return err(`Seller #${seller} holds only ${s.hold[stockId] || 0} of ${stockName(stockId)}`);
      if (b.cash < pr * q) return err(`Buyer #${buyer} has only ${fmt(b.cash)}`);
    } else {
      const s = summarize(p, trades, stocks, startCash);
      if (side === "SELL" && (s.hold[stockId] || 0) < q)
        return err(`Only ${s.hold[stockId] || 0} shares of ${stockName(stockId)} held`);
      if (side === "BUY") {
        if (s.cash < pr * q) return err(`Not enough cash (has ${fmt(s.cash)})`);
        const l = leftOf(tno, stockId);
        if (l < q) {
          const others = tablesArr.filter((n) => n !== tno && leftOf(n, stockId) > 0)
            .map((n) => `T${n} (${leftOf(n, stockId)})`).join(", ");
          return err(`Table ${tno} has only ${l} left. ${others ? "Send them to: " + others : "No table has it. Trade participant to participant"}`);
        }
      }
    }

    if (selLast && Math.abs(pr - selLast) / selLast > PRICE_WARN) {
      if (!window.confirm(`Last price of ${stockName(stockId)} was ${fmt(selLast)}. You typed ${fmt(pr)}. Save anyway?`)) return;
    }

    setBusy(true);
    const row =
      mode === "PEER"
        ? { kind: "PEER", pno: buyer, counterparty: seller, stock_id: stockId, side: "BUY", price: pr, qty: q }
        : { kind: "BROKER", pno: p, stock_id: stockId, side, price: pr, qty: q, table_no: tno };
    const { error } = await supabase.from("trades").insert(row);
    setBusy(false);
    if (error) return err("Not saved: " + error.message);
    setMsg({
      ok: true,
      text:
        mode === "PEER"
          ? `#${buyer} bought ${q} × ${stockName(stockId)} from #${seller} @ ${fmt(pr)}`
          : `${side} ${q} × ${stockName(stockId)} @ ${fmt(pr)} saved for #${p} (Table ${tno})`,
    });
    setPrice("");
    setQty("1");
    refresh();
  }

  async function deleteTrade(id) {
    const { error } = await supabase.from("trades").delete().eq("id", id);
    if (error) setMsg({ ok: false, text: "Delete failed: " + error.message });
    refresh();
  }

  async function toggleVerify(num) {
    const { error } = verified[num]
      ? await supabase.from("verified").delete().eq("pno", num)
      : await supabase.from("verified").insert({ pno: num });
    if (error) setMsg({ ok: false, text: error.message });
    refresh();
  }

  async function saveStartCash(v) {
    await supabase.from("settings").update({ start_cash: Number(v) || 0 }).eq("id", 1);
    refresh();
  }

  async function saveNumTables(v) {
    const n = Math.min(30, Math.max(1, Math.floor(Number(v) || 9)));
    await supabase.from("settings").update({ num_tables: n }).eq("id", 1);
    refresh();
  }

  async function saveStock(id, patch) {
    await supabase.from("stocks").update(patch).eq("id", id);
    refresh();
  }

  async function saveTableQty(t, sid, v) {
    const qn = Math.max(0, Math.floor(Number(v) || 0));
    const { error } = await supabase.from("broker_stock")
      .upsert({ table_no: t, stock_id: sid, qty: qn }, { onConflict: "table_no,stock_id" });
    if (error) setMsg({ ok: false, text: error.message });
    refresh();
  }

  async function fillAll() {
    const qn = Math.max(0, Math.floor(Number(fillQty) || 0));
    if (!window.confirm(`Set the starting stock of EVERY stock at EVERY table to ${qn}?`)) return;
    const rows = stocks.flatMap((s) => tablesArr.map((t) => ({ table_no: t, stock_id: s.id, qty: qn })));
    const { error } = await supabase.from("broker_stock").upsert(rows, { onConflict: "table_no,stock_id" });
    if (error) setMsg({ ok: false, text: error.message });
    refresh();
  }

  async function resetTrades() {
    if (!window.confirm("Delete ALL trades and verifications for everyone? This cannot be undone.")) return;
    await supabase.from("verified").delete().neq("pno", ""); // unlock first, locked trades can't be deleted
    await supabase.from("trades").delete().gte("created_at", "1970-01-01");
    setPno(""); setBuyerNo(""); setSellerNo("");
    refresh();
  }

  const allPnos = [...new Set(trades.flatMap((t) => (t.counterparty ? [t.pno, t.counterparty] : [t.pno])))];
  const board = allPnos
    .map((n) => ({ pno: n, ...summarize(n, trades, stocks, startCash) }))
    .sort((a, b) => b.total - a.total);

  function exportCSV() {
    const rows = [["Rank", "Participant", "Trades", "Cash", "Holdings Value", "Final Amount", "P&L", "Verified"]];
    board.forEach((r, i) =>
      rows.push([i + 1, r.pno, r.mine.length, r.cash, r.holdingsValue, r.total, r.pnl, verified[r.pno] ? "Yes" : "No"])
    );
    rows.push([]);
    rows.push(["Type", "Table", "Buyer", "Seller", "Stock", "Price", "Qty", "Amount", "Time"]);
    trades.forEach((t) =>
      rows.push([
        t.kind,
        t.kind === "BROKER" ? t.tableNo || "" : "",
        t.kind === "PEER" ? t.pno : t.side === "BUY" ? t.pno : "Broker",
        t.kind === "PEER" ? t.counterparty : t.side === "SELL" ? t.pno : "Broker",
        stockName(t.stockId), t.price, t.qty, t.price * t.qty, new Date(t.ts).toLocaleTimeString(),
      ])
    );
    rows.push([]);
    rows.push(["Stock left", ...tablesArr.map((t) => "Table " + t)]);
    stocks.forEach((s) => rows.push([s.name, ...tablesArr.map((t) => leftOf(t, s.id))]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "retro-market-trades.csv";
    a.click();
  }

  const onEnter = (e) => e.key === "Enter" && addTrade();
  const peerTrades = trades.filter((t) => t.kind === "PEER").length;

  return (
    <div className="app">
      <header>
        <h1>📜 RETRO MARKET</h1>
        <p>Broker Desk · {trades.length} trades ({peerTrades} peer) · {allPnos.length} participants</p>
        <button className="logout" onClick={() => supabase.auth.signOut()}>Logout</button>
      </header>

      <div className={"tablebar" + (tno ? "" : " warn")}>
        <b>This laptop is Broker Table</b>
        <select value={tno || ""} onChange={(e) => chooseTable(e.target.value)}>
          <option value="">— choose —</option>
          {tablesArr.map((n) => <option key={n} value={n}>Table {n}</option>)}
        </select>
        {!tno && <span>← choose your table before trading with the broker</span>}
      </div>

      {loadErr && <div className="msg err">Connection problem: {loadErr} (retrying…)</div>}

      <nav>
        {[["trade", "Trade"], ["tables", "Table Stock"], ["board", "Participants"], ["settings", "Settings"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "trade" && (
        <div className="grid">
          <section className="card">
            <label>Trade between</label>
            <div className="row">
              <button className={"mode" + (mode === "BROKER" ? " on" : "")} onClick={() => setMode("BROKER")}>
                Participant ↔ Broker
              </button>
              <button className={"mode" + (mode === "PEER" ? " on" : "")} onClick={() => setMode("PEER")}>
                Participant ↔ Participant
              </button>
            </div>

            {mode === "BROKER" ? (
              <>
                <label>Participant No.</label>
                <input className="big" value={pno} onChange={(e) => setPno(e.target.value)} onKeyDown={onEnter}
                  placeholder="e.g. 42" inputMode="numeric" autoFocus />
              </>
            ) : (
              <div className="row">
                <div className="f">
                  <label>Buyer No.</label>
                  <input className="big" value={buyerNo} onChange={(e) => setBuyerNo(e.target.value)} onKeyDown={onEnter}
                    placeholder="buyer" inputMode="numeric" autoFocus />
                </div>
                <div className="f">
                  <label>Seller No.</label>
                  <input className="big" value={sellerNo} onChange={(e) => setSellerNo(e.target.value)} onKeyDown={onEnter}
                    placeholder="seller" inputMode="numeric" />
                </div>
              </div>
            )}

            <label>Stock</label>
            <div className="stocks">
              {stocks.map((s) => {
                const lp = lastPriceOf(s.id, trades);
                const mineLeft = tno ? leftOf(tno, s.id) : null;
                const soldOut = mode === "BROKER" && tno && mineLeft <= 0;
                const others = tablesArr.filter((n) => n !== tno && leftOf(n, s.id) > 0);
                return (
                  <button key={s.id} className={"stock" + (stockId === s.id ? " on" : "") + (soldOut ? " out" : "")}
                    onClick={() => setStockId(s.id)}>
                    {s.name}
                    {mode === "BROKER" && (
                      <small>
                        {tno ? (soldOut ? `SOLD OUT at Table ${tno}` : `Table ${tno}: ${mineLeft} left`) : "choose your table"}
                        {lp != null ? ` · last ${fmt(lp)}` : ""}
                      </small>
                    )}
                    {mode === "BROKER" && soldOut && (
                      <small>{others.length ? "Try " + others.slice(0, 3).map((n) => `T${n} (${leftOf(n, s.id)})`).join(", ") : "No table has stock"}</small>
                    )}
                    {mode === "PEER" && <small>{lp != null ? `last ${fmt(lp)}` : "no trades yet"}</small>}
                  </button>
                );
              })}
            </div>

            {mode === "BROKER" && (
              <>
                <label>Action</label>
                <div className="row">
                  <button className={"side buy" + (side === "BUY" ? " on" : "")} onClick={() => setSide("BUY")}>
                    BUY (from broker)
                  </button>
                  <button className={"side sell" + (side === "SELL" ? " on" : "")} onClick={() => setSide("SELL")}>
                    SELL (to broker)
                  </button>
                </div>
              </>
            )}

            <div className="row">
              <div className="f">
                <label>Price (₹){selLast != null ? ` · last ${fmt(selLast)}` : ""}</label>
                <input value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={onEnter} inputMode="decimal" placeholder="0" />
              </div>
              <div className="f">
                <label>Quantity</label>
                <input value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={onEnter} inputMode="numeric" />
              </div>
            </div>

            <div className="amount">Trade amount: <b>{fmt(amount)}</b></div>
            <button className="primary" onClick={addTrade} disabled={busy}>{busy ? "SAVING…" : "ADD TRADE"}</button>
            {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
          </section>

          <div className="col">
            {mode === "PEER" ? (
              <>
                {buyer && <AccountCard num={buyer} label="Buyer" {...cardProps} />}
                {seller && <AccountCard num={seller} label="Seller" {...cardProps} />}
                {!buyer && !seller && <section className="card"><p className="muted">Enter buyer and seller numbers to see both accounts.</p></section>}
              </>
            ) : p ? (
              <AccountCard num={p} {...cardProps} />
            ) : (
              <section className="card"><p className="muted">Enter a participant number to see their account.</p></section>
            )}
          </div>
        </div>
      )}

      {tab === "tables" && (
        <section className="card">
          <h2>Stock left at each table</h2>
          <p className="muted">
            Big number = shares left now. Small box = starting stock (edit it, it saves when you leave the box).
            Your table is highlighted.
          </p>
          <div className="fillbar">
            <span>Set every cell to</span>
            <input value={fillQty} onChange={(e) => setFillQty(e.target.value)} inputMode="numeric" />
            <button className="primary small" onClick={fillAll}>Apply to all</button>
          </div>
          <div className="scroll">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Stock</th>
                  {tablesArr.map((t) => <th key={t} className={t === tno ? "me" : ""}>T{t}</th>)}
                  <th>Total left</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    {tablesArr.map((t) => {
                      const l = leftOf(t, s.id);
                      const start = brokerStock[t + ":" + s.id] || 0;
                      return (
                        <td key={t + "|" + start} className={(t === tno ? "me " : "") + (l <= 0 ? "zero" : "")}>
                          <div className="cellnum">{l}</div>
                          <input className="cellin" defaultValue={start} inputMode="numeric"
                            onBlur={(e) => Number(e.target.value) !== start && saveTableQty(t, s.id, e.target.value)} />
                        </td>
                      );
                    })}
                    <td><b>{tablesArr.reduce((a, t) => a + leftOf(t, s.id), 0)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "board" && (
        <section className="card">
          <div className="head">
            <h2>All Participants ({board.length})</h2>
            <button className="primary small" onClick={exportCSV}>Export CSV</button>
          </div>
          <table>
            <thead><tr><th>#</th><th>Part. No</th><th>Trades</th><th>Cash</th><th>Final Amount</th><th>P&L</th><th>Verified</th></tr></thead>
            <tbody>
              {board.map((r, i) => (
                <tr key={r.pno} className="click" onClick={() => { setPno(r.pno); setMode("BROKER"); setTab("trade"); }}>
                  <td>{i + 1}</td>
                  <td><b>{r.pno}</b></td>
                  <td>{r.mine.length}</td>
                  <td>{fmt(r.cash)}</td>
                  <td><b>{fmt(r.total)}</b></td>
                  <td className={r.pnl >= 0 ? "pos" : "neg"}>{fmt(r.pnl)}</td>
                  <td>{verified[r.pno] ? "🔒" : "—"}</td>
                </tr>
              ))}
              {!board.length && <tr><td colSpan="7" className="muted">No trades yet.</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {tab === "settings" && (
        <section className="card">
          <h2>Settings</h2>
          <div className="row">
            <div className="f">
              <label>Starting cash per participant (₹)</label>
              <input key={"sc" + startCash} defaultValue={startCash} inputMode="numeric"
                onBlur={(e) => saveStartCash(e.target.value)} />
            </div>
            <div className="f">
              <label>Number of broker tables</label>
              <input key={"nt" + numTables} defaultValue={numTables} inputMode="numeric"
                onBlur={(e) => Number(e.target.value) !== numTables && saveNumTables(e.target.value)} />
            </div>
          </div>

          <h3>Stocks</h3>
          <p className="muted">
            Changes save when you leave the field. Closing price is optional: if empty, holdings are valued at the
            last traded price. Starting stock per table is set in the <b>Table Stock</b> tab.
          </p>
          <div className="row hdr"><span className="f">Name</span><span className="f">Closing price</span></div>
          {stocks.map((s) => (
            <div className="row" key={s.id + "|" + s.name + "|" + s.close}>
              <input className="f" defaultValue={s.name}
                onBlur={(e) => e.target.value !== s.name && saveStock(s.id, { name: e.target.value })} />
              <input className="f" placeholder="Closing price" defaultValue={s.close} inputMode="decimal"
                onBlur={(e) => e.target.value !== s.close &&
                  saveStock(s.id, { close: e.target.value === "" ? null : Number(e.target.value) })} />
            </div>
          ))}

          <h3>Danger zone</h3>
          <button className="danger" onClick={resetTrades}>Delete all trades</button>
        </section>
      )}
    </div>
  );
}
