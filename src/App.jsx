import React, { useState, useEffect, useCallback } from "react";

// ─── Ticker catalog with optimal option contract Ask price ranges ──────────────
// range = [minAsk, maxAsk] of the option CONTRACT (not stock price)
const TICKERS = [
  { sym:"TSLA",  name:"Tesla",              range:[0.80, 1.60] },
  { sym:"GOOGL", name:"Alphabet A",         range:[0.60, 1.40] },
  { sym:"AMZN",  name:"Amazon",             range:[0.65, 1.30] },
  { sym:"AAPL",  name:"Apple",              range:[0.45, 0.95] },
  { sym:"GOOG",  name:"Alphabet C",         range:[0.60, 1.40] },
  { sym:"META",  name:"Meta",               range:[0.50, 1.70] },
  { sym:"MSFT",  name:"Microsoft",          range:[0.70, 1.55] },
  { sym:"NFLX",  name:"Netflix",            range:[0.55, 0.85] },
  { sym:"PLTR",  name:"Palantir",           range:[0.40, 0.90] },
  { sym:"NVDA",  name:"NVIDIA",             range:[0.80, 1.70] },
  { sym:"AMD",   name:"AMD",                range:[0.65, 1.40] },
  { sym:"DIA",   name:"Dow Jones ETF",      range:[0.50, 1.10] },
  { sym:"IWM",   name:"Russell 2000 ETF",   range:[0.40, 0.70] },
  { sym:"SPY",   name:"S&P 500 ETF",        range:[0.30, 0.65] },
  { sym:"GLD",   name:"Gold ETF",           range:[0.45, 1.00] },
  { sym:"SLV",   name:"Silver ETF",         range:[0.30, 0.60] },
  { sym:"USO",   name:"Oil ETF",            range:[0.35, 0.75] },
];
const SYMS       = TICKERS.map(t => t.sym);
const TICKER_MAP = Object.fromEntries(TICKERS.map(t => [t.sym, t]));

// ─── App constants ────────────────────────────────────────────────────────────
const TABS  = ["Mercado", "Señal", "Check", "Calc", "Trades", "Bot", "BTest", "Ref"];
const PLANS = [
  { id:"p10",  label:"Plan 10%",  pct:0.10, from:"from-blue-700",   to:"to-blue-500"   },
  { id:"p35",  label:"Plan 35%",  pct:0.35, from:"from-purple-700", to:"to-purple-500" },
  { id:"p100", label:"Plan 100%", pct:1.00, from:"from-amber-700",  to:"to-amber-500"  },
];
const LOW_VOL_PCT = 3.0;   // BB width % — below this = low volatility
const DAYS  = ["Lunes","Martes","Miércoles","Jueves","Viernes"];
const DTES  = [5, 4, 3, 2, 1];  // DTE guidance by weekday

const LS = { KEY:"kz_api_key", TRADES:"kz_trades", CHECK:"kz_check", TREG:"kz_treg", SEL:"kz_selected" };
const DEFAULT_SEL  = ["TSLA", "GOOGL", "MSFT", "META"];
const CHUNK_SIZE   = 4;
const INTER_DELAY  = 15; // seconds between groups

// ─── Helpers ──────────────────────────────────────────────────────────────────
const f2    = n  => n == null ? "—" : Number(n).toFixed(2);
const fpct  = n  => (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
const fvol  = n  => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : String(n ?? "—");
const today = () => new Date().toISOString().split("T")[0];
const nowT  = () => new Date().toTimeString().slice(0,5);

function sma(arr, n) {
  if (arr.length < n) return null;
  const sl = arr.slice(-n);
  return sl.reduce((a,b)=>a+b,0)/n;
}

function calcBB(closes, n=20, mult=2) {
  if (closes.length < n) return null;
  const sl   = closes.slice(-n);
  const mean = sl.reduce((a,b)=>a+b,0)/n;
  const std  = Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/n);
  return { upper:mean+mult*std, mid:mean, lower:mean-mult*std, std,
           width:(mult*2*std/mean)*100 };
}

function calcSignal(price, BB, ma20, ma50) {
  if (!BB || !ma20) return { label:"NEUTRAL", color:"text-yellow-400", bg:"bg-yellow-900/40" };
  const pos = (price-BB.lower)/(BB.upper-BB.lower);
  let s = 0;
  if (pos < 0.2) s+=2; if (pos > 0.8) s-=2;
  s += price>ma20 ? 1 : -1;
  if (ma50 != null) s += price>ma50 ? 1 : -1;
  if (s >=  2) return { label:"COMPRA",  color:"text-green-400",  bg:"bg-green-900/40"  };
  if (s <= -2) return { label:"VENTA",   color:"text-red-400",    bg:"bg-red-900/40"    };
  return             { label:"NEUTRAL", color:"text-yellow-400", bg:"bg-yellow-900/40" };
}

