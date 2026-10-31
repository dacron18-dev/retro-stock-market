import { useEffect, useState } from "react";
import "./App.css";

const KEY = "retro-market-v1";
const DEFAULT_NAMES = [
  "Bombay Jute", "Dalal Textiles", "Sensex Steel", "Nirmal Tea", "Rupee Rails",
  "Gateway Shipping", "Lakshmi Spices", "Marine Drive Motors", "Phoenix Cement", "Cerebro Cotton",
];

const defaultState = () => ({
  startCash: 100000,
  stocks: DEFAULT_NAMES.map((name, i) => ({ id: "s" + (i + 1), name, close: "" })),
  trades: [],
  verified: {},
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {}
  return defaultState();
}

const fmt = (n) =>
  (n < 0 ? "-" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function refPrice(stock, trades) {
  if (stock.close !== "" && stock.close != null) return Number(stock.close);
  const last = [...trades].reverse().find((t) => t.stockId === stock.id);
  return last ? last.price : 0;
}

function summarize(pno, trades, stocks, startCash) {
  let cash = startCash;
  const hold = {};
  const mine = trades.filter((t) => t.pno === pno);
  for (const t of mine) {
    const amt = t.price * t.qty;
    if (t.side === "BUY") {
      cash -= amt;
      hold[t.stockId] = (hold[t.stockId] || 0) + t.qty;
    } else {
      cash += amt;
      hold[t.stockId] = (hold[t.stockId] || 0) - t.qty;
    }
  }
  let holdingsValue = 0;
  for (const s of stocks) {
    const q = hold[s.id] || 0;
    if (q) holdingsValue += q * refPrice(s, trades);
  }
  const total = cash + holdingsValue;
  return { mine, cash, hold, holdingsValue, total, pnl: total - startCash };
}

export default function App() {
  const [data, setData] = useState(load);
  const [tab, setTab] = useState("trade");
  const [pno, setPno] = useState("");
  const [stockId, setStockId] = useState("");
  const [side, setSide] = useState("BUY");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {}
  }, [data]);

  const { stocks, trades, startCash, verified } = data;
  const update = (patch) => setData((d) => ({ ...d, ...patch }));
  const p = pno.trim();
  const sum = p ? summarize(p, trades, stocks, startCash) : null;
  const stockName = (id) => stocks.find((s) => s.id === id)?.name || id;
  const amount = (Number(price) || 0) * (Number(qty) || 0);

  function addTrade() {
    const pr = Number(price);
    const q = Number(qty);
    if (!p) return setMsg({ ok: false, text: "Enter participant number" });
    if (verified[p]) return setMsg({ ok: false, text: `Participant ${p} is verified & locked` });
    if (!stockId) return setMsg({ ok: false, text: "Select a stock" });
    if (!(pr > 0)) return setMsg({ ok: false, text: "Enter a valid price" });
    if (!(q > 0) || !Number.isInteger(q)) return setMsg({ ok: false, text: "Quantity must be a whole number" });
    const s = summarize(p, trades, stocks, startCash);
    if (side === "SELL" && (s.hold[stockId] || 0) < q)
      return setMsg({ ok: false, text: `Only ${s.hold[stockId] || 0} shares of ${stockName(stockId)} held` });
    if (side === "BUY" && s.cash < pr * q)
      return setMsg({ ok: false, text: `Not enough cash (has ${fmt(s.cash)})` });
    const t = { id: Date.now() + Math.random(), pno: p, stockId, side, price: pr, qty: q, ts: Date.now() };
    update({ trades: [...trades, t] });
    setMsg({ ok: true, text: `${side} ${q} × ${stockName(stockId)} @ ${fmt(pr)} added for #${p}` });
    setPrice("");
    setQty("1");
  }

  function deleteTrade(id) {
    if (verified[p]) return;
    update({ trades: trades.filter((t) => t.id !== id) });
  }

  function toggleVerify() {
    update({ verified: { ...verified, [p]: !verified[p] } });
  }

  const allPnos = [...new Set(trades.map((t) => t.pno))];
  const board = allPnos
    .map((n) => ({ pno: n, ...summarize(n, trades, stocks, startCash) }))
    .sort((a, b) => b.total - a.total);

  function exportCSV() {
    const rows = [["Rank", "Participant", "Trades", "Cash", "Holdings Value", "Final Amount", "P&L", "Verified"]];
    board.forEach((r, i) =>
      rows.push([i + 1, r.pno, r.mine.length, r.cash, r.holdingsValue, r.total, r.pnl, verified[r.pno] ? "Yes" : "No"])
    );
    rows.push([]);
    rows.push(["Participant", "Stock", "Side", "Price", "Qty", "Amount", "Time"]);
    trades.forEach((t) =>
      rows.push([t.pno, stockName(t.stockId), t.side, t.price, t.qty, t.price * t.qty, new Date(t.ts).toLocaleTimeString()])
    );
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "retro-market-trades.csv";
    a.click();
  }

  function resetAll() {
    if (window.confirm("Delete ALL trades and settings? This cannot be undone.")) {
      setData(defaultState());
      setPno("");
    }
  }

  const onEnter = (e) => e.key === "Enter" && addTrade();

  return (
    <div className="app">
      <header>
        <h1>📜 RETRO MARKET</h1>
        <p>Broker Desk · Paper Slip Trading</p>
      </header>

      <nav>
        {[["trade", "Trade"], ["board", "Participants"], ["settings", "Stocks & Settings"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "trade" && (
        <div className="grid">
          <section className="card">
            <label>Participant No.</label>
            <input className="big" value={pno} onChange={(e) => setPno(e.target.value)} onKeyDown={onEnter}
              placeholder="e.g. 42" inputMode="numeric" autoFocus />

            <label>Stock</label>
            <div className="stocks">
              {stocks.map((s) => (
                <button key={s.id} className={"stock" + (stockId === s.id ? " on" : "")} onClick={() => setStockId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>

            <label>Action</label>
            <div className="row">
              <button className={"side buy" + (side === "BUY" ? " on" : "")} onClick={() => setSide("BUY")}>BUY</button>
              <button className={"side sell" + (side === "SELL" ? " on" : "")} onClick={() => setSide("SELL")}>SELL</button>
            </div>

            <div className="row">
              <div className="f">
                <label>Price (₹)</label>
                <input value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={onEnter} inputMode="decimal" placeholder="0" />
              </div>
              <div className="f">
                <label>Quantity</label>
                <input value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={onEnter} inputMode="numeric" />
              </div>
            </div>

            <div className="amount">
              Trade amount: <b>{fmt(amount)}</b>
            </div>
            <button className="primary" onClick={addTrade}>ADD TRADE</button>
            {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
          </section>

          <section className="card">
            {!sum ? (
              <p className="muted">Enter a participant number to see their account.</p>
            ) : (
              <>
                <div className="head">
                  <h2>Participant #{p}</h2>
                  <button className={"verify" + (verified[p] ? " locked" : "")} onClick={toggleVerify}>
                    {verified[p] ? "🔒 Verified (tap to unlock)" : "Mark Verified"}
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
                  <thead><tr><th>Stock</th><th>Side</th><th>Price</th><th>Qty</th><th>Amount</th><th></th></tr></thead>
                  <tbody>
                    {[...sum.mine].reverse().map((t) => (
                      <tr key={t.id}>
                        <td>{stockName(t.stockId)}</td>
                        <td className={t.side === "BUY" ? "neg" : "pos"}>{t.side}</td>
                        <td>{fmt(t.price)}</td>
                        <td>{t.qty}</td>
                        <td>{fmt(t.price * t.qty)}</td>
                        <td>{!verified[p] && <button className="x" onClick={() => deleteTrade(t.id)}>✕</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>
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
                <tr key={r.pno} className="click" onClick={() => { setPno(r.pno); setTab("trade"); }}>
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
          <label>Starting cash per participant (₹)</label>
          <input value={startCash} inputMode="numeric"
            onChange={(e) => update({ startCash: Number(e.target.value) || 0 })} />

          <h3>Stocks</h3>
          <p className="muted">
            Closing price is optional. Leave it empty and holdings are valued at the last traded price.
            Fill it at the end of the event for the final result.
          </p>
          {stocks.map((s, i) => (
            <div className="row" key={s.id}>
              <input className="f" value={s.name}
                onChange={(e) => update({ stocks: stocks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="f" placeholder="Closing price" value={s.close} inputMode="decimal"
                onChange={(e) => update({ stocks: stocks.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)) })} />
            </div>
          ))}

          <h3>Danger zone</h3>
          <button className="danger" onClick={resetAll}>Reset everything</button>
        </section>
      )}
    </div>
  );
}