function detectGap(bars) {
  if (bars.length < 2) return null;
  const gapPct = (bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c * 100;
  if (gapPct >  0.5) return { type:"UP",   pct:gapPct };
  if (gapPct < -0.5) return { type:"DOWN", pct:gapPct };
  return null;
}

// ─── Polygon API ──────────────────────────────────────────────────────────────
async function fetchTicker(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setDate(from.getDate()-100);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=120&apiKey=${apiKey}`;

  let res;
  try { res = await fetch(url); }
  catch(e) { throw new Error("Error de red — verifica tu conexión"); }

  // 429 = rate limit: retry with back-off (15s → 30s → 60s)
  if (res.status === 429) {
    if (attempt < 3) {
      const wait = [15000, 30000, 60000][attempt];
      await new Promise(r => setTimeout(r, wait));
      return fetchTicker(sym, apiKey, attempt + 1);
    }
    throw new Error("Límite API (429) — espera 1 min e intenta de nuevo");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  if (!json.results?.length) throw new Error("Sin datos");

  const bars    = json.results;
  const closes  = bars.map(b => b.c);
  const vols    = bars.map(b => b.v);
  const last    = bars[bars.length - 1];
  const prev    = bars[bars.length - 2];

  const BB      = calcBB(closes);
  const BBprev  = calcBB(closes.slice(0, -1));   // BB without today → detects prior low-vol
  const ma20    = sma(closes, 20);
  const ma40    = sma(closes, 40);
  const ma50    = sma(closes, 50);
  const avgVol  = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);

  const bbW     = BB?.width ?? 0;
  const volLevel = bbW < 3 ? "BAJA" : bbW < 8 ? "ALTA" : "EXTREMA";

  return {
    sym, price:last.c, open:last.o, high:last.h, low:last.l, volume:last.v,
    change:     last.c - (prev?.c ?? last.c),
    changePct:  prev ? (last.c - prev.c) / prev.c * 100 : 0,
    bb: BB, ma20, ma40, ma50,
    signal:     calcSignal(last.c, BB, ma20, ma50),
    gap:        detectGap(bars), bars,
    avgVolume:  avgVol,
    prevLowVol: BBprev ? BBprev.width < 3 : false,  // was quiet before today?
    volLevel,
  };
}

// Fetch syms in groups of CHUNK_SIZE with INTER_DELAY seconds between groups.
// onGroup({ groupIdx, totalGroups, syms }) — called when a group starts loading
// onCountdown(secondsLeft)              — called every second during inter-group wait
// onBatch({ results, errors })          — called after each group completes
async function fetchAllTickers(syms, apiKey, { onGroup, onCountdown, onBatch } = {}) {
  const acc = {}; const errs = {};
  const chunks = [];
  for (let i = 0; i < syms.length; i += CHUNK_SIZE) chunks.push(syms.slice(i, i + CHUNK_SIZE));

  for (let ci = 0; ci < chunks.length; ci++) {
    // Inter-group countdown (skip for first group)
    if (ci > 0) {
      for (let s = INTER_DELAY; s >= 1; s--) {
        onCountdown?.({ remaining: s, nextGroup: ci + 1, totalGroups: chunks.length });
        await new Promise(r => setTimeout(r, 1000));
      }
      onCountdown?.(null);
    }

    onGroup?.({ groupIdx: ci + 1, totalGroups: chunks.length, syms: chunks[ci] });

    const settled = await Promise.allSettled(chunks[ci].map(s => fetchTicker(s, apiKey)));
    settled.forEach((res, j) => {
      const sym = chunks[ci][j];
      if (res.status === "fulfilled") acc[sym] = res.value;
      else errs[sym] = res.reason?.message || "Error";
    });
    onBatch?.({ results: { ...acc }, errors: { ...errs } });
  }
}

// ─── Strategy engine ─────────────────────────────────────────────────────────
// "auto"   = calculated from market data (no user input needed)
// "manual" = requires chart analysis → user toggles ✓/✗

const STRATS = [
  { id:1, name:"Ruptura Alcista 1H",          dir:"CALL",
    specific:[
      { id:"trendBreak", type:"manual", label:"Línea de tendencia rota al alza" },
      { id:"ma20x1H",    type:"manual", label:"MA20 cruzada en temporalidad 1H" },
      { id:"conf15m",    type:"manual", label:"15min confirmando ruptura" },
    ]},
  { id:2, name:"Ruptura Bajista 1H",          dir:"PUT",
    specific:[
      { id:"trendBreak", type:"manual", label:"Línea de tendencia rota a la baja" },
      { id:"ma20x1H",    type:"manual", label:"MA20 cruzada en temporalidad 1H" },
      { id:"conf15m",    type:"manual", label:"15min confirmando ruptura" },
    ]},
  { id:3, name:"Rebote Banda Media Alcista",  dir:"CALL",
    specific:[
      { id:"clearTrend", type:"auto",   label:"Tendencia alcista clara en DIA (precio > MA20 > MA40)" },
      { id:"bbMidTouch", type:"auto",   label:"Precio tocando banda media BB (±1%)" },
      { id:"bounce",     type:"manual", label:"Rebote alcista iniciado confirmado" },
    ]},
  { id:4, name:"Rebote Banda Media Bajista",  dir:"PUT",
    specific:[
      { id:"clearTrend", type:"auto",   label:"Tendencia bajista clara en DIA (precio < MA20 < MA40)" },
      { id:"bbMidTouch", type:"auto",   label:"Precio tocando banda media BB (±1%)" },
      { id:"bounce",     type:"manual", label:"Rebote bajista iniciado confirmado" },
    ]},
  { id:5, name:"GAP Extremo Apertura CALL",   dir:"CALL",
    noHighVolRequired: true, // these strats use the GAP as their volatility event
    specific:[
      { id:"lateralTrend",  type:"auto",   label:"Tendencia lateral previa (BB ancho 2-4%)" },
      { id:"prevLowVol",    type:"auto",   label:"Sin volatilidad antes del día de hoy" },
      { id:"gapUp",         type:"auto",   label:"GAP al alza detectado hoy" },
      { id:"gapTime",       type:"auto",   label:"Dentro de ventana 9:30–9:35 am ET" },
    ]},
  { id:6, name:"GAP Extremo Apertura PUT",    dir:"PUT",
    noHighVolRequired: true,
    specific:[
      { id:"lateralTrend",  type:"auto",   label:"Tendencia lateral previa (BB ancho 2-4%)" },
      { id:"prevLowVol",    type:"auto",   label:"Sin volatilidad antes del día de hoy" },
      { id:"gapDown",       type:"auto",   label:"GAP a la baja detectado hoy" },
      { id:"gapTime",       type:"auto",   label:"Dentro de ventana 9:30–9:35 am ET" },
    ]},
  { id:7, name:"Disipador + Worden CALL",     dir:"CALL",
    specific:[
      { id:"multiDayTrend", type:"manual", label:"Tendencia alcista de varios días" },
      { id:"strongJump",    type:"auto",   label:"Salto fuerte (GAP > 1.5%)" },
      { id:"dissipator",    type:"manual", label:"Vela disipador fuera de rango" },
      { id:"wordenRed",     type:"manual", label:"Worden Stochastics cruzando al alza" },
    ]},
  { id:8, name:"Disipador + Worden PUT",      dir:"PUT",
    specific:[
      { id:"multiDayTrend", type:"manual", label:"Tendencia bajista de varios días" },
      { id:"strongJump",    type:"auto",   label:"Salto fuerte (GAP > 1.5%)" },
      { id:"dissipator",    type:"manual", label:"Vela disipador fuera de rango" },
      { id:"wordenRed",     type:"manual", label:"Worden Stochastics cruzando a la baja" },
    ]},
];

// Auto-evaluate data against a strategy direction
function evalAuto(data, strat) {
  if (!data) return {};
  const isCall = strat.dir === "CALL";
  const bb = data.bb;
  const now = new Date();
  // ET offset: UTC-4 in summer, UTC-5 in winter
  const etOffset = -4; // approximate; adjust for DST if needed
  const etH = (now.getUTCHours() + etOffset + 24) % 24;
  const etM = now.getUTCMinutes();
  const inOpenWindow = etH === 9 && etM >= 30 && etM <= 35;

  const aboveMid    = bb ? data.price > bb.mid : null;
  const bbMidDist   = bb ? Math.abs(data.price - bb.mid) / bb.mid * 100 : null;
  const bbW         = bb?.width ?? 0;

  return {
    // ── Global ──────────────────────────────────────────────────────────────
    vol: {
      ok:  data.volLevel !== "BAJA",
      note:`Volatilidad ${data.volLevel} — BB width ${bbW.toFixed(1)}%`,
    },
    bbDir: {
      ok:  aboveMid !== null ? (isCall ? aboveMid : !aboveMid) : false,
      note:`Precio ${aboveMid?"sobre":"bajo"} BB mid $${f2(bb?.mid)}`,
    },
    ma20Dir: {
      ok:  data.ma20 != null ? (isCall ? data.price > data.ma20 : data.price < data.ma20) : false,
      note:`MA20 $${f2(data.ma20)}`,
    },
    ma40Dir: {
      ok:  data.ma40 != null ? (isCall ? data.price > data.ma40 : data.price < data.ma40) : false,
      note:`MA40 $${f2(data.ma40)}`,
    },
    volume: {
      ok:  data.avgVolume != null ? data.volume > data.avgVolume * 1.1 : false,
      note:`Vol ${data.avgVolume ? (data.volume / data.avgVolume * 100).toFixed(0) + "% del promedio" : "—"}`,
    },
    // ── Strategy-specific ───────────────────────────────────────────────────
    clearTrend: {
      ok: isCall
        ? (data.price > data.ma20 && data.ma20 > data.ma40)
        : (data.price < data.ma20 && data.ma20 < data.ma40),
      note: isCall ? "precio > MA20 > MA40" : "precio < MA20 < MA40",
    },
    bbMidTouch: {
      ok:   bbMidDist != null && bbMidDist < 1.0,
      note: bbMidDist != null ? `${bbMidDist.toFixed(2)}% de banda media` : "—",
    },
    lateralTrend: {
      ok:   bbW >= 2 && bbW < 4,
      note: `BB width ${bbW.toFixed(1)}% (necesita 2-4%)`,
    },
    prevLowVol: {
      ok:   data.prevLowVol === true,
      note: data.prevLowVol ? "BB estrecho ayer" : "BB no era estrecho ayer",
    },
    gapUp: {
      ok:   data.gap?.type === "UP",
      note: data.gap ? `GAP ${data.gap.type} ${f2(Math.abs(data.gap.pct))}%` : "Sin GAP hoy",
    },
    gapDown: {
      ok:   data.gap?.type === "DOWN",
      note: data.gap ? `GAP ${data.gap.type} ${f2(Math.abs(data.gap.pct))}%` : "Sin GAP hoy",
    },
    gapTime: {
      ok:   inOpenWindow,
      note: inOpenWindow ? "✓ 9:30–9:35 am ET" : `Ahora ${String(etH).padStart(2,"0")}:${String(etM).padStart(2,"0")} ET (fuera de ventana)`,
    },
    strongJump: {
      ok:   data.gap != null && Math.abs(data.gap.pct) > 1.5,
      note: data.gap ? `GAP ${f2(Math.abs(data.gap.pct))}% (necesita >1.5%)` : "Sin GAP",
    },
  };
}

// Returns [{id, label, type, ok, note}] + allOk + missing[]
function evalStrategy(strat, data, manuals) {
  const auto = evalAuto(data, strat);
  const get  = id => manuals[`s${strat.id}_${id}`] ?? null;

  const globalConds = [
    ...(strat.noHighVolRequired ? [] : [{ id:"vol",     label:"Volatilidad ALTA o EXTREMA",                   type:"auto" }]),
    { id:"bbDir",   label:`Precio ${strat.dir==="CALL"?"sobre":"bajo"} banda media BB`, type:"auto"   },
    { id:"ma20Dir", label:`MA20 en canal ${strat.dir==="CALL"?"alcista":"bajista"}`,     type:"auto"   },
    { id:"ma40Dir", label:`MA40 en canal ${strat.dir==="CALL"?"alcista":"bajista"}`,     type:"auto"   },
    { id:"horaVela",label:"Vela HORA cerrada en dirección correcta",                     type:"manual" },
    { id:"worden",  label:"Worden Stochastics cruzando en dirección correcta",           type:"manual" },
    { id:"volume",  label:"Volumen acompañando el movimiento",                           type:"auto"   },
  ];

  const conditions = [
    ...globalConds.map(c => {
      if (c.type === "auto") {
        const a = auto[c.id];
        return { ...c, ok: a?.ok ?? false, note: a?.note ?? "—" };
      }
      const v = get(c.id);
      return { ...c, ok: v === true, note: v === true ? "SE CUMPLE" : v === false ? "NO SE CUMPLE" : "Pendiente — marcar manualmente" };
    }),
    ...strat.specific.map(c => {
      if (c.type === "auto") {
        const a = auto[c.id];
        return { ...c, ok: a?.ok ?? false, note: a?.note ?? "—" };
      }
      const v = get(c.id);
      return { ...c, ok: v === true, note: v === true ? "SE CUMPLE" : v === false ? "NO SE CUMPLE" : "Pendiente — marcar manualmente" };
    }),
  ];

  const allOk   = data != null && conditions.every(c => c.ok);
  const missing  = conditions.filter(c => !c.ok).map(c => c.label);
  return { conditions, allOk, missing };
}

// Web Audio API alert (two rising tones)
function playSignalAlert() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    [[660, 0], [880, 0.2], [1100, 0.4]].forEach(([freq, t]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = "sine";
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.35);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.4);
    });
  } catch(e) { /* silent fail — browser may require user gesture */ }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
const load = (k,d) => { try { return JSON.parse(localStorage.getItem(k))??d; } catch { return d; } };
const save = (k,v) => localStorage.setItem(k, JSON.stringify(v));

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Ticker Selector ──────────────────────────────────────────────────────────
function TickerSelector({ selected, onApply, onClose }) {
  const [local, setLocal] = useState(selected);

  const toggle = sym => {
    if (local.includes(sym)) {
      setLocal(local.filter(s => s !== sym));
    } else if (local.length < CHUNK_SIZE) {
      setLocal([...local, sym]);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end justify-center z-50">
      <div className="bg-slate-800 rounded-t-2xl w-full max-w-lg border-t border-slate-600 shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center px-5 pt-5 pb-3">
          <div>
            <h3 className="text-white font-bold">Seleccionar Tickers</h3>
            <p className="text-slate-400 text-xs mt-0.5">
              <span className={local.length === CHUNK_SIZE ? "text-blue-400 font-semibold" : ""}>
                {local.length}/{CHUNK_SIZE}
              </span>{" "}seleccionados · máximo {CHUNK_SIZE} activos
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none transition-colors">×</button>
        </div>

        {/* Selected preview slots */}
        <div className="flex gap-2 px-5 pb-3">
          {Array(CHUNK_SIZE).fill(0).map((_, i) => {
            const sym = local[i];
            return sym ? (
              <div key={i} className="flex-1 bg-blue-900/40 border border-blue-700 rounded-xl px-2 py-2 text-center">
                <div className="text-blue-300 font-bold text-sm">{sym}</div>
                <button onClick={() => toggle(sym)} className="text-blue-700 hover:text-red-400 text-xs transition-colors">
                  quitar
                </button>
              </div>
            ) : (
              <div key={i} className="flex-1 border border-dashed border-slate-700 rounded-xl px-2 py-2 flex items-center justify-center">
                <span className="text-slate-700 text-xs">vacío</span>
              </div>
            );
          })}
        </div>

        {/* All tickers grid */}
        <div className="px-5 pb-3 max-h-52 overflow-y-auto">
          <div className="flex flex-wrap gap-2">
            {TICKERS.map(tk => {
              const sel  = local.includes(tk.sym);
              const full = local.length >= CHUNK_SIZE && !sel;
              return (
                <button key={tk.sym} onClick={() => !full && toggle(tk.sym)}
                  className={`px-3 py-2 rounded-xl text-xs font-bold transition-all border text-left
                    ${sel  ? "bg-blue-600 text-white border-blue-500"
                           : full ? "bg-slate-800 text-slate-600 border-slate-700 cursor-not-allowed opacity-40"
                                  : "bg-slate-700 text-slate-300 border-slate-600 hover:bg-slate-600"}`}>
                  <div>{tk.sym}</div>
                  {tk.range && (
                    <div className="text-xs opacity-60 font-normal">${tk.range[0]}–{tk.range[1]}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Apply */}
        <div className="px-5 pb-6">
          <button onClick={() => { onApply(local); onClose(); }}
            disabled={local.length === 0}
            className="w-full bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-bold py-3 rounded-xl transition-all disabled:opacity-40">
            Aplicar y cargar datos
          </button>
        </div>
      </div>
    </div>
  );
}

function ApiKeyModal({ onSave }) {
  const [val, setVal] = useState("");
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600 shadow-2xl">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <span className="text-xs font-black text-white">K</span>
          </div>
          <h2 className="text-white font-bold text-lg">Kaizen Trading</h2>
        </div>
        <p className="text-slate-400 text-sm mb-4">
          API key de <span className="text-blue-400 font-medium">polygon.io</span> para datos de mercado.
        </p>
        <input
          autoFocus
          className="w-full bg-slate-700 text-white rounded-xl px-4 py-3 text-sm border border-slate-600 focus:outline-none focus:border-blue-500 mb-3 placeholder-slate-500"
          placeholder="tu_api_key_de_polygon..."
          value={val} onChange={e=>setVal(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&val.trim()&&onSave(val.trim())}
        />
        <button disabled={!val.trim()} onClick={()=>onSave(val.trim())}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 rounded-xl transition-all disabled:opacity-40">
          Conectar
        </button>
        <p className="text-slate-600 text-xs text-center mt-3">La key se guarda solo en este dispositivo</p>
      </div>
    </div>
  );
}

// Banner de baja volatilidad
function VolAlert({ market, sym }) {
  const targets = sym ? [sym] : SYMS;
  const lowVol = targets.filter(s=>{
    const d=market[s]; return d?.bb && d.bb.width < LOW_VOL_PCT;
  });
  if (!lowVol.length) return null;
  return (
    <div className="bg-red-950 border border-red-800 rounded-xl px-3 py-2.5 mb-3 flex items-start gap-2">
      <span className="text-lg leading-none">🚫</span>
      <div>
        <div className="text-red-300 font-bold text-sm">NO ENTRAR — Sin volatilidad</div>
        <div className="text-red-500 text-xs mt-0.5">
          {lowVol.join(", ")} — BB width {'<'} {LOW_VOL_PCT}%
        </div>
      </div>
    </div>
  );
}

// Countdown banner shown between groups
function CountdownBanner({ cd }) {
  if (!cd) return null;
  const pct = ((INTER_DELAY - cd.remaining) / INTER_DELAY) * 100;
  return (
    <div className="bg-amber-950 border border-amber-800 rounded-xl px-3 py-3 mb-3">
      <div className="flex items-center gap-3 mb-2">
        {/* Circular countdown */}
        <div className="relative w-10 h-10 shrink-0">
          <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="#451a03" strokeWidth="4"/>
            <circle cx="20" cy="20" r="16" fill="none" stroke="#f59e0b" strokeWidth="4"
              strokeDasharray={`${2*Math.PI*16}`}
              strokeDashoffset={`${2*Math.PI*16*(1-pct/100)}`}
              strokeLinecap="round"
              style={{transition:"stroke-dashoffset 0.9s linear"}}/>
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-amber-300 font-bold text-xs">
            {cd.remaining}s
          </span>
        </div>
        <div>
          <div className="text-amber-300 font-bold text-sm">
            Cargando grupo {cd.nextGroup} de {cd.totalGroups}…
          </div>
          <div className="text-amber-600 text-xs">
            Esperando {cd.remaining}s para respetar límites de la API
          </div>
        </div>
      </div>
      {/* Linear progress bar */}
      <div className="h-1 bg-amber-950 rounded-full overflow-hidden border border-amber-900">
        <div className="h-full bg-amber-500 rounded-full transition-all duration-1000 ease-linear"
          style={{width:`${pct}%`}}/>
      </div>
    </div>
  );
}

function BBBar({ price, bb:BB }) {
  if (!BB) return null;
  const pct = Math.min(100,Math.max(0,(price-BB.lower)/(BB.upper-BB.lower)*100));
  return (
    <div className="mt-2">
      <div className="relative h-1.5 bg-slate-700 rounded-full overflow-visible">
        <div className="absolute inset-0 rounded-full bg-gradient-to-r from-green-500 via-yellow-400 to-red-500 opacity-50"/>
        <div className="absolute top-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-slate-900 shadow"
          style={{left:`${pct}%`,transform:"translate(-50%,-50%)"}}/>
      </div>
      <div className="flex justify-between text-xs text-slate-600 mt-1">
        <span>${f2(BB.lower)}</span>
        <span className="text-slate-500">${f2(BB.mid)}</span>
        <span>${f2(BB.upper)}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: MERCADO
// ═══════════════════════════════════════════════════════════════════════════════
function TickerRow({ tk, data, loading, error, expanded, onToggle }) {
  if (loading && !data) return (
    <div className="bg-slate-800 rounded-xl px-3 py-2.5 border border-slate-700/50 animate-pulse">
      <div className="flex gap-2">
        <div className="h-4 w-14 bg-slate-700 rounded"/>
        <div className="h-4 w-20 bg-slate-700 rounded ml-auto"/>
      </div>
    </div>
  );
  if (!data && error) return (
    <div className="bg-slate-800/60 rounded-xl px-3 py-2 border border-red-900/40 text-xs text-red-500">
      {tk.sym}: {error}
    </div>
  );
  if (!data) return null;

  const up     = data.changePct >= 0;
  const isLow  = data.bb && data.bb.width < LOW_VOL_PCT;

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700/50 overflow-hidden">
      <button className="w-full px-3 py-2.5 flex items-center gap-2 text-left" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-white font-bold text-sm">{tk.sym}</span>
            {isLow && <span title="Baja volatilidad">🚫</span>}
            {data.gap && (
              <span className={`text-xs font-bold ${data.gap.type==="UP"?"text-green-400":"text-red-400"}`}>
                {data.gap.type==="UP"?"↑GAP":"↓GAP"}
              </span>
            )}
          </div>
          <div className="text-slate-500 text-xs truncate">{tk.name}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-white font-mono text-sm">${f2(data.price)}</div>
          <div className={`text-xs ${up?"text-green-400":"text-red-400"}`}>{fpct(data.changePct)}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-1">
          <span className={`text-xs px-1.5 py-0.5 rounded-md font-bold ${data.signal.bg} ${data.signal.color}`}>
            {data.signal.label}
          </span>
        </div>
        <span className="text-slate-600 text-xs ml-1">{expanded?"▲":"▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-700/40 px-3 py-3 space-y-2">
          <div className="grid grid-cols-4 gap-1.5 text-xs">
            {[["Apert.",data.open],["Máx.",data.high],["Mín.",data.low],["Vol",null]].map(([l,v],i)=>(
              <div key={i} className="bg-slate-700/50 rounded-lg px-2 py-1.5 text-center">
                <div className="text-slate-500 leading-none mb-0.5">{l}</div>
                <div className="text-slate-200">{i===3?fvol(data.volume):`$${f2(v)}`}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            <div className="bg-slate-700/50 rounded-lg px-2 py-1.5">
              <span className="text-slate-500">MA20 </span>
              <span className={data.price>data.ma20?"text-green-400":"text-red-400"}>${f2(data.ma20)}</span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-2 py-1.5">
              <span className="text-slate-500">MA50 </span>
              <span className={data.price>data.ma50?"text-green-400":"text-red-400"}>${f2(data.ma50)}</span>
            </div>
          </div>
          {tk.range && (
            <div className="text-xs px-3 py-1.5 rounded-lg flex justify-between bg-slate-700/50 text-slate-400">
              <span>Rango Ask contrato</span>
              <span className="text-slate-300">${tk.range[0].toFixed(2)} – ${tk.range[1].toFixed(2)}</span>
            </div>
          )}
          {isLow && (
            <div className="bg-red-950 border border-red-800 rounded-lg px-2 py-1.5 text-xs text-red-300">
              🚫 BB muy estrecho ({f2(data.bb.width)}%) — baja volatilidad
            </div>
          )}
          <BBBar price={data.price} bb={data.bb}/>
        </div>
      )}
    </div>
  );
}

function TabMercado({ market, loading, errors, onRefresh, selectedTickers, countdown, onOpenSelector }) {
  const [expanded, setExpanded] = useState(null);
  const activeTickers = TICKERS.filter(tk => selectedTickers.includes(tk.sym));

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-1">
        <h2 className="text-white font-bold">Mercado en Vivo</h2>
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-slate-500 text-xs animate-pulse">cargando…</span>
          )}
          <button onClick={onOpenSelector}
            className="bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1">
            ☰ <span>{selectedTickers.length}/{CHUNK_SIZE}</span>
          </button>
          <button onClick={onRefresh} disabled={loading || !!countdown}
            className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 text-sm transition-colors font-mono min-w-[2.5rem] text-right">
            {countdown ? `${countdown.remaining}s` : "↻"}
          </button>
        </div>
      </div>

      <VolAlert market={market}/>
      <CountdownBanner cd={countdown}/>

      {activeTickers.length === 0 && (
        <div className="text-center py-10">
          <p className="text-slate-500 text-sm mb-3">No hay tickers seleccionados.</p>
          <button onClick={onOpenSelector}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-5 py-2 rounded-xl font-semibold transition-colors">
            Seleccionar tickers
          </button>
        </div>
      )}

      {activeTickers.map(tk => (
        <TickerRow key={tk.sym} tk={tk} data={market[tk.sym]} loading={loading}
          error={errors[tk.sym]} expanded={expanded===tk.sym}
          onToggle={() => setExpanded(v => v === tk.sym ? null : tk.sym)}/>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: SEÑAL
// ═══════════════════════════════════════════════════════════════════════════════
// ─── Single strategy card ─────────────────────────────────────────────────────
function StrategyCard({ strat, data, manuals, onToggle, confirmedRef }) {
  const { conditions, allOk, missing } = evalStrategy(strat, data, manuals);
  const isCall = strat.dir === "CALL";
  const blocked = data?.volLevel === "BAJA" && !strat.noHighVolRequired;

  // Fire alert sound once per confirmation
  const wasOkRef = React.useRef(false);
  React.useEffect(() => {
    if (allOk && !wasOkRef.current) { playSignalAlert(); wasOkRef.current = true; }
    if (!allOk) wasOkRef.current = false;
  }, [allOk]);

  const [open, setOpen] = React.useState(false);

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all
      ${allOk
        ? "border-green-500 bg-green-950/40 shadow-lg shadow-green-900/30"
        : blocked
        ? "border-red-900/60 bg-slate-800/60 opacity-60"
        : "border-slate-700/50 bg-slate-800"}`}>

      {/* ── Header row ── */}
      <button className="w-full px-4 py-3 flex items-center gap-2 text-left" onClick={() => setOpen(o => !o)}>
        <div className="shrink-0 text-lg leading-none">
          {allOk ? "🟢" : blocked ? "🚫" : "⛔"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-black text-sm ${allOk ? "text-green-300" : "text-white"}`}>
              E{strat.id}: {strat.name}
            </span>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded
              ${isCall ? "bg-green-900/60 text-green-400" : "bg-red-900/60 text-red-400"}`}>
              {strat.dir}
            </span>
          </div>
          {allOk
            ? <div className="text-green-400 text-xs font-semibold mt-0.5">SEÑAL CONFIRMADA — COMPRAR {strat.dir}</div>
            : blocked
            ? <div className="text-red-500 text-xs mt-0.5">Bloqueada — baja volatilidad</div>
            : <div className="text-slate-500 text-xs mt-0.5">{missing.length} condición{missing.length !== 1 ? "es" : ""} faltante{missing.length !== 1 ? "s" : ""}</div>
          }
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-slate-600 text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* ── CONFIRMED banner ── */}
      {allOk && (
        <div className="mx-4 mb-3 bg-green-500/20 border border-green-500/50 rounded-xl px-4 py-3 text-center">
          <div className="text-green-300 text-xl font-black tracking-wide">🟢 SEÑAL CONFIRMADA</div>
          <div className="text-green-200 font-bold mt-0.5">{strat.name}</div>
          <div className="text-white text-2xl font-black mt-1">COMPRAR {strat.dir} 🚀</div>
          <button onClick={playSignalAlert}
            className="mt-2 text-xs text-green-600 hover:text-green-400 transition-colors">
            🔊 Reproducir alerta
          </button>
        </div>
      )}

      {/* ── Expanded conditions ── */}
      {open && (
        <div className="border-t border-slate-700/40 px-4 py-3 space-y-1.5">
          {/* Section headers */}
          {["global", "specific"].map(section => {
            const sectionConds = conditions.filter((_, i) =>
              section === "global"
                ? i < conditions.length - strat.specific.length
                : i >= conditions.length - strat.specific.length
            );
            return (
              <div key={section}>
                <div className="text-slate-600 text-xs uppercase tracking-wider mb-1.5 mt-1">
                  {section === "global" ? "Condiciones Globales" : "Condiciones Específicas"}
                </div>
                {sectionConds.map(cond => (
                  <div key={cond.id}
                    className={`rounded-xl px-3 py-2 mb-1 flex items-start gap-2.5
                      ${cond.ok
                        ? "bg-green-900/20 border border-green-900/40"
                        : "bg-red-900/10 border border-red-900/30"}`}>
                    <span className={`text-base leading-none mt-0.5 shrink-0 ${cond.ok ? "text-green-400" : "text-red-400"}`}>
                      {cond.ok ? "✅" : "❌"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium ${cond.ok ? "text-green-300" : "text-slate-300"}`}>
                        {cond.label}
                      </div>
                      <div className="text-slate-500 text-xs mt-0.5">{cond.note}</div>
                    </div>
                    {/* Manual toggle */}
                    {cond.type === "manual" && (
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => onToggle(`s${strat.id}_${cond.id}`, true)}
                          className={`w-7 h-7 rounded-lg text-xs font-bold transition-all
                            ${manuals[`s${strat.id}_${cond.id}`] === true
                              ? "bg-green-600 text-white" : "bg-slate-700 text-slate-500"}`}>
                          ✓
                        </button>
                        <button
                          onClick={() => onToggle(`s${strat.id}_${cond.id}`, false)}
                          className={`w-7 h-7 rounded-lg text-xs font-bold transition-all
                            ${manuals[`s${strat.id}_${cond.id}`] === false
                              ? "bg-red-600 text-white" : "bg-slate-700 text-slate-500"}`}>
                          ✗
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          {/* Missing list */}
          {!allOk && missing.length > 0 && (
            <div className="mt-2 bg-slate-900/60 rounded-xl px-3 py-2.5 border border-slate-700/40">
              <div className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1.5">
                ⛔ Sin señal — Falta:
              </div>
              {missing.map(m => (
                <div key={m} className="text-red-400 text-xs flex gap-1.5 mb-0.5">
                  <span className="shrink-0">•</span><span>{m}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TAB: SEÑAL ──────────────────────────────────────────────────────────────
const LS_MANUALS = "kz_manuals";

function TabSenial({ market, selectedTickers }) {
  const syms = selectedTickers.length > 0 ? selectedTickers : [];
  const [sym, setSym] = React.useState(() => syms[0] ?? SYMS[0]);
  const [manuals, setManuals] = React.useState(() => load(LS_MANUALS, {}));

  // Keep sym valid when selection changes
  React.useEffect(() => {
    if (!syms.includes(sym) && syms.length > 0) setSym(syms[0]);
  }, [syms.join(",")]); // eslint-disable-line

  const data = market[sym];

  const toggle = (key, val) => {
    setManuals(prev => {
      const next = { ...prev, [key]: prev[key] === val ? null : val };
      save(LS_MANUALS, next);
      return next;
    });
  };

  const resetSym = () => {
    const next = Object.fromEntries(
      Object.entries(manuals).filter(([k]) => !k.startsWith("s") || !STRATS.some(s => k.startsWith(`s${s.id}_`)))
    );
    // Actually just clear all manuals for current sym strategies
    const cleared = { ...manuals };
    STRATS.forEach(s => s.specific.forEach(c => { delete cleared[`s${s.id}_${c.id}`]; }));
    // Also clear global manuals
    STRATS.forEach(s => {
      ["horaVela","worden"].forEach(k => delete cleared[`s${s.id}_${k}`]);
    });
    setManuals(cleared);
    save(LS_MANUALS, cleared);
  };

  const confirmedStrats = STRATS.filter(s => {
    const { allOk } = evalStrategy(s, data, manuals);
    return allOk;
  });

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-white font-bold">Señales — 8 Estrategias</h2>
        <button onClick={resetSym}
          className="text-slate-600 hover:text-red-400 text-xs transition-colors">
          Reiniciar manuales
        </button>
      </div>

      {/* Ticker selector */}
      {syms.length > 0 && (
        <div className="flex gap-2">
          {syms.map(s => (
            <button key={s} onClick={() => setSym(s)}
              className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all
                ${sym === s ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 border border-slate-700"}`}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* No data state */}
      {!data && (
        <div className="bg-slate-800 rounded-2xl p-6 border border-slate-700/50 text-center">
          <div className="text-slate-500 text-sm">
            {Object.keys(market).length === 0
              ? "Esperando datos de mercado…"
              : `Sin datos para ${sym}`}
          </div>
        </div>
      )}

      {/* Global volatility block */}
      {data?.volLevel === "BAJA" && (
        <div className="bg-red-950 border-2 border-red-700 rounded-2xl px-4 py-4 text-center">
          <div className="text-4xl mb-1">🚫</div>
          <div className="text-red-300 font-black text-lg">VOLATILIDAD BAJA</div>
          <div className="text-red-400 text-sm mt-1">
            BB width {data.bb?.width.toFixed(1)}% — todas las estrategias bloqueadas
          </div>
          <div className="text-red-600 text-xs mt-2">
            Regla absoluta: sin volatilidad ALTA o EXTREMA = NO HAY SEÑAL
          </div>
        </div>
      )}

      {/* Summary bar when signals found */}
      {confirmedStrats.length > 0 && (
        <div className="bg-green-950 border-2 border-green-600 rounded-2xl px-4 py-3 animate-pulse">
          <div className="text-green-300 font-black text-center">
            🟢 {confirmedStrats.length} SEÑAL{confirmedStrats.length > 1 ? "ES" : ""} CONFIRMADA{confirmedStrats.length > 1 ? "S" : ""}
          </div>
          <div className="text-green-400 text-xs text-center mt-1">
            {confirmedStrats.map(s => `E${s.id} ${s.dir}`).join(" · ")}
          </div>
        </div>
      )}

      {/* Market snapshot for context */}
      {data && (
        <div className="bg-slate-800/60 rounded-xl px-3 py-2 border border-slate-700/40 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-slate-500">Precio</div>
            <div className="text-white font-mono font-bold">${f2(data.price)}</div>
          </div>
          <div>
            <div className="text-slate-500">Volatilidad</div>
            <div className={`font-bold ${data.volLevel==="BAJA"?"text-red-400":data.volLevel==="EXTREMA"?"text-orange-400":"text-green-400"}`}>
              {data.volLevel} ({data.bb?.width.toFixed(1)}%)
            </div>
          </div>
          <div>
            <div className="text-slate-500">GAP hoy</div>
            <div className={`font-bold ${data.gap?.type==="UP"?"text-green-400":data.gap?.type==="DOWN"?"text-red-400":"text-slate-400"}`}>
              {data.gap ? `${data.gap.type} ${f2(Math.abs(data.gap.pct))}%` : "Sin GAP"}
            </div>
          </div>
        </div>
      )}

      {/* 8 strategy cards */}
      {data && STRATS.map(strat => (
        <StrategyCard
          key={strat.id}
          strat={strat}
          data={data}
          manuals={manuals}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════════
const emptyTradeReg = () => ({
  fechaExp:"", tipo:"CALL", fecha:today(), hora:nowT(),
  contratos:"", tradePrice:"", rentabilidad:"", plan:"10%",
});

function TradeRegister({ num, value, onChange }) {
  const set = k => e => onChange({...value, [k]:e.target.value});
  const total = parseFloat(value.contratos||0)*parseFloat(value.tradePrice||0)*100;
  return (
    <div className="bg-slate-700/40 rounded-xl p-3 border border-slate-600/40">
      <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">
        Registro #{num}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-slate-500 text-xs block mb-1">Fecha Exp.</label>
          <input type="date" value={value.fechaExp} onChange={set("fechaExp")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Tipo</label>
          <div className="flex gap-1">
            {["CALL","PUT"].map(t=>(
              <button key={t} onClick={()=>onChange({...value,tipo:t})}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${value.tipo===t?(t==="CALL"?"bg-green-600 text-white":"bg-red-600 text-white"):"bg-slate-700 text-slate-400"}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Fecha</label>
          <input type="date" value={value.fecha} onChange={set("fecha")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Hora</label>
          <input type="time" value={value.hora} onChange={set("hora")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">N° Contratos</label>
          <input type="number" value={value.contratos} onChange={set("contratos")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Trade Price</label>
          <input type="number" step="0.01" value={value.tradePrice} onChange={set("tradePrice")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Rentabilidad $</label>
          <input type="number" step="0.01" value={value.rentabilidad} onChange={set("rentabilidad")}
            className={`w-full rounded-lg px-2 py-1.5 text-xs border focus:outline-none font-mono
              ${parseFloat(value.rentabilidad||0)>=0
                ?"bg-green-900/20 text-green-300 border-green-800"
                :"bg-red-900/20 text-red-300 border-red-800"}`}/>
        </div>
        <div>
          <label className="text-slate-500 text-xs block mb-1">Plan %</label>
          <select value={value.plan} onChange={set("plan")}
            className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600">
            {["10%","35%","100%"].map(p=><option key={p}>{p}</option>)}
          </select>
        </div>
      </div>
      {value.contratos && value.tradePrice && (
        <div className="mt-2 bg-slate-700/50 rounded-lg px-2 py-1.5 flex justify-between text-xs">
          <span className="text-slate-400">Valor total (×100)</span>
          <span className="text-white font-mono">${total.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function TabCheck({ market }) {
  const [sym,      setSym]      = useState("TSLA");
  const [checks,   setChecks]   = useState(()=>load(LS.CHECK,{}));
  const [tradeRegs,setTradeRegs]= useState(()=>load(LS.TREG,{1:emptyTradeReg(),2:emptyTradeReg()}));
  const [bid,      setBid]      = useState("");
  const [ask,      setAsk]      = useState("");
  const [spot,     setSpot]     = useState("");
  const [strike,   setStrike]   = useState("");

  const d      = market[sym];
  const isLow  = d?.bb && d.bb.width < LOW_VOL_PCT;
  const bbPos  = d?.bb ? (d.price-d.bb.lower)/(d.bb.upper-d.bb.lower)*100 : null;

  const getC = k => checks[`${sym}::${k}`] ?? null;
  const setC = (k,v) => {
    const next={...checks,[`${sym}::${k}`]:v};
    setChecks(next); save(LS.CHECK,next);
  };
  const setTR = (n,v) => {
    const next={...tradeRegs,[n]:v}; setTradeRegs(next); save(LS.TREG,next);
  };

  const bidAskPct = bid && ask ? (parseFloat(ask)-parseFloat(bid))/parseFloat(bid)*100 : null;
  const bidAskOk  = bidAskPct != null && bidAskPct <= 5;

  const dow    = new Date().getDay();  // 0=Sun 1=Mon ... 6=Sat
  const todayDTE = dow>=1&&dow<=5 ? DTES[dow-1] : null;

  const gapAuto = d?.gap;

  const Toggle = ({ label, sub, cKey, auto, autoTrue, autoFalse }) => {
    const val      = getC(cKey);
    const effective = auto !== undefined ? auto : val;
    return (
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="flex justify-between items-start gap-2">
          <div className="flex-1">
            <div className="text-slate-200 text-xs font-medium">{label}</div>
            {sub && <div className="text-slate-500 text-xs mt-0.5">{sub}</div>}
          </div>
          {auto !== undefined ? (
            <span className={`text-xs px-2 py-1 rounded-lg font-bold shrink-0
              ${effective===true?"bg-green-900/50 text-green-400":effective===false?"bg-red-900/50 text-red-400":"bg-slate-700 text-slate-500"}`}>
              {effective===true?(autoTrue||"✓ AUTO"):effective===false?(autoFalse||"✗ AUTO"):"—"}
            </span>
          ) : (
            <div className="flex gap-1 shrink-0">
              <button onClick={()=>setC(cKey,true)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${val===true?"bg-green-600 text-white":"bg-slate-700 text-slate-500"}`}>
                ✓
              </button>
              <button onClick={()=>setC(cKey,false)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${val===false?"bg-red-600 text-white":"bg-slate-700 text-slate-500"}`}>
                ✗
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const checkSummary = [
    ["FED (45 días)",   getC("fed")],
    ["Earnings",        getC("earnings")],
    ["BB 15min",        getC("bb15")],
    ["BB 1H",           getC("bb1h")],
    ["BB Diario",       bbPos!=null?(bbPos>20&&bbPos<80):null],
    ["MA Hora",         getC("maH")],
    ["MA Diario",       d?(d.price>d.ma20&&d.price>d.ma50):null],
    ["Línea tendencia", getC("trend")],
    ["GAP",             gapAuto!==null?true:false],
    ["BID-ASK ≤5%",     bidAskOk||null],
  ];
  const cumple = checkSummary.filter(([,v])=>v===true).length;
  const total  = checkSummary.length;

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="text-white font-bold">Checklist Oficial</h2>
        <button onClick={()=>{setChecks({});save(LS.CHECK,{});}}
          className="text-slate-600 hover:text-red-400 text-xs transition-colors">
          Reiniciar
        </button>
      </div>

      {/* Symbol selector */}
      <div className="flex flex-wrap gap-1.5">
        {TICKERS.map(tk=>(
          <button key={tk.sym} onClick={()=>setSym(tk.sym)}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${sym===tk.sym?"bg-blue-600 text-white":"bg-slate-800 text-slate-400 border border-slate-700"}`}>
            {tk.sym}
          </button>
        ))}
      </div>

      {/* Score bar */}
      <div className={`rounded-xl px-3 py-2 flex justify-between items-center text-sm font-bold
        ${cumple>=7?"bg-green-900/30 text-green-400 border border-green-900/40":
          cumple>=5?"bg-yellow-900/30 text-yellow-400 border border-yellow-900/40":
          "bg-red-900/30 text-red-400 border border-red-900/40"}`}>
        <span>{sym} — {cumple}/{total} SE CUMPLEN</span>
        <span>{cumple>=7?"✓ ENTRADA OK":cumple>=5?"⚠ REVISAR":"✗ NO ENTRAR"}</span>
      </div>

      {isLow && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-3 py-2.5 flex items-center gap-2">
          <span>🚫</span>
          <div>
            <div className="text-red-300 font-bold text-sm">NO ENTRAR — Sin volatilidad</div>
            <div className="text-red-500 text-xs">BB width: {d.bb.width.toFixed(2)}%</div>
          </div>
        </div>
      )}

      {/* 1. FED */}
      <div className="text-slate-500 text-xs uppercase tracking-wider px-1 mt-1">Condiciones de Mercado</div>

      <Toggle cKey="fed" label="1. Reunión FED" sub="Cada 45 días — verificar calendario FOMC"/>
      <Toggle cKey="earnings" label="2. Earnings" sub={`${sym} — cada 3 meses. Verificar fecha próxima`}/>

      {/* 3. Bollinger */}
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="text-slate-200 text-xs font-medium mb-2">3. Bollinger Bands 15min / 1H / Diario</div>
        {bbPos!=null && (
          <div className={`text-xs font-semibold mb-2 ${bbPos<30?"text-green-400":bbPos>70?"text-red-400":"text-yellow-400"}`}>
            Diario %B: {bbPos.toFixed(0)}% — {bbPos<30?"Cerca soporte (Lower)":bbPos>70?"Cerca resistencia (Upper)":"Zona media"}
            {" · "}BB: ${f2(d.bb.lower)} / ${f2(d.bb.mid)} / ${f2(d.bb.upper)}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {[["15min","bb15"],["1H","bb1h"]].map(([lbl,k])=>(
            <div key={k}>
              <div className="text-slate-500 text-xs mb-1">{lbl} (manual)</div>
              <div className="flex gap-1">
                <button onClick={()=>setC(k,true)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${getC(k)===true?"bg-green-600 text-white":"bg-slate-700 text-slate-500"}`}>✓</button>
                <button onClick={()=>setC(k,false)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${getC(k)===false?"bg-red-600 text-white":"bg-slate-700 text-slate-500"}`}>✗</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. MA */}
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="text-slate-200 text-xs font-medium mb-2">4. Promedios Móviles — Techos/Pisos</div>
        {d && (
          <div className="space-y-1 text-xs mb-2">
            {[["MA20 Diario",d.price>d.ma20,"↑ Sobre MA20 $"+f2(d.ma20),"↓ Bajo MA20 $"+f2(d.ma20)],
              ["MA50 Diario",d.price>d.ma50,"↑ Sobre MA50 $"+f2(d.ma50),"↓ Bajo MA50 $"+f2(d.ma50)]].map(([l,ok,okTxt,nokTxt])=>(
              <div key={l} className="flex justify-between">
                <span className="text-slate-500">{l}</span>
                <span className={ok?"text-green-400":"text-red-400"}>{ok?okTxt:nokTxt}</span>
              </div>
            ))}
          </div>
        )}
        <div>
          <div className="text-slate-500 text-xs mb-1">MA Hora (manual)</div>
          <div className="flex gap-1">
            <button onClick={()=>setC("maH",true)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${getC("maH")===true?"bg-green-600 text-white":"bg-slate-700 text-slate-500"}`}>✓</button>
            <button onClick={()=>setC("maH",false)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${getC("maH")===false?"bg-red-600 text-white":"bg-slate-700 text-slate-500"}`}>✗</button>
          </div>
        </div>
      </div>

      <Toggle cKey="trend" label="5. Ruptura de línea de tendencia" sub="Analizar en gráfico — ¿hay ruptura confirmada?"/>

      {/* 6. GAP auto */}
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-slate-200 text-xs font-medium">6. Salto GAP al alza / a la baja</div>
            {gapAuto ? (
              <div className={`text-xs font-bold mt-1 ${gapAuto.type==="UP"?"text-green-400":"text-red-400"}`}>
                AUTO: GAP {gapAuto.type==="UP"?"↑ al alza":"↓ a la baja"} — {f2(Math.abs(gapAuto.pct))}%
              </div>
            ) : (
              <div className="text-xs text-slate-500 mt-1">AUTO: Sin GAP significativo ({">"}0.5%)</div>
            )}
          </div>
          <span className={`text-xs px-2 py-1 rounded-lg font-bold shrink-0
            ${gapAuto?"bg-yellow-900/50 text-yellow-300":"bg-slate-700 text-slate-500"}`}>
            {gapAuto?`GAP ${gapAuto.type}`:"Sin GAP"}
          </span>
        </div>
      </div>

      {/* 7. BID-ASK */}
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="text-slate-200 text-xs font-medium mb-2">7. Precio BID – ASK (máx. 5%)</div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-slate-500 text-xs block mb-1">BID $</label>
            <input type="number" step="0.01" value={bid} onChange={e=>setBid(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
          </div>
          <div>
            <label className="text-slate-500 text-xs block mb-1">ASK $</label>
            <input type="number" step="0.01" value={ask} onChange={e=>setAsk(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
          </div>
          <div>
            <label className="text-slate-500 text-xs block mb-1">Spread</label>
            <div className={`rounded-lg px-2 py-1.5 text-xs font-bold text-center border
              ${bidAskPct==null?"bg-slate-700/50 text-slate-500 border-slate-600":
                bidAskOk?"bg-green-900/30 text-green-400 border-green-800":
                "bg-red-900/30 text-red-400 border-red-800"}`}>
              {bidAskPct==null?"—":bidAskPct.toFixed(1)+"%"}
            </div>
          </div>
        </div>
        {bidAskPct!=null && (
          <div className={`text-xs mt-2 font-semibold ${bidAskOk?"text-green-400":"text-red-400"}`}>
            {bidAskOk?"✓ Spread aceptable":"✗ Spread demasiado amplio — evitar entrada"}
          </div>
        )}
      </div>

      {/* 8. Spot/Strike por día */}
      <div className="bg-slate-800/80 rounded-xl p-3 border border-slate-700/40">
        <div className="text-slate-200 text-xs font-medium mb-2">8. Distancia / Spot Price / Strike Price</div>
        <div className="grid grid-cols-5 gap-1 mb-3">
          {DAYS.map((day,i)=>(
            <div key={day} className={`text-center rounded-lg py-2 ${dow===i+1?"bg-blue-900/60 border border-blue-700":"bg-slate-700/40"}`}>
              <div className={`text-xs font-bold ${dow===i+1?"text-blue-300":"text-slate-500"}`}>{day.slice(0,3)}</div>
              <div className={`text-xs ${dow===i+1?"text-blue-400":"text-slate-600"}`}>DTE {DTES[i]}</div>
            </div>
          ))}
        </div>
        {todayDTE && (
          <div className="text-xs text-blue-400 mb-2 font-medium">
            Hoy {DAYS[dow-1]}: DTE recomendado = {todayDTE} días
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-slate-500 text-xs block mb-1">Spot Price $</label>
            <input type="number" step="0.01" value={spot} onChange={e=>setSpot(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
          </div>
          <div>
            <label className="text-slate-500 text-xs block mb-1">Strike Price $</label>
            <input type="number" step="0.01" value={strike} onChange={e=>setStrike(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-lg px-2 py-1.5 text-xs border border-slate-600 focus:outline-none"/>
          </div>
        </div>
        {spot && strike && (
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
            <div className="bg-slate-700/50 rounded-lg px-2 py-1.5 flex justify-between">
              <span className="text-slate-400">Distancia $</span>
              <span className="text-white font-mono">${Math.abs(parseFloat(strike)-parseFloat(spot)).toFixed(2)}</span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-2 py-1.5 flex justify-between">
              <span className="text-slate-400">Distancia %</span>
              <span className="text-white font-mono">
                {(Math.abs(parseFloat(strike)-parseFloat(spot))/parseFloat(spot)*100).toFixed(1)}%
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Resumen */}
      <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60">
        <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">
          Resumen — {sym}
        </div>
        {checkSummary.map(([lbl,val])=>(
          <div key={lbl} className="flex justify-between py-0.5 border-b border-slate-700/30 last:border-0">
            <span className="text-slate-400 text-xs">{lbl}</span>
            <span className={`text-xs font-bold ${val===true?"text-green-400":val===false?"text-red-400":"text-slate-600"}`}>
              {val===true?"SE CUMPLE":val===false?"NO SE CUMPLE":"—"}
            </span>
          </div>
        ))}
      </div>

      {/* Trade registers 9 & 10 */}
      <div className="text-slate-500 text-xs uppercase tracking-wider px-1 mt-1">Registros de Trade</div>
      <TradeRegister num={1} value={tradeRegs[1]||emptyTradeReg()} onChange={v=>setTR(1,v)}/>
      <TradeRegister num={2} value={tradeRegs[2]||emptyTradeReg()} onChange={v=>setTR(2,v)}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: CALC
// ═══════════════════════════════════════════════════════════════════════════════
function TabCalc({ market }) {
  const [sym,    setSym]    = useState("TSLA");
  const [entry,  setEntry]  = useState("");
  const [shares, setShares] = useState("");
  const [comm,   setComm]   = useState("2");

  const tk        = TICKER_MAP[sym];
  const livePrice = market[sym]?.price;
  const E  = parseFloat(entry)  || 0;
  const S  = parseFloat(shares) || 0;
  const C  = parseFloat(comm)   || 0;
  const d  = market[sym];
  const isLow  = d?.bb && d.bb.width < LOW_VOL_PCT;
  // inRange: user-entered Ask price vs option contract range (correct comparison)
  const inRange = tk.range && E>0 ? E>=tk.range[0] && E<=tk.range[1] : null;

  return (
    <div className="space-y-4">
      <h2 className="text-white font-bold">Calculadora de Objetivos</h2>

      {isLow && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-3 py-2 flex items-center gap-2">
          <span>🚫</span>
          <span className="text-red-300 text-sm font-bold">NO ENTRAR — Sin volatilidad</span>
        </div>
      )}

      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60 space-y-3">
        {/* Symbol selector — scrollable row */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {TICKERS.map(t=>(
            <button key={t.sym} onClick={()=>setSym(t.sym)}
              className={`shrink-0 px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all ${sym===t.sym?"bg-blue-600 text-white":"bg-slate-700 text-slate-400 hover:bg-slate-600"}`}>
              {t.sym}
            </button>
          ))}
        </div>

        {/* Range badge — shows optimal Ask range for this ticker's contract */}
        {tk.range && (
          <div className="flex justify-between items-center text-xs px-3 py-2 rounded-xl border bg-slate-700/50 border-slate-600/50">
            <div>
              <div className="font-bold text-slate-300">Rango Ask contrato óptimo</div>
              <div className="text-slate-500 mt-0.5">${tk.range[0].toFixed(2)} – ${tk.range[1].toFixed(2)}</div>
            </div>
            {livePrice && (
              <div className="text-slate-400 font-mono text-sm">${f2(livePrice)}</div>
            )}
          </div>
        )}

        {/* Entry */}
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Precio de Entrada ($)</label>
          <div className="flex gap-2">
            <input type="number" step="0.01" placeholder="0.00"
              className={`flex-1 bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border focus:outline-none
                ${inRange===true?"border-green-600":inRange===false?"border-red-600":"border-slate-600 focus:border-blue-500"}`}
              value={entry} onChange={e=>setEntry(e.target.value)}/>
            {livePrice && (
              <button onClick={()=>setEntry(f2(livePrice))}
                className="bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 text-xs px-3 rounded-xl transition-all font-mono whitespace-nowrap">
                ${f2(livePrice)}
              </button>
            )}
          </div>
          {inRange!==null && E>0 && (
            <div className={`text-xs mt-1 ${inRange?"text-green-400":"text-red-400"}`}>
              {inRange?"✓ Entrada dentro del rango óptimo":"✗ Entrada fuera del rango óptimo"}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Acciones / Contratos</label>
            <input type="number" placeholder="0"
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none"
              value={shares} onChange={e=>setShares(e.target.value)}/>
          </div>
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Comisión ($)</label>
            <input type="number" step="0.50"
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none"
              value={comm} onChange={e=>setComm(e.target.value)}/>
          </div>
        </div>

        {E>0 && S>0 && (
          <div className="bg-slate-700/50 rounded-xl px-3 py-2 flex justify-between text-xs">
            <span className="text-slate-400">Capital invertido</span>
            <span className="text-white font-semibold">${(E*S).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
          </div>
        )}
      </div>

      {E>0 && (
        <div className="space-y-3">
          {PLANS.map(plan=>{
            const target   = E*(1+plan.pct);
            const raw      = (target-E)*S;
            const net      = raw-C;
            return (
              <div key={plan.id} className={`bg-gradient-to-br ${plan.from} ${plan.to} rounded-2xl p-4 shadow-lg`}>
                <div className="flex justify-between items-center">
                  <span className="text-white font-bold">{plan.label}</span>
                  <span className="text-white/70 text-sm font-mono">+{(plan.pct*100).toFixed(0)}%</span>
                </div>
                <div className="text-white text-3xl font-black tracking-tight mt-1">${f2(target)}</div>
                {S>0 && (
                  <div className="mt-2 bg-black/25 rounded-xl px-3 py-2 space-y-0.5">
                    <div className="flex justify-between text-white text-sm">
                      <span>Bruto</span>
                      <span className="font-bold">+${raw.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-white/60 text-xs">
                      <span>Comisión</span>
                      <span>−${C.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-white font-bold border-t border-white/20 pt-0.5 mt-0.5">
                      <span>Neto</span>
                      <span className={net>=0?"text-white":"text-red-300"}>${net.toFixed(2)}</span>
                    </div>
                    <div className="text-white/50 text-xs">{S} × ${f2(target-E)} por unidad</div>
                  </div>
                )}
              </div>
            );
          })}

          {E>0 && (
            <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
              <div className="text-yellow-400 text-xs font-bold mb-2 uppercase tracking-wider">Refuerzo (−50%)</div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-slate-400">Si llega a</span>
                <span className="text-yellow-400 font-mono">${f2(E*0.50)}</span>
              </div>
              <div className="text-slate-500 text-xs">Comprar más contratos mismo strike · nunca más del monto inicial</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: TRADES
// ═══════════════════════════════════════════════════════════════════════════════
const emptyForm = () => ({ date:today(), symbol:"TSLA", type:"COMPRA", price:"", shares:"", notes:"" });

function TabTrades() {
  const [trades,   setTrades]   = useState(()=>load(LS.TRADES,[]));
  const [form,     setForm]     = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);

  const set = k => e => setForm(f=>({...f,[k]:e.target?.value??e}));
  const add = () => {
    if (!form.price||!form.shares) return;
    const next=[{...form,id:Date.now()},...trades];
    setTrades(next); save(LS.TRADES,next);
    setShowForm(false); setForm(emptyForm());
  };
  const del = id => { const next=trades.filter(t=>t.id!==id); setTrades(next); save(LS.TRADES,next); };

  const pnl = trades.reduce((acc,t)=>{
    const v=parseFloat(t.price)*parseFloat(t.shares);
    return acc+(t.type==="VENTA"?v:-v);
  },0);

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="text-white font-bold">Diario de Trades</h2>
        <button onClick={()=>setShowForm(v=>!v)}
          className={`text-sm px-3 py-1.5 rounded-xl font-semibold transition-all ${showForm?"bg-slate-700 text-slate-300":"bg-blue-600 hover:bg-blue-500 text-white"}`}>
          {showForm?"Cancelar":"+ Nuevo"}
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-800 rounded-2xl p-4 border border-blue-600/50 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-slate-400 text-xs block mb-1">Fecha</label>
              <input type="date" value={form.date} onChange={set("date")}
                className="w-full bg-slate-700 text-white rounded-xl px-2.5 py-2 text-xs border border-slate-600 focus:outline-none"/>
            </div>
            <div>
              <label className="text-slate-400 text-xs block mb-1">Símbolo</label>
              <select value={form.symbol} onChange={set("symbol")}
                className="w-full bg-slate-700 text-white rounded-xl px-2.5 py-2 text-xs border border-slate-600">
                {[...SYMS,"OTRO"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-slate-400 text-xs block mb-1">Tipo</label>
              <div className="flex gap-1">
                {["COMPRA","VENTA"].map(t=>(
                  <button key={t} onClick={()=>setForm(f=>({...f,type:t}))}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold ${form.type===t?(t==="COMPRA"?"bg-green-600 text-white":"bg-red-600 text-white"):"bg-slate-700 text-slate-400"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-slate-400 text-xs block mb-1">Acciones</label>
              <input type="number" value={form.shares} onChange={set("shares")}
                className="w-full bg-slate-700 text-white rounded-xl px-2.5 py-2 text-xs border border-slate-600 focus:outline-none"/>
            </div>
            <div>
              <label className="text-slate-400 text-xs block mb-1">Precio ($)</label>
              <input type="number" step="0.01" value={form.price} onChange={set("price")}
                className="w-full bg-slate-700 text-white rounded-xl px-2.5 py-2 text-xs border border-slate-600 focus:outline-none"/>
            </div>
            <div>
              <label className="text-slate-400 text-xs block mb-1">Total</label>
              <div className="bg-slate-700/50 rounded-xl px-2.5 py-2 text-xs text-white font-mono">
                {form.price&&form.shares?"$"+(parseFloat(form.price)*parseFloat(form.shares)).toFixed(2):"—"}
              </div>
            </div>
          </div>
          <div>
            <label className="text-slate-400 text-xs block mb-1">Notas</label>
            <textarea rows={2} value={form.notes} onChange={set("notes")}
              placeholder="Setup, señal de entrada..."
              className="w-full bg-slate-700 text-white rounded-xl px-2.5 py-2 text-xs border border-slate-600 focus:outline-none resize-none"/>
          </div>
          <button onClick={add}
            className="w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-2.5 rounded-xl text-sm transition-all">
            Guardar Trade
          </button>
        </div>
      )}

      {trades.length>0 && (
        <div className={`rounded-2xl px-4 py-3 flex justify-between text-sm font-bold
          ${pnl>=0?"bg-green-900/30 text-green-400 border border-green-900/40":"bg-red-900/30 text-red-400 border border-red-900/40"}`}>
          <span>P&L Total</span>
          <span>{pnl>=0?"+":"−"}${Math.abs(pnl).toFixed(2)}</span>
        </div>
      )}

      <div className="space-y-2">
        {!trades.length && (
          <div className="text-center text-slate-600 py-10 text-sm">No hay trades registrados.</div>
        )}
        {trades.map(t=>(
          <div key={t.id} className="bg-slate-800 rounded-xl p-3 border border-slate-700/50 flex gap-3 items-start">
            <div className={`mt-0.5 px-2 py-0.5 rounded-lg text-xs font-black ${t.type==="COMPRA"?"bg-green-900/60 text-green-400":"bg-red-900/60 text-red-400"}`}>
              {t.type}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between">
                <span className="text-white font-bold text-sm">{t.symbol}</span>
                <span className="text-slate-500 text-xs">{t.date}</span>
              </div>
              <div className="text-slate-400 text-xs">
                {t.shares} × ${parseFloat(t.price).toFixed(2)} = <span className="text-slate-300">${(t.shares*t.price).toFixed(2)}</span>
              </div>
              {t.notes && <div className="text-slate-600 text-xs mt-0.5 truncate">{t.notes}</div>}
            </div>
            <button onClick={()=>del(t.id)} className="text-slate-700 hover:text-red-400 transition-colors text-xl leading-none">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADIER SANDBOX API
// ═══════════════════════════════════════════════════════════════════════════════
const TRADIER_BASE   = "https://sandbox.tradier.com/v1";
const LS_TRADIER     = "kz_tradier_token";
const LS_TACCOUNT    = "kz_tradier_account";
const LS_BOT_TRADES  = "kz_bot_trades";

async function trGet(endpoint, token) {
  const res = await fetch(`${TRADIER_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Tradier ${res.status}`);
  return res.json();
}

async function trPost(endpoint, token, body) {
  const res = await fetch(`${TRADIER_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Tradier ${res.status}: ${t}`); }
  return res.json();
}

async function trGetProfile(token) {
  const j = await trGet("/user/profile", token);
  const acct = j.profile?.account;
  const accounts = Array.isArray(acct) ? acct : [acct];
  return accounts[0];
}

async function trGetBalance(token, aid) {
  const j = await trGet(`/accounts/${aid}/balances`, token);
  return j.balances;
}

async function trGetPositions(token, aid) {
  const j = await trGet(`/accounts/${aid}/positions`, token);
  if (!j.positions || j.positions === "null") return [];
  const p = j.positions.position;
  return Array.isArray(p) ? p : [p];
}

async function trGetExpirations(token, sym) {
  const j = await trGet(`/markets/options/expirations?symbol=${sym}&includeAllRoots=true`, token);
  if (!j.expirations?.date) return [];
  const d = j.expirations.date;
  return Array.isArray(d) ? d : [d];
}

async function trGetChain(token, sym, exp) {
  const j = await trGet(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=false`, token);
  if (!j.options?.option) return [];
  const o = j.options.option;
  return Array.isArray(o) ? o : [o];
}

async function trPlaceOrder(token, aid, params) {
  return trPost(`/accounts/${aid}/orders`, token, {
    class: "option",
    symbol: params.symbol,
    option_symbol: params.optionSymbol,
    side: params.side,
    quantity: params.quantity,
    type: "limit",
    price: params.price,
    duration: params.duration ?? "day",
  });
}

// ─── Bot utilities ────────────────────────────────────────────────────────────
function isMarketOpen() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = et.getDay();
  if (dow === 0 || dow === 6) return false;
  const tot = et.getHours() * 60 + et.getMinutes();
  return tot >= 9 * 60 + 30 && tot < 16 * 60;
}

function getETNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

// OTM % by weekday: Mon/Tue=5%, Wed=2.5%, Thu/Fri=1%
function otmPctByDow(dow) {
  if (dow === 1 || dow === 2) return 0.05;
  if (dow === 3) return 0.025;
  return 0.01;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: BOT
// ═══════════════════════════════════════════════════════════════════════════════
function TabBot({ market, selectedTickers, apiKey }) {
  const [tokenInput,  setTokenInput]  = useState(() => localStorage.getItem(LS_TRADIER) || "");
  const [token,       setToken]       = useState(() => localStorage.getItem(LS_TRADIER) || "");
  const [accountId,   setAccountId]   = useState(() => localStorage.getItem(LS_TACCOUNT) || "");
  const [balance,     setBalance]     = useState(null);
  const [positions,   setPositions]   = useState([]);
  const [connected,   setConnected]   = useState(false);
  const [connecting,  setConnecting]  = useState(false);
  const [botOn,       setBotOn]       = useState(false);
  const [botPlan,     setBotPlan]     = useState("p10");
  const [botSize,     setBotSize]     = useState(5);
  const [log,         setLog]         = useState([]);
  const [botTrades,   setBotTrades]   = useState(() => load(LS_BOT_TRADES, []));

  // Refs so interval always uses latest values without re-creating
  const stateRef = React.useRef({});
  stateRef.current = { token, accountId, botPlan, botSize, market, selectedTickers };

  const addLog = React.useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    setLog(prev => [{ text: `[${ts}] ${msg}`, type }, ...prev].slice(0, 100));
  }, []);

  // ── Connect ──────────────────────────────────────────────────────────────────
  const connect = async () => {
    const t = tokenInput.trim();
    if (!t) return;
    setConnecting(true);
    try {
      const acct = await trGetProfile(t);
      const aid  = acct?.account_number;
      if (!aid) throw new Error("No se encontró número de cuenta");
      localStorage.setItem(LS_TRADIER, t);
      localStorage.setItem(LS_TACCOUNT, aid);
      setToken(t); setAccountId(aid); setConnected(true);
      addLog(`Conectado — cuenta ${aid}`, "success");
      const bal = await trGetBalance(t, aid);
      setBalance(bal);
      const cash = parseFloat(bal?.cash?.cash_available ?? bal?.total_cash ?? 0);
      addLog(`Balance disponible: $${cash.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, "success");
    } catch(e) {
      addLog(`Error: ${e.message}`, "error");
    }
    setConnecting(false);
  };

  // ── Refresh account data ─────────────────────────────────────────────────────
  const refreshAccount = React.useCallback(async () => {
    const { token: t, accountId: aid } = stateRef.current;
    if (!t || !aid) return;
    try {
      const [bal, pos] = await Promise.all([trGetBalance(t, aid), trGetPositions(t, aid)]);
      setBalance(bal);
      setPositions(pos.filter(p => p?.symbol?.length > 6));
    } catch(e) { /* silent */ }
  }, []);

  // ── Bot cycle ────────────────────────────────────────────────────────────────
  const runCycle = React.useCallback(async () => {
    const { token: t, accountId: aid, botPlan: plan, botSize: size, market: mkt, selectedTickers: tickers } = stateRef.current;
    if (!t || !aid) return;
    if (!isMarketOpen()) { addLog("Mercado cerrado", "info"); return; }

    addLog("Revisando señales…");
    const manuals = load(LS_MANUALS, {});
    const planObj = PLANS.find(p => p.id === plan) ?? PLANS[0];

    let currentPos = [];
    try { currentPos = await trGetPositions(t, aid); } catch(e) { addLog(`Error pos: ${e.message}`, "error"); return; }

    // Symbols with open positions (extract underlying from OCC symbol)
    const activeSyms = new Set(currentPos.map(p => (p.symbol || "").replace(/[0-9].*/, "").trim()));

    const watchList = tickers.length > 0 ? tickers : ["TSLA", "GOOGL", "MSFT", "META"];

    for (const sym of watchList) {
      const data = mkt[sym];
      if (!data) continue;
      if (activeSyms.has(sym)) { addLog(`${sym}: posición abierta — skip`); continue; }

      for (const strat of STRATS) {
        const { allOk } = evalStrategy(strat, data, manuals);
        if (!allOk) continue;

        addLog(`🟢 ${sym} E${strat.id} ${strat.name} — señal confirmada, ejecutando ${strat.dir}…`, "success");
        try {
          // Nearest expiration
          const exps = await trGetExpirations(t, sym);
          if (!exps.length) { addLog(`${sym}: sin vencimientos disponibles`, "error"); break; }
          const expDate = exps[0];

          // Options chain
          const chain = await trGetChain(t, sym, expDate);
          const optType = strat.dir === "CALL" ? "call" : "put";
          const filtered = chain.filter(o => o.option_type === optType && o.ask > 0);
          if (!filtered.length) { addLog(`${sym}: cadena de opciones vacía`, "error"); break; }

          // Target strike by OTM %
          const etNow    = getETNow();
          const dow      = etNow.getDay();
          const otmPct   = otmPctByDow(dow);
          const rawTgt   = strat.dir === "CALL" ? data.price * (1 + otmPct) : data.price * (1 - otmPct);
          const tgtStrike = Math.round(rawTgt * 2) / 2;

          const closest = filtered.reduce((best, o) =>
            Math.abs(o.strike - tgtStrike) < Math.abs(best.strike - tgtStrike) ? o : best
          );

          // Position size
          let bal;
          try { bal = await trGetBalance(t, aid); } catch { bal = null; }
          const cash  = parseFloat(bal?.cash?.cash_available ?? bal?.total_cash ?? 100000);
          const invest = cash * (size / 100);
          const qty   = Math.max(1, Math.floor(invest / (closest.ask * 100)));
          const entry = closest.ask;

          // ── STEP 1: Buy to open ──────────────────────────────────────────────
          await trPlaceOrder(t, aid, {
            symbol: sym, optionSymbol: closest.symbol,
            side: "buy_to_open", quantity: qty,
            price: entry.toFixed(2), duration: "day",
          });

          // ── STEP 2: Immediately place sell limit (same instant as buy) ───────
          // Target = entry × plan_multiplier + $2 commission spread over contracts
          const planMultiplier = planObj.pct === 1.00 ? 2.00 : (1 + planObj.pct);
          const commPerUnit    = BT_COMM / (qty * 100);          // $2 spread over all units
          const sellTarget     = parseFloat((entry * planMultiplier + commPerUnit).toFixed(2));

          await trPlaceOrder(t, aid, {
            symbol: sym, optionSymbol: closest.symbol,
            side: "sell_to_close", quantity: qty,
            price: sellTarget.toFixed(2), duration: "gtc",
          });

          const planLabel  = planObj.label;

          addLog(`✅ COMPRA ejecutada: ${sym} ${strat.dir} $${entry.toFixed(2)} — Venta limit colocada en $${sellTarget.toFixed(2)}`, "success");
          addLog(`   ${qty} contrato${qty>1?"s":""} · Strike $${closest.strike} · Exp ${expDate} · ${planLabel}: objetivo +${(planObj.pct*100).toFixed(0)}%`, "info");

          // Record
          const rec = {
            id: Date.now(), date: new Date().toISOString(),
            sym, dir: strat.dir, stratId: strat.id, stratName: strat.name,
            optionSymbol: closest.symbol, strike: closest.strike,
            expDate, qty, entry, target: sellTarget,
            plan: plan, planLabel, status: "ABIERTA",
          };
          setBotTrades(prev => { const n = [rec, ...prev]; save(LS_BOT_TRADES, n); return n; });
          playSignalAlert();
          await refreshAccount();
        } catch(e) {
          addLog(`${sym} error al ejecutar orden: ${e.message}`, "error");
        }
        break; // one strategy per ticker per cycle
      }
    }
    // ── Monitor open trades for objective hit (no stop-loss — Kaizen methodology) ─
    const openTrades = load(LS_BOT_TRADES, []).filter(bt => bt.status === "ABIERTA");

    for (const bt of openTrades) {
      const liveData = mkt[bt.sym];
      if (!liveData) continue;
      const livePrice = liveData.price;

      // Check if sell limit was hit (live stock price approximates option target hit)
      const objHit = bt.dir === "CALL" ? livePrice >= bt.target : livePrice <= bt.target;

      if (objHit) {
        addLog(`🎯 OBJETIVO ALCANZADO: +${((bt.target / bt.entry - 1) * 100).toFixed(0)}% ganancia — ${bt.sym} ${bt.dir}`, "success");
        setBotTrades(prev => { const n = prev.map(x => x.id === bt.id ? { ...x, status: "GANANCIA" } : x); save(LS_BOT_TRADES, n); return n; });
      }
    }

    addLog("Ciclo completado");
  }, [addLog, refreshAccount]);

  // Interval — always calls latest runCycle via ref
  const runCycleRef = React.useRef(runCycle);
  React.useEffect(() => { runCycleRef.current = runCycle; }, [runCycle]);

  React.useEffect(() => {
    if (!botOn || !connected) return;
    runCycleRef.current();
    const id = setInterval(() => runCycleRef.current(), 60000);
    return () => clearInterval(id);
  }, [botOn, connected]);

  // Refresh account every 30s when connected
  React.useEffect(() => {
    if (!connected) return;
    refreshAccount();
    const id = setInterval(refreshAccount, 30000);
    return () => clearInterval(id);
  }, [connected, refreshAccount]);

  const logColor = t => t === "success" ? "text-green-400" : t === "error" ? "text-red-400" : t === "warning" ? "text-yellow-400" : "text-slate-500";
  const cash = balance ? parseFloat(balance.cash?.cash_available ?? balance.total_cash ?? 0) : null;

  return (
    <div className="space-y-3">
      <h2 className="text-white font-bold">Bot de Trading Automático</h2>

      {/* ── Connection ─────────────────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-slate-300 font-semibold text-sm">Tradier Sandbox</h3>
          <span className={`text-xs px-2.5 py-1 rounded-full font-bold ${connected ? "bg-green-900/50 text-green-400" : "bg-slate-700 text-slate-500"}`}>
            {connected ? "● CONECTADO" : "○ desconectado"}
          </span>
        </div>

        <div className="flex gap-2">
          <input type="password" placeholder="Bearer token de Tradier Sandbox…"
            value={tokenInput} onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && connect()}
            className="flex-1 bg-slate-700 text-white rounded-xl px-3 py-2.5 text-xs border border-slate-600 focus:outline-none focus:border-blue-500 placeholder-slate-500"/>
          <button onClick={connect} disabled={connecting || !tokenInput.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-bold px-4 rounded-xl transition-all">
            {connecting ? "…" : "Conectar"}
          </button>
        </div>

        {connected && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-slate-700/50 rounded-xl px-3 py-2">
              <div className="text-slate-500 mb-0.5">Cuenta</div>
              <div className="text-white font-mono font-bold">{accountId}</div>
            </div>
            <div className="bg-slate-700/50 rounded-xl px-3 py-2">
              <div className="text-slate-500 mb-0.5">Capital disponible</div>
              <div className="text-green-400 font-mono font-bold">
                {cash != null ? `$${cash.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "…"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Bot controls ───────────────────────────────────────────────────────── */}
      {connected && (
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-slate-300 font-semibold text-sm">Control del Bot</h3>
            <button onClick={() => setBotOn(v => !v)}
              className={`px-5 py-1.5 rounded-xl text-sm font-black transition-all
                ${botOn ? "bg-red-600 hover:bg-red-500 text-white" : "bg-green-600 hover:bg-green-500 text-white"}`}>
              {botOn ? "⏹ STOP" : "▶ START"}
            </button>
          </div>

          {botOn && (
            <div className="bg-green-950 border border-green-800 rounded-xl px-3 py-2 text-xs text-green-300 font-semibold text-center animate-pulse">
              🤖 BOT ACTIVO — revisando cada 60s durante mercado (9:30–4:00 ET)
            </div>
          )}

          <div>
            <div className="text-slate-500 text-xs mb-1.5">Plan de ganancia objetivo</div>
            <div className="flex gap-1.5">
              {PLANS.map(p => (
                <button key={p.id} onClick={() => setBotPlan(p.id)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                    ${botPlan === p.id ? `bg-gradient-to-br ${p.from} ${p.to} text-white` : "bg-slate-700 text-slate-500"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-slate-500 text-xs">Tamaño de posición por trade</span>
              <span className="text-blue-400 font-bold text-xs">{botSize}% del capital</span>
            </div>
            <input type="range" min="1" max="20" value={botSize}
              onChange={e => setBotSize(Number(e.target.value))}
              className="w-full accent-blue-500 h-1"/>
            <div className="flex justify-between text-slate-700 text-xs mt-0.5">
              <span>1%</span><span>20%</span>
            </div>
          </div>

          <div className="text-slate-600 text-xs">
            Monitoreando: <span className="text-slate-400 font-semibold">{selectedTickers.join(" · ") || "TSLA · GOOGL · MSFT · META"}</span>
          </div>
        </div>
      )}

      {/* ── Open positions ─────────────────────────────────────────────────────── */}
      {connected && positions.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-slate-300 font-semibold text-sm">Posiciones Abiertas</h3>
            <button onClick={refreshAccount} className="text-slate-600 hover:text-blue-400 text-xs transition-colors">↻</button>
          </div>
          <div className="space-y-2">
            {positions.map((pos, i) => (
              <div key={i} className="bg-slate-700/50 rounded-xl px-3 py-2.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-white font-mono font-bold truncate max-w-[70%]">{pos.symbol}</span>
                  <span className="text-slate-400">{pos.quantity}x</span>
                </div>
                <div className="flex justify-between text-xs mt-1">
                  <span className="text-slate-500">Costo base</span>
                  <span className="text-slate-300">${parseFloat(pos.cost_basis || 0).toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Bot trade history ──────────────────────────────────────────────────── */}
      {botTrades.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-slate-300 font-semibold text-sm">Historial Bot ({botTrades.length})</h3>
            <button onClick={() => { setBotTrades([]); save(LS_BOT_TRADES, []); }}
              className="text-slate-600 hover:text-red-400 text-xs transition-colors">Limpiar</button>
          </div>
          <div className="space-y-2">
            {botTrades.slice(0, 20).map(t => (
              <div key={t.id} className="bg-slate-700/50 rounded-xl px-3 py-2.5">
                <div className="flex justify-between items-start">
                  <div>
                    <span className={`font-bold text-sm ${t.dir === "CALL" ? "text-green-400" : "text-red-400"}`}>{t.sym} {t.dir}</span>
                    <span className="text-slate-500 text-xs ml-1.5">E{t.stratId}</span>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-bold
                    ${t.status === "ABIERTA" ? "bg-blue-900/60 text-blue-400"
                    : t.status === "GANANCIA" ? "bg-green-900/60 text-green-400"
                    : "bg-red-900/60 text-red-400"}`}>
                    {t.status}
                  </span>
                </div>
                <div className="text-slate-500 text-xs font-mono mt-0.5 truncate">{t.optionSymbol}</div>
                <div className="grid grid-cols-2 gap-1 mt-1.5 text-xs">
                  <div className="bg-slate-700/40 rounded px-1.5 py-1 text-center">
                    <div className="text-slate-600 leading-none mb-0.5">Compra</div>
                    <div className="text-white font-mono">${t.entry?.toFixed(2)}</div>
                  </div>
                  <div className="bg-green-900/30 rounded px-1.5 py-1 text-center">
                    <div className="text-slate-600 leading-none mb-0.5">🎯 Objetivo</div>
                    <div className="text-green-400 font-mono">${t.target?.toFixed(2)}</div>
                  </div>
                </div>
                <div className="flex justify-between mt-1 text-xs">
                  <span className="text-slate-600">{t.planLabel ?? t.plan} · {t.qty} contrato{t.qty>1?"s":""}</span>
                  <span className="text-slate-600">{t.date ? new Date(t.date).toLocaleDateString() : ""}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Live log ───────────────────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-slate-300 font-semibold text-sm">Log en Vivo</h3>
          <button onClick={() => setLog([])} className="text-slate-600 hover:text-red-400 text-xs transition-colors">Limpiar</button>
        </div>
        {log.length === 0 ? (
          <div className="text-slate-600 text-xs text-center py-6">Sin actividad aún — conecta y activa el bot</div>
        ) : (
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {log.map((entry, i) => (
              <div key={i} className={`text-xs font-mono leading-relaxed ${logColor(entry.type)}`}>
                {entry.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const BT_CAPITAL  = 10000;  // virtual starting capital
const BT_POS_PCT  = 0.05;   // 5 % of equity per trade
const BT_WIN_PCT  = 0.35;   // Plan 35 % profit target
const BT_COMM     = 2;      // $2 commission per round-trip
// Stock move that triggers option WIN (no stop-loss — hold until WIN or expiry):
//   CALL WIN : stock HIGH rises  ≥ BT_WIN_MOVE from entry
//   PUT  WIN : stock LOW  drops  ≥ BT_WIN_MOVE from entry
//   No WIN by expiry → LOSS (full option premium lost)
const BT_WIN_MOVE = 0.025;  // 2.5 % underlying → ≈35 % option gain
const BT_SYMS     = ["TSLA", "GOOGL", "MSFT", "META"];

// ─── Option price estimation (for range filter in backtest) ───────────────────
// Calibrated formula: Ask ≈ stockPrice × OPT_K × sqrt(dte/5) × exp(-otmPct × OPT_DECAY)
const OPT_K     = 0.0163;
const OPT_DECAY = 20;

function estimateOptionAsk(stockPrice, otmPct, dte) {
  return stockPrice * OPT_K * Math.sqrt(dte / 5) * Math.exp(-otmPct * OPT_DECAY);
}

// Returns [minOtmPct, maxOtmPct] whose estimated Ask falls within optRange,
// or null if range is unreachable for this stock price / dte combination.
function getValidOtmRange(stockPrice, optRange, dte) {
  const base = stockPrice * OPT_K * Math.sqrt(dte / 5);
  if (base <= 0) return null;
  // maxAsk (most expensive, least OTM) → smallest otmPct
  const minOtm = -Math.log(optRange[1] / base) / OPT_DECAY;
  // minAsk (cheapest, most OTM) → largest otmPct
  const maxOtm = -Math.log(optRange[0] / base) / OPT_DECAY;
  if (!isFinite(minOtm) || !isFinite(maxOtm) || minOtm > maxOtm) return null;
  return [Math.max(0, minOtm), maxOtm];
}

async function fetchHistoricalBars(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 7);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=200&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url); }
  catch { throw new Error(`Red — ${sym}`); }
  if (res.status === 429) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, [15000,30000,60000][attempt])); return fetchHistoricalBars(sym, apiKey, attempt+1); }
    throw new Error(`429 — ${sym}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${sym}`);
  return (await res.json()).results || [];
}

// Hourly bars for the 3-month window — used for intraday WIN/LOSS detection
async function fetchHourlyBars(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 3);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/hour/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url); }
  catch { throw new Error(`Red — ${sym}`); }
  if (res.status === 429) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, [15000,30000,60000][attempt])); return fetchHourlyBars(sym, apiKey, attempt+1); }
    throw new Error(`429 — ${sym}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${sym}`);
  return (await res.json()).results || [];
}

function buildDayDataBT(sym, bars, idx) {
  if (idx < 50) return null;
  const slice  = bars.slice(0, idx + 1);
  const closes = slice.map(b => b.c);
  const vols   = slice.map(b => b.v);
  const last   = slice[slice.length - 1];
  const prev   = slice[slice.length - 2];
  const BB     = calcBB(closes);
  const BBprev = calcBB(closes.slice(0, -1));
  const ma20   = sma(closes, 20);
  const ma40   = sma(closes, 40);
  const ma50   = sma(closes, 50);
  if (!BB || !ma20 || !ma40) return null;
  const avgVol   = vols.slice(-20).reduce((a,b) => a+b, 0) / Math.min(20, vols.length);
  const volLevel = BB.width < 3 ? "BAJA" : BB.width < 8 ? "ALTA" : "EXTREMA";
  return {
    sym, price: last.c, open: last.o, high: last.h, low: last.l, volume: last.v,
    change: last.c - (prev?.c ?? last.c),
    changePct: prev ? (last.c - prev.c) / prev.c * 100 : 0,
    bb: BB, ma20, ma40, ma50, signal: calcSignal(last.c, BB, ma20, ma50),
    gap: detectGap(slice.slice(-2)), bars: slice, avgVolume: avgVol,
    prevLowVol: BBprev ? BBprev.width < 3 : false, volLevel,
  };
}

// Returns auto-evaluatable condition IDs for a strategy (skips manual + gapTime)
function getAutoCondIds(strat) {
  const global = [
    ...(strat.noHighVolRequired ? [] : ["vol"]),
    "bbDir", "ma20Dir", "ma40Dir", "volume",
  ];
  const specific = strat.specific
    .filter(c => c.type === "auto" && c.id !== "gapTime")
    .map(c => c.id);
  return [...global, ...specific];
}

// runBacktest(dailyData, hourlyData)
// dailyData  — 7-month daily bars per symbol  (signal detection + MA/BB warmup)
// hourlyData — 3-month hourly bars per symbol (intraday WIN detection)
// No stop-loss: hold until WIN (target hit) or expiry (full LOSS of premium).
// Weekday strike rule:
//   Mon/Tue  → cheapest Ask in range (highest OTM%) → maxOtmPct
//   Wed      → mid Ask (mid OTM%)
//   Thu/Fri  → most expensive Ask in range (lowest OTM%) → minOtmPct
function runBacktest(dailyData, hourlyData) {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
  const rawTrades = [];
  let filteredCount = 0; // signals skipped because Ask was outside range

  for (const sym of BT_SYMS) {
    const bars  = dailyData[sym];
    const hBars = hourlyData[sym] || [];
    const tk    = TICKER_MAP[sym];
    if (!bars || bars.length < 55) continue;

    for (let i = 50; i < bars.length - 2; i++) {
      const barDate = new Date(bars[i].t);
      if (barDate < cutoff) continue;
      const dow = barDate.getDay();
      if (dow === 0 || dow === 6) continue;

      const data = buildDayDataBT(sym, bars, i);
      if (!data || data.volLevel === "BAJA") continue;

      const dateStr = barDate.toISOString().split("T")[0];

      // Try every strategy — both CALL and PUT evaluated independently
      for (const strat of STRATS) {
        const condIds = getAutoCondIds(strat);
        const autoRes = evalAuto(data, strat);
        if (!condIds.every(id => autoRes[id]?.ok)) continue;

        // Signal confirmed → enter at next day's open
        const nextBar = bars[i + 1];
        if (!nextBar) continue;
        const entry = nextBar.o;

        const dte = dow >= 1 && dow <= 5 ? DTES[dow - 1] : 3;

        // ── Option range filter (Kaizen rule: skip if Ask outside range) ────
        // Estimate option Ask using OTM% based on weekday rule
        let optAsk = null;
        if (tk.range) {
          const otmRange = getValidOtmRange(entry, tk.range, dte);
          if (!otmRange) { filteredCount++; continue; } // no valid OTM in range
          const [minOtm, maxOtm] = otmRange;
          // Select OTM% by weekday: Mon/Tue=cheapest(maxOtm), Wed=mid, Thu/Fri=expensive(minOtm)
          let otmPct;
          if (dow <= 2) otmPct = maxOtm;           // Mon/Tue: cheapest
          else if (dow === 3) otmPct = (minOtm + maxOtm) / 2; // Wed: mid
          else otmPct = minOtm;                    // Thu/Fri: most expensive
          optAsk = estimateOptionAsk(entry, otmPct, dte);
          // Double-check it's in range (floating point safety)
          if (optAsk < tk.range[0] || optAsk > tk.range[1]) { filteredCount++; continue; }
        }

        // ── Build intraday simulation bars ───────────────────────────────────
        // Prefer hourly bars; fall back to daily H/L
        const entryTs  = nextBar.t;
        const expiryTs = entryTs + (dte + 1) * 24 * 60 * 60 * 1000;
        const simBars  = hBars.filter(b => b.t >= entryTs && b.t <= expiryTs).length > 0
          ? hBars.filter(b => b.t >= entryTs && b.t <= expiryTs)
          : bars.slice(i + 1, i + 1 + dte + 2);

        // Hold until WIN or expiry — no stop-loss
        let outcome = "LOSS"; // default: expires worthless
        for (const sb of simBars) {
          if (strat.dir === "CALL") {
            if (sb.high / entry - 1 >= BT_WIN_MOVE) { outcome = "WIN"; break; }
          } else { // PUT
            if (1 - sb.low / entry >= BT_WIN_MOVE)  { outcome = "WIN"; break; }
          }
        }

        rawTrades.push({
          id: `${sym}_s${strat.id}_${dateStr}`,
          date: dateStr, sym, stratId: strat.id, stratName: strat.name,
          dir: strat.dir, entry, optAsk, outcome,
          exitDate: new Date(expiryTs).toISOString().split("T")[0],
        });
        break; // one strategy per bar per ticker (first match wins)
      }
    }
  }

  // Sort chronologically; compute equity curve
  rawTrades.sort((a, b) => a.date.localeCompare(b.date));

  let equity = BT_CAPITAL;
  const curve = [{ date: "Inicio", equity: BT_CAPITAL }];

  for (const t of rawTrades) {
    const invest = equity * BT_POS_PCT;

    if (t.outcome === "WIN") {
      t.pnl = invest * BT_WIN_PCT - BT_COMM;    // +35% of option premium invested
    } else {
      t.pnl = -invest - BT_COMM;                 // Full loss of option premium at expiry
    }

    equity += t.pnl;
    curve.push({ date: t.date, equity });
  }

  // Per-strategy summaries
  const stratSums = STRATS.map(s => {
    const st    = rawTrades.filter(t => t.stratId === s.id);
    const wins  = st.filter(t => t.outcome === "WIN");
    const pnls  = st.map(t => t.pnl ?? 0);
    const tot   = pnls.reduce((a,b) => a+b, 0);
    const best  = st.length ? st.reduce((b,t) => (t.pnl??-Infinity) > (b.pnl??-Infinity) ? t : b) : null;
    const worst = st.length ? st.reduce((w,t) => (t.pnl??Infinity)  < (w.pnl??Infinity)  ? t : w) : null;
    return {
      id: s.id, name: s.name, dir: s.dir,
      fires: st.length, wins: wins.length,
      winPct: st.length ? wins.length / st.length * 100 : 0,
      avgPnl: st.length ? tot / st.length : 0,
      totalPnl: tot, best, worst,
    };
  });

  // CALL vs PUT breakdown
  const callTrades = rawTrades.filter(t => t.dir === "CALL");
  const putTrades  = rawTrades.filter(t => t.dir === "PUT");
  const callWins   = callTrades.filter(t => t.outcome === "WIN").length;
  const putWins    = putTrades.filter(t => t.outcome === "WIN").length;
  const callPnl    = callTrades.reduce((s,t) => s + (t.pnl??0), 0);
  const putPnl     = putTrades.reduce((s,t)  => s + (t.pnl??0), 0);

  const totalWins = rawTrades.filter(t => t.outcome === "WIN").length;
  return {
    trades: rawTrades, curve, stratSums, equity,
    totalTrades: rawTrades.length, totalWins, filteredCount,
    winRate: rawTrades.length ? totalWins / rawTrades.length * 100 : 0,
    totalPnl: equity - BT_CAPITAL,
    callTrades: callTrades.length, callWins, callPnl,
    putTrades:  putTrades.length,  putWins,  putPnl,
  };
}

// ─── Equity curve SVG ─────────────────────────────────────────────────────────
function EquityChart({ curve }) {
  if (!curve || curve.length < 2) return null;
  const W=300, H=140, PX=38, PY=14;
  const iW=W-PX*2, iH=H-PY*2;
  const vals  = curve.map(p => p.equity);
  const minV  = Math.min(...vals);
  const maxV  = Math.max(...vals);
  const range = maxV - minV || 1;
  const px = i => PX + (i / (curve.length-1)) * iW;
  const py = v => PY + iH - ((v - minV) / range) * iH;
  const pts     = curve.map((p,i) => `${px(i).toFixed(1)},${py(p.equity).toFixed(1)}`).join(" ");
  const areaPts = `${px(0)},${PY+iH} ${pts} ${px(curve.length-1)},${PY+iH}`;
  const isUp  = curve[curve.length-1].equity >= BT_CAPITAL;
  const color = isUp ? "#22c55e" : "#ef4444";
  const pctChg = (curve[curve.length-1].equity - BT_CAPITAL) / BT_CAPITAL * 100;

  return (
    <div className="bg-slate-900 rounded-xl overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{height:140}}>
        <defs>
          <linearGradient id="ecGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.28"/>
            <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
          </linearGradient>
        </defs>
        {[0,0.33,0.67,1].map((p,i) => {
          const yy = PY + iH*(1-p);
          return (
            <g key={i}>
              <line x1={PX} x2={W-PX} y1={yy} y2={yy} stroke="#1e293b" strokeWidth="1"/>
              <text x={PX-3} y={yy+3} textAnchor="end" fill="#475569" fontSize="8">
                ${Math.round((minV+range*p)/100)*100}
              </text>
            </g>
          );
        })}
        {/* start capital reference */}
        <line x1={PX} x2={W-PX} y1={py(BT_CAPITAL)} y2={py(BT_CAPITAL)}
          stroke="#334155" strokeWidth="1" strokeDasharray="4,2"/>
        <polygon points={areaPts} fill="url(#ecGrad)"/>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx={px(0)} cy={py(curve[0].equity)} r="3" fill={color} opacity="0.6"/>
        <circle cx={px(curve.length-1)} cy={py(curve[curve.length-1].equity)} r="3.5" fill={color}/>
      </svg>
      <div className="flex justify-between text-xs px-3 pb-2 mt-0.5">
        <span className="text-slate-600">{curve[1]?.date ?? ""}</span>
        <span className={`font-bold ${isUp?"text-green-400":"text-red-400"}`}>
          {isUp?"+":""}{pctChg.toFixed(1)}% → ${Math.round(curve[curve.length-1].equity).toLocaleString()}
        </span>
        <span className="text-slate-600">{curve[curve.length-1].date}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: BACKTEST
// ═══════════════════════════════════════════════════════════════════════════════
function TabBacktest({ apiKey }) {
  const [running,       setRunning]       = useState(false);
  const [progress,      setProgress]      = useState("");
  const [results,       setResults]       = useState(null);
  const [error,         setError]         = useState(null);
  const [filterSym,     setFilterSym]     = useState("all");
  const [filterStrat,   setFilterStrat]   = useState("all");
  const [filterOutcome, setFilterOutcome] = useState("all");
  const [showTrades,    setShowTrades]    = useState(false);

  const run = async () => {
    if (!apiKey) { setError("Necesitas configurar la API key de Polygon primero"); return; }
    setRunning(true); setError(null); setResults(null);
    const daily  = {};
    const hourly = {};
    // All API calls: 4 daily + 4 hourly = 8 total; 15s between each
    const allFetches = [
      ...BT_SYMS.map(sym => ({ sym, type: "daily"  })),
      ...BT_SYMS.map(sym => ({ sym, type: "hourly" })),
    ];
    try {
      for (let i = 0; i < allFetches.length; i++) {
        const { sym, type } = allFetches[i];
        setProgress(`${type === "daily" ? "Diario" : "Intradía 1h"} ${sym} (${i+1}/${allFetches.length})…`);
        if (type === "daily")  daily[sym]  = await fetchHistoricalBars(sym, apiKey);
        else                   hourly[sym] = await fetchHourlyBars(sym, apiKey);
        if (i < allFetches.length - 1) {
          for (let s = 15; s >= 1; s--) {
            setProgress(`Esperando ${s}s — límite API… (${i+1}/${allFetches.length})`);
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
      setProgress("Simulando 8 estrategias × 3 meses (CALL + PUT)…");
      await new Promise(r => setTimeout(r, 50));
      setResults(runBacktest(daily, hourly));
    } catch(e) { setError(e.message); }
    setProgress(""); setRunning(false);
  };

  const filteredTrades = results?.trades.filter(t => {
    if (filterSym     !== "all" && t.sym              !== filterSym)         return false;
    if (filterStrat   !== "all" && String(t.stratId)  !== filterStrat)       return false;
    if (filterOutcome !== "all" && t.outcome           !== filterOutcome)     return false;
    return true;
  }) ?? [];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-white font-bold">Backtest — Últimos 3 Meses</h2>
        <button onClick={run} disabled={running || !apiKey}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-bold px-4 py-2 rounded-xl transition-all flex items-center gap-1.5">
          <span className={running ? "animate-spin inline-block" : ""}>
            {running ? "⟳" : "▶"}
          </span>
          {running ? "Ejecutando…" : "Ejecutar Backtest"}
        </button>
      </div>

      {/* Methodology note */}
      <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2.5 space-y-0.5">
        <div className="text-slate-300 text-xs font-semibold mb-1">Metodología</div>
        <div className="text-slate-500 text-xs">• TSLA · GOOGL · MSFT · META — señales en datos diarios (7m) + simulación en barras 1h (3m)</div>
        <div className="text-slate-500 text-xs">• CALL gana si precio SUBE ≥2.5 % · PUT gana si precio BAJA ≥2.5 % — ambas direcciones válidas</div>
        <div className="text-slate-500 text-xs">• Capital $10,000 · 5 % por trade · Plan 35 % objetivo / Stop −20 %</div>
        <div className="text-slate-500 text-xs">• Neutros: P&L real según movimiento final × 3.5x leverage (sin penalización fija)</div>
      </div>

      {/* Progress */}
      {running && (
        <div className="bg-purple-950 border border-purple-800 rounded-xl px-3 py-2.5 text-xs text-purple-300 font-semibold animate-pulse">
          ⟳ {progress}
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-3 py-2.5 text-xs text-red-300">
          ✗ {error}
        </div>
      )}

      {results && (
        <>
          {/* Methodology note */}
          <div className="bg-slate-800/60 rounded-xl px-3 py-2.5 border border-slate-700/40 text-xs text-slate-400 space-y-0.5">
            <div className="font-bold text-slate-300">Metodología Kaizen — sin stop loss</div>
            <div>WIN: acción mueve +2.5% en dirección correcta → +35% premium</div>
            <div>LOSS: no llega al objetivo → expira sin valor (−100% premium)</div>
            {results.filteredCount > 0 && (
              <div className="text-yellow-500">⚠ {results.filteredCount} señales filtradas por Ask fuera del rango óptimo</div>
            )}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Trades totales",  results.totalTrades,                                      "text-white"],
              ["Tasa de acierto", results.totalTrades ? results.winRate.toFixed(1)+"%" : "—", results.winRate >= 50 ? "text-green-400" : "text-red-400"],
              ["Capital final",   `$${Math.round(results.equity).toLocaleString()}`,          results.equity >= BT_CAPITAL ? "text-green-400" : "text-red-400"],
              ["P&L total",       `${results.totalPnl>=0?"+":""}$${Math.round(results.totalPnl)}`, results.totalPnl >= 0 ? "text-green-400" : "text-red-400"],
            ].map(([lbl,val,cls]) => (
              <div key={lbl} className="bg-slate-800 rounded-xl px-3 py-3 text-center border border-slate-700/40">
                <div className="text-slate-500 text-xs mb-0.5">{lbl}</div>
                <div className={`font-bold text-xl ${cls}`}>{val}</div>
              </div>
            ))}
          </div>

          {/* CALL vs PUT breakdown */}
          <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60">
            <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">CALL vs PUT</div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                {
                  label: "🟢 CALL",
                  trades: results.callTrades,
                  wins:   results.callWins,
                  pnl:    results.callPnl,
                  color:  results.callPnl >= 0 ? "text-green-400" : "text-red-400",
                  border: "border-green-900/40",
                },
                {
                  label: "🔴 PUT",
                  trades: results.putTrades,
                  wins:   results.putWins,
                  pnl:    results.putPnl,
                  color:  results.putPnl >= 0 ? "text-green-400" : "text-red-400",
                  border: "border-red-900/40",
                },
                {
                  label: "⚖️ Total",
                  trades: results.totalTrades,
                  wins:   results.totalWins,
                  pnl:    results.totalPnl,
                  color:  results.totalPnl >= 0 ? "text-green-400" : "text-red-400",
                  border: "border-slate-600/40",
                },
              ].map(row => (
                <div key={row.label} className={`bg-slate-700/40 rounded-xl px-2.5 py-2.5 border ${row.border}`}>
                  <div className="text-slate-300 font-bold text-xs mb-1">{row.label}</div>
                  <div className="text-slate-400">{row.trades} trades</div>
                  <div className="text-slate-400">{row.trades ? (row.wins/row.trades*100).toFixed(0) : 0}% win</div>
                  <div className={`font-bold mt-1 ${row.color}`}>
                    {row.pnl>=0?"+":""}${Math.round(row.pnl)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Equity curve */}
          <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60">
            <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">Curva de Equity</div>
            <EquityChart curve={results.curve}/>
          </div>

          {/* Strategy summary table */}
          <div className="bg-slate-800 rounded-2xl border border-slate-700/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700/40">
              <div className="text-slate-300 font-semibold text-sm">Resumen por Estrategia</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700/40 text-slate-500">
                    <th className="text-left px-3 py-2 font-semibold">Estrategia</th>
                    <th className="text-center px-2 py-2 font-semibold">Señales</th>
                    <th className="text-center px-2 py-2 font-semibold">Éxito</th>
                    <th className="text-center px-2 py-2 font-semibold">Avg $</th>
                    <th className="text-right px-3 py-2 font-semibold">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {results.stratSums.map(s => (
                    <tr key={s.id} className="border-b border-slate-700/20 last:border-0">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400 font-bold">E{s.id}</span>
                          <span className={`text-xs px-1 py-0.5 rounded font-bold
                            ${s.dir==="CALL"?"bg-green-900/50 text-green-400":"bg-red-900/50 text-red-400"}`}>
                            {s.dir}
                          </span>
                        </div>
                        <div className="text-slate-600 text-xs truncate" style={{maxWidth:110}}>{s.name}</div>
                      </td>
                      <td className="text-center px-2 py-2.5">
                        {s.fires > 0 ? (
                          <>
                            <div className="text-white font-bold">{s.fires}</div>
                            <div className="text-slate-600">{s.wins}W·{s.fires-s.wins}L</div>
                          </>
                        ) : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="text-center px-2 py-2.5">
                        {s.fires > 0 ? (
                          <span className={`font-bold text-sm
                            ${s.winPct>=55?"text-green-400":s.winPct>=45?"text-yellow-400":"text-red-400"}`}>
                            {s.winPct.toFixed(0)}%
                          </span>
                        ) : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="text-center px-2 py-2.5">
                        {s.fires > 0 ? (
                          <span className={`font-bold ${s.avgPnl>=0?"text-green-400":"text-red-400"}`}>
                            {s.avgPnl>=0?"+":""}${s.avgPnl.toFixed(0)}
                          </span>
                        ) : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="text-right px-3 py-2.5">
                        {s.fires > 0 ? (
                          <span className={`font-bold ${s.totalPnl>=0?"text-green-400":"text-red-400"}`}>
                            {s.totalPnl>=0?"+":""}${Math.round(s.totalPnl)}
                          </span>
                        ) : <span className="text-slate-700">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Best / worst highlights */}
          {results.stratSums.some(s => s.best || s.worst) && (
            <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60 space-y-2">
              <div className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">Mejores & Peores trades</div>
              {results.stratSums.filter(s => s.best || s.worst).map(s => (
                <div key={s.id} className="grid grid-cols-2 gap-2 text-xs">
                  {s.best && (
                    <div className="bg-green-900/20 border border-green-900/40 rounded-xl px-2.5 py-2">
                      <div className="text-green-400 font-bold">↑ Mejor E{s.id}</div>
                      <div className="text-slate-400">{s.best.sym} {s.best.date}</div>
                      <div className="text-green-300 font-mono">+${s.best.pnl?.toFixed(0)}</div>
                    </div>
                  )}
                  {s.worst && (
                    <div className="bg-red-900/20 border border-red-900/40 rounded-xl px-2.5 py-2">
                      <div className="text-red-400 font-bold">↓ Peor E{s.id}</div>
                      <div className="text-slate-400">{s.worst.sym} {s.worst.date}</div>
                      <div className="text-red-300 font-mono">${s.worst.pnl?.toFixed(0)}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Trades list (collapsible) */}
          <div className="bg-slate-800 rounded-2xl border border-slate-700/60 overflow-hidden">
            <button onClick={() => setShowTrades(v => !v)}
              className="w-full px-4 py-3 flex justify-between items-center">
              <span className="text-slate-300 font-semibold text-sm">
                Lista de trades ({filteredTrades.length})
              </span>
              <span className="text-slate-600 text-xs">{showTrades ? "▲" : "▼"}</span>
            </button>

            {showTrades && (
              <>
                {/* Filters */}
                <div className="px-3 py-2 border-t border-b border-slate-700/40 flex gap-1.5 flex-wrap">
                  <select value={filterSym} onChange={e => setFilterSym(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todos los tickers</option>
                    {BT_SYMS.map(s => <option key={s}>{s}</option>)}
                  </select>
                  <select value={filterStrat} onChange={e => setFilterStrat(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todas las estrategias</option>
                    {STRATS.map(s => <option key={s.id} value={String(s.id)}>E{s.id} — {s.name}</option>)}
                  </select>
                  <select value={filterOutcome} onChange={e => setFilterOutcome(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todos</option>
                    <option value="WIN">WIN ✓</option>
                    <option value="LOSS">LOSS ✗</option>
                    <option value="NEUTRAL">NEUTRAL</option>
                  </select>
                </div>

                <div className="max-h-80 overflow-y-auto divide-y divide-slate-700/20">
                  {filteredTrades.length === 0 ? (
                    <div className="text-center text-slate-600 text-xs py-8">Sin trades con estos filtros</div>
                  ) : (
                    filteredTrades.map(t => (
                      <div key={t.id} className="px-3 py-2.5 flex items-center gap-2">
                        <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded font-bold
                          ${t.outcome==="WIN"?"bg-green-900/60 text-green-400"
                            :t.outcome==="LOSS"?"bg-red-900/60 text-red-400"
                            :"bg-slate-700 text-slate-500"}`}>
                          {t.outcome}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline">
                            <span className="text-white font-bold text-xs">{t.sym}</span>
                            <span className="text-slate-600 text-xs">{t.date}</span>
                          </div>
                          <div className="text-slate-500 text-xs truncate">
                            E{t.stratId} {t.dir} · entrada ${parseFloat(t.entry).toFixed(2)} · salida ${parseFloat(t.exitPrice).toFixed(2)}
                          </div>
                        </div>
                        <span className={`shrink-0 font-mono font-bold text-xs ${(t.pnl??0)>=0?"text-green-400":"text-red-400"}`}>
                          {(t.pnl??0)>=0?"+":""}${Math.round(t.pnl??0)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: REF
// ═══════════════════════════════════════════════════════════════════════════════
function TabRef() {
  return (
    <div className="space-y-3">
      <h2 className="text-white font-bold">Referencia Kaizen</h2>

      {/* Rangos óptimos */}
      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
        <h3 className="text-yellow-400 font-bold text-sm mb-2.5">Rangos Óptimos de Premium</h3>
        <div className="space-y-1">
          {TICKERS.filter(t=>t.range).map(tk=>(
            <div key={tk.sym} className="flex items-center gap-2 text-xs py-0.5 border-b border-slate-700/30 last:border-0">
              <span className="text-white font-bold w-12 shrink-0">{tk.sym}</span>
              <span className="text-slate-400 flex-1 truncate">{tk.name}</span>
              <span className="text-green-400 font-mono shrink-0">${tk.range[0]}–${tk.range[1]}</span>
            </div>
          ))}
        </div>
      </div>

      {[
        { title:"Checklist — 10 Requisitos", color:"text-cyan-400", bullets:[
          "1. Reunión FED (cada 45 días)",
          "2. Earnings (cada 3 meses)",
          "3. Bollinger 15min/1H/Diario — punto medio",
          "4. Medias Móviles Hora/Día — techos/pisos",
          "5. Ruptura de líneas de tendencia",
          "6. GAP al alza o a la baja (>0.5%)",
          "7. Spread BID-ASK máximo 5%",
          "8. Distancia Spot/Strike por día (DTE)",
          "9-10. Dos registros de trade por operación",
        ]},
        { title:"Planes de Ganancia", color:"text-blue-400", items:[
          ["Plan 10%","Swing rápido. 1–5 días"],
          ["Plan 35%","Swing medio. 1–4 semanas"],
          ["Plan 100%","Tendencia mayor. 1–3 meses"],
        ]},
        { title:"Bollinger Bands", color:"text-purple-400", bullets:[
          "Precio en banda inferior → zona de compra",
          "%B < 20% → sobreventa técnica",
          "Precio en banda superior → zona de venta",
          "%B > 80% → sobrecompra técnica",
          "BB width < 3% → 🚫 BAJA VOLATILIDAD — no entrar",
          "Bandas estrechas → ruptura inminente",
        ]},
        { title:"Medias Móviles (SMA)", color:"text-green-400", bullets:[
          "Precio > MA20 → tendencia corto plazo alcista",
          "Precio > MA50 → tendencia medio plazo alcista",
          "MA20 cruza MA50 arriba → Golden Cross (alcista)",
          "MA20 cruza MA50 abajo → Death Cross (bajista)",
        ]},
        { title:"Gestión de Riesgo", color:"text-red-400", bullets:[
          "Máx 2–3% del capital total por operación",
          "NO hay stop loss automático — dejar correr hasta objetivo o vencimiento",
          "Refuerzo: si −50%, comprar más contratos mismo strike (máx = monto inicial)",
          "Comisión: $2 por operación (incluir en cálculo)",
          "Rango Ask contrato: verificar que el precio esté dentro del rango óptimo",
          "Completar el checklist ANTES de entrar",
        ]},
        { title:"DTE por Día de Semana", color:"text-orange-400", items:[
          ["Lunes","DTE 5 días"],
          ["Martes","DTE 4 días"],
          ["Miércoles","DTE 3 días"],
          ["Jueves","DTE 2 días"],
          ["Viernes","DTE 1 día"],
        ]},
      ].map(sec=>(
        <div key={sec.title} className="bg-slate-800 rounded-2xl p-4 border border-slate-700/60">
          <h3 className={`font-bold text-sm mb-2.5 ${sec.color}`}>{sec.title}</h3>
          {sec.items?.map(([k,v])=>(
            <div key={k} className="flex gap-2 text-xs mb-1">
              <span className="text-slate-400 w-20 shrink-0">{k}</span>
              <span className="text-slate-300">{v}</span>
            </div>
          ))}
          {sec.bullets && (
            <ul className="space-y-1.5">
              {sec.bullets.map(b=>(
                <li key={b} className="text-xs text-slate-300 flex gap-1.5">
                  <span className="text-slate-600 shrink-0">•</span>{b}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab,             setTab]            = useState(0);
  const [apiKey,          setApiKey]         = useState(() => localStorage.getItem(LS.KEY) || "");
  const [market,          setMarket]         = useState({});
  const [loading,         setLoading]        = useState(false);
  const [errors,          setErrors]         = useState({});
  const [showModal,       setShowModal]      = useState(false);
  const [showSelector,    setShowSelector]   = useState(false);
  // countdown: null | { remaining, nextGroup, totalGroups }
  const [countdown,       setCountdown]      = useState(null);
  const [selectedTickers, setSelectedTickers]= useState(() => {
    const saved = load(LS.SEL, DEFAULT_SEL);
    return saved.filter(s => SYMS.includes(s)).slice(0, CHUNK_SIZE);
  });

  // Core fetch — loads only selectedTickers in chunks of CHUNK_SIZE
  const fetchAll = useCallback(async (key = apiKey, syms = selectedTickers) => {
    if (!key || loading) return;
    setLoading(true);
    setMarket({});
    setErrors({});
    setCountdown(null);

    await fetchAllTickers(syms, key, {
      onCountdown: cd => setCountdown(cd),
      onBatch: ({ results, errors: errs }) => {
        setMarket(prev => ({ ...prev, ...results }));
        setErrors(prev => ({ ...prev, ...errs }));
      },
    });

    setLoading(false);
    setCountdown(null);
  }, [apiKey, selectedTickers, loading]); // eslint-disable-line

  useEffect(() => {
    if (apiKey) fetchAll(apiKey, load(LS.SEL, DEFAULT_SEL).filter(s => SYMS.includes(s)).slice(0, CHUNK_SIZE));
    else setShowModal(true);
  }, []); // eslint-disable-line

  const handleSaveKey = key => {
    localStorage.setItem(LS.KEY, key);
    setApiKey(key);
    setShowModal(false);
    fetchAll(key, selectedTickers);
  };

  const handleApplySelection = syms => {
    const valid = syms.filter(s => SYMS.includes(s)).slice(0, CHUNK_SIZE);
    setSelectedTickers(valid);
    save(LS.SEL, valid);
    setMarket({});
    setErrors({});
    setShowSelector(false);
    fetchAll(apiKey, valid);
  };

  const views = [
    <TabMercado key="m"  market={market} loading={loading} errors={errors}
      onRefresh={() => fetchAll()} selectedTickers={selectedTickers}
      countdown={countdown} onOpenSelector={() => setShowSelector(true)}/>,
    <TabSenial  key="s"  market={market} selectedTickers={selectedTickers}/>,
    <TabCheck   key="ch" market={market} selectedTickers={selectedTickers}/>,
    <TabCalc    key="ca" market={market} selectedTickers={selectedTickers}/>,
    <TabTrades  key="t"/>,
    <TabBot      key="bot"  market={market} selectedTickers={selectedTickers} apiKey={apiKey}/>,
    <TabBacktest key="bt"   apiKey={apiKey}/>,
    <TabRef      key="r"/>,
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-white select-none">
      {showModal && <ApiKeyModal onSave={handleSaveKey}/>}
      {showSelector && (
        <TickerSelector
          selected={selectedTickers}
          onApply={handleApplySelection}
          onClose={() => setShowSelector(false)}
        />
      )}

      {/* Header */}
      <header className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-4 py-3 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <span className="text-xs font-black text-white">K</span>
          </div>
          <span className="text-white font-black text-sm tracking-wide">KAIZEN TRADING</span>
        </div>
        <div className="flex items-center gap-3">
          {loading && <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"/>}
          {/* Ticker pills — tap to open selector */}
          <button onClick={() => setShowSelector(true)}
            className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-2 py-1 transition-colors">
            {selectedTickers.length > 0
              ? selectedTickers.map(s => (
                  <span key={s} className="text-blue-300 text-xs font-bold">{s}</span>
                )).reduce((a, b) => [a, <span key="·" className="text-slate-600 text-xs">·</span>, b])
              : <span className="text-slate-500 text-xs">Sin selección</span>
            }
            <span className="text-slate-600 text-xs ml-1">▾</span>
          </button>
          <button onClick={() => setShowModal(true)} className="text-slate-600 hover:text-slate-400 text-xs transition-colors">API</button>
        </div>
      </header>

      {/* Content */}
      <main className="px-4 pt-4 pb-28 max-w-lg mx-auto">
        {views[tab]}
      </main>

      {/* Bottom nav — 6 tabs */}
      <nav className="fixed bottom-0 left-0 right-0 bg-slate-900/95 backdrop-blur border-t border-slate-800">
        <div className="flex max-w-lg mx-auto">
          {TABS.map((label, i) => (
            <button key={label} onClick={() => setTab(i)}
              className={`flex-1 py-3.5 text-xs font-semibold transition-all relative ${tab===i?"text-blue-400":"text-slate-600 hover:text-slate-400"}`}>
              {tab===i && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-blue-500 rounded-full"/>
              )}
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
