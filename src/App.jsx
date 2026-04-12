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

  const etCheck  = getETNow();
  const dow      = etCheck.getDay();   // 0=Sun 1=Mon … 5=Fri … 6=Sat
  const isPMCheck = etCheck.getHours() >= 12;
  // DTE with Friday 12pm + same-day exception
  const todayDTE = (() => {
    if (dow < 1 || dow > 5) return null;
    if (dow === 5 && isPMCheck) return null; // Friday after 12pm → next week (shown as warning)
    return DTES[dow - 1];
  })();
  const fridayPMWarn = dow === 5 && isPMCheck;

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
        {fridayPMWarn ? (
          <div className="text-xs text-amber-400 mb-2 font-bold bg-amber-900/20 rounded-lg px-2 py-1.5">
            ⚠ Viernes &gt;12pm — elegir expiración de la SEMANA SIGUIENTE
          </div>
        ) : todayDTE && (
          <div className="text-xs text-blue-400 mb-2 font-medium">
            Hoy {DAYS[dow-1]}: DTE recomendado = {todayDTE} días
            {isPMCheck && todayDTE <= 1 && (
              <span className="text-amber-400 ml-1">— ya &gt;12pm, verificar que no sea expiración hoy</span>
            )}
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

  // DTE recommendation with Friday 12pm exception
  const etNowCalc = getETNow();
  const dowCalc   = etNowCalc.getDay();
  const isPMCalc  = etNowCalc.getHours() >= 12;
  const { dteRec, dteNote, dteWarn } = (() => {
    if (dowCalc === 5 && isPMCalc)
      return { dteRec: 7, dteNote: "Viernes >12pm → expiración SEMANA SIGUIENTE (~7 días)", dteWarn: true };
    if (dowCalc >= 1 && dowCalc <= 5) {
      const base = DTES[dowCalc - 1];
      const sameDay = base === 0 || (base === 1 && isPMCalc);
      if (sameDay)
        return { dteRec: DTES[Math.min(dowCalc, 4)], dteNote: "Expiración hoy >12pm → elegir siguiente fecha disponible", dteWarn: true };
      return { dteRec: base, dteNote: `${DAYS[dowCalc-1]}: DTE ${base} días`, dteWarn: false };
    }
    return { dteRec: null, dteNote: "Mercado cerrado (fin de semana)", dteWarn: false };
  })();

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

        {/* DTE recommendation */}
        {dteRec !== null && (
          <div className={`flex justify-between items-center text-xs px-3 py-2 rounded-xl border
            ${dteWarn ? "bg-amber-900/30 border-amber-700/50" : "bg-slate-700/50 border-slate-600/50"}`}>
            <div>
              <div className={`font-bold ${dteWarn ? "text-amber-300" : "text-slate-300"}`}>
                {dteWarn ? "⚠ " : ""}Expiración recomendada
              </div>
              <div className={`mt-0.5 ${dteWarn ? "text-amber-400/80" : "text-slate-500"}`}>{dteNote}</div>
            </div>
            <div className={`font-black text-2xl ${dteWarn ? "text-amber-300" : "text-blue-400"}`}>
              {dteRec}d
            </div>
          </div>
        )}

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

// Returns today's date string in ET timezone (YYYY-MM-DD)
function getETDateStr(etNow) {
  const yy = etNow.getFullYear();
  const mm = String(etNow.getMonth() + 1).padStart(2, "0");
  const dd = String(etNow.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Kaizen expiry selection rule:
//   - Always pick nearest available expiration
//   - Exception 1: same-day expiry after 12pm ET → skip to next date
//   - Exception 2: Friday after 12pm ET → skip entire week, go to next week
function pickExpiry(exps, etNow) {
  if (!exps?.length) return null;
  const todayStr = getETDateStr(etNow);
  const hour  = etNow.getHours();
  const dow   = etNow.getDay(); // 0=Sun … 5=Fri … 6=Sat
  const isPM  = hour >= 12;

  for (const exp of exps) {
    // Days from today to this expiry (calendar days, UTC noon-to-noon to avoid DST issues)
    const daysOut = Math.round(
      (new Date(exp + "T12:00:00Z") - new Date(todayStr + "T12:00:00Z")) / 86400000
    );
    // Exception 1: same-day expiry (0DTE) after 12pm → skip
    if (daysOut <= 0 && isPM) continue;
    // Exception 2: Friday after 12pm → only accept expiry 7+ days out (next week)
    if (dow === 5 && isPM && daysOut < 7) continue;
    return exp;
  }
  // Fallback: last available expiry
  return exps[exps.length - 1];
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
          const etNow = getETNow();
          const dow   = etNow.getDay();

          // Nearest valid expiration (Kaizen rule: nearest, skip same-day after 12pm, skip week if Friday after 12pm)
          const exps = await trGetExpirations(t, sym);
          if (!exps.length) { addLog(`${sym}: sin vencimientos disponibles`, "error"); break; }
          const expDate = pickExpiry(exps, etNow);
          if (!expDate) { addLog(`${sym}: sin vencimiento válido (regla horario)`, "error"); break; }

          // Options chain
          const chain = await trGetChain(t, sym, expDate);
          const optType = strat.dir === "CALL" ? "call" : "put";
          const filtered = chain.filter(o => o.option_type === optType && o.ask > 0);
          if (!filtered.length) { addLog(`${sym}: cadena de opciones vacía`, "error"); break; }

          // Target strike by OTM %
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
// BACKTEST ENGINE — E1/E2 Cambio de Tendencia + E3/E4 Rebote Punto Medio
// ═══════════════════════════════════════════════════════════════════════════════
const BT_CAPITAL      = 10000;  // virtual starting capital
const BT_POS_PCT      = 0.05;   // 5% of equity per trade
const BT_WIN_PCT      = 0.35;   // Plan 35% profit target
const BT_COMM         = 2;      // $2 commission per round-trip
const BT_SYMS         = ["TSLA", "GOOGL", "MSFT", "META"];
const BT_WIN_MOVE_15M = 0.015;  // 1.5% stock move = WIN (next 4 fifteen-min bars)
// Sell limit rule (global): entry × plan_mult + $2 commission
// Plan 10%: ×1.10 + $2 · Plan 35%: ×1.35 + $2 · Plan 100%: ×2.00 + $2

// ─── Backtest data helpers ────────────────────────────────────────────────────

// Binary search: last bar index with timestamp ≤ targetTs (bars must be sorted asc)
function findBarIndex(bars, targetTs) {
  let lo = 0, hi = bars.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= targetTs) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// True if lows[] shows a general downtrend (≥60% of consecutive pairs are lower)
function checkLowerLows(lows) {
  if (lows.length < 4) return false;
  let down = 0;
  for (let i = 1; i < lows.length; i++) { if (lows[i] < lows[i-1]) down++; }
  return down >= Math.ceil((lows.length - 1) * 0.6);
}

// True if highs[] shows a general uptrend (≥60% of consecutive pairs are higher)
function checkHigherHighs(highs) {
  if (highs.length < 4) return false;
  let up = 0;
  for (let i = 1; i < highs.length; i++) { if (highs[i] > highs[i-1]) up++; }
  return up >= Math.ceil((highs.length - 1) * 0.6);
}

// Volume stochastic %K over last `period` bars (approximates Worden Stochastics)
// Returns 0–100; > 80 = volume surge ("cruza línea roja")
function volStochK(vols, period = 14) {
  if (vols.length < period) return 0;
  const sl = vols.slice(-period);
  const lo = Math.min(...sl), hi = Math.max(...sl);
  if (hi === lo) return 50;
  return ((sl[sl.length - 1] - lo) / (hi - lo)) * 100;
}

// True if a Polygon timestamp (ms UTC) corresponds to 9:30 AM ET (market open bar)
function isMarketOpen15(tsMs) {
  const s = new Date(tsMs).toLocaleString("en-US", { timeZone: "America/New_York" });
  const d = new Date(s);
  return d.getHours() === 9 && d.getMinutes() === 30;
}

// 1H bars — 3 months (signal detection + MA/BB warmup)
async function fetch1HBars(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 4);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/hour/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=2000&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url); }
  catch { throw new Error(`Red — ${sym}`); }
  if (res.status === 429) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, [15000,30000,60000][attempt])); return fetch1HBars(sym, apiKey, attempt+1); }
    throw new Error(`429 — ${sym}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${sym}`);
  return (await res.json()).results || [];
}

// 15-minute bars — 3 months (condition 4 + WIN detection)
async function fetch15MinBars(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 3);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/15/minute/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url); }
  catch { throw new Error(`Red — ${sym}`); }
  if (res.status === 429) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, [15000,30000,60000][attempt])); return fetch15MinBars(sym, apiKey, attempt+1); }
    throw new Error(`429 — ${sym}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${sym}`);
  return (await res.json()).results || [];
}

// Daily bars — 6 months (for E3/E4 daily BB mid context)
async function fetchDailyBars(sym, apiKey, attempt = 0) {
  const to   = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 6);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/`
    + `${from.toISOString().split("T")[0]}/${to.toISOString().split("T")[0]}`
    + `?adjusted=true&sort=asc&limit=200&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url); }
  catch { throw new Error(`Red — ${sym}`); }
  if (res.status === 429) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, [15000,30000,60000][attempt])); return fetchDailyBars(sym, apiKey, attempt+1); }
    throw new Error(`429 — ${sym}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${sym}`);
  return (await res.json()).results || [];
}

// Returns daily BB context at the timestamp of a given hourly bar.
// Needs ≥20 daily bars before that point.
function getDailyCtx(dailyBars, hourlyTs) {
  const idx = findBarIndex(dailyBars, hourlyTs);
  if (idx < 20) return null;
  const closes  = dailyBars.slice(0, idx + 1).map(b => b.c);
  const bb      = calcBB(closes, 20);
  const bbPrev  = calcBB(closes.slice(0, -1), 20);
  if (!bb || !bbPrev) return null;
  const bbMidSlope = (bb.mid - bbPrev.mid) / bbPrev.mid; // relative daily PM slope
  return {
    bbMid:       bb.mid,
    bbMidUp:     bb.mid > bbPrev.mid,
    bbMidSlope,                              // >0 rising, <0 falling, ≈0 lateral
    priceAbove:  dailyBars[idx].c > bb.mid,
  };
}

// ─── Backtest — E1/E2 Cambio de Tendencia + E3/E4 Rebote Punto Medio ──────────
// E1 CALL: 1H downtrend (lower lows) → break up (close > recent highs) →
//          MA20 cross up + bullish candle → 15min BB mid pointing up + price > mid
//          → Volatilidad BB_1H > 2 %
//          WIN = +1.5 % move in next 4 fifteen-min bars
//
// E2 PUT:  1H uptrend (higher highs) → break down (close < recent lows) →
//          MA20 cross down + bearish candle → 15min BB mid pointing down + price < mid
//          → Volatilidad BB_1H > 2 %
//          WIN = −1.5 % move in next 4 fifteen-min bars
function runBacktest(h1Data, m15Data, dailyData) {
  const rawTrades = [];

  for (const sym of BT_SYMS) {
    const h1Bars   = h1Data[sym]    || [];
    const m15Bars  = m15Data[sym]   || [];
    const dayBars  = dailyData[sym] || [];
    if (h1Bars.length < 45 || m15Bars.length < 25) continue;

    for (let i = 42; i < h1Bars.length - 2; i++) {
      const bar  = h1Bars[i];
      const prev = h1Bars[i - 1];

      // ── 1H context ───────────────────────────────────────────────────────────
      const closes1H = h1Bars.slice(0, i + 1).map(b => b.c);
      const ma20_1H  = sma(closes1H, 20);
      const ma40_1H  = sma(closes1H, 40);
      const bb1H     = calcBB(closes1H, 20);
      const bb1HPrev = calcBB(closes1H.slice(0, -1), 20);
      if (!ma20_1H || !ma40_1H || !bb1H || !bb1HPrev) continue;

      // Trend window: last 13 hourly bars BEFORE current bar (≈ 2 trading days)
      // Global rule: min 2 days of trend required for E1/E2 (strategy 5/6 exempt)
      const tWin   = h1Bars.slice(Math.max(0, i - 13), i);
      if (tWin.length < 7) continue;
      const lows13  = tWin.map(b => b.l);
      const highs13 = tWin.map(b => b.h);

      // ── 15min context — find last bar at or before this 1H bar's close ───────
      const m15Idx = findBarIndex(m15Bars, bar.t);
      if (m15Idx < 22) continue;

      const m15Cl   = m15Bars.slice(0, m15Idx + 1).map(b => b.c);
      const m15BB   = calcBB(m15Cl, 20);
      const m15BBpr = calcBB(m15Cl.slice(0, -1), 20);
      const m15Bar  = m15Bars[m15Idx];
      if (!m15BB || !m15BBpr) continue;

      // ── Daily context (for E3/E4) ─────────────────────────────────────────────
      const dayCtx = dayBars.length >= 21 ? getDailyCtx(dayBars, bar.t) : null;

      const dateStr = new Date(bar.t).toISOString().split("T")[0];

      // ── Helper: enter + check WIN in next N fifteen-min bars ─────────────────
      const tryTrade = (dir, stratId, stratName, nBars = 4) => {
        const nextM15 = m15Idx + 1;
        if (nextM15 >= m15Bars.length) return;
        const entry  = m15Bars[nextM15].o;
        const target = dir === "CALL" ? entry * (1 + BT_WIN_MOVE_15M)
                                      : entry * (1 - BT_WIN_MOVE_15M);
        let outcome  = "LOSS";
        for (let j = nextM15; j <= nextM15 + nBars - 1 && j < m15Bars.length; j++) {
          if (dir === "CALL" ? m15Bars[j].h >= target : m15Bars[j].l <= target) {
            outcome = "WIN"; break;
          }
        }
        rawTrades.push({ id:`${sym}_${dir.toLowerCase()}_${bar.t}`,
          date:dateStr, sym, dir, stratId, stratName, entry, outcome });
      };

      // ── E1: CALL — Cambio de Tendencia al Alza ───────────────────────────────
      // Global rules: ≥2 days trend (13 1H bars), BB width >2%, DAY→HORA→15min order
      if (bb1H.width > 2) {
        const c1 = checkLowerLows(lows13);                                // ≥2d downtrend 1H
        const c2 = bar.c > Math.max(...tWin.map(b => b.h));              // breaks resistance
        const c3 = bar.c > ma20_1H && bar.c > bar.o && prev.c < ma20_1H; // MA20 cross up
        const c4 = m15Bar.c > m15BB.mid && m15BB.mid > m15BBpr.mid;      // 15min BB bullish
        if (c1 && c2 && c3 && c4) tryTrade("CALL", 1, "Cambio Tend. ↑");
      }

      // ── E2: PUT — Cambio de Tendencia a la Baja ──────────────────────────────
      if (bb1H.width > 2) {
        const c1 = checkHigherHighs(highs13);                             // ≥2d uptrend 1H
        const c2 = bar.c < Math.min(...tWin.map(b => b.l));              // breaks support
        const c3 = bar.c < ma20_1H && bar.c < bar.o && prev.c > ma20_1H; // MA20 cross down
        const c4 = m15Bar.c < m15BB.mid && m15BB.mid < m15BBpr.mid;      // 15min BB bearish
        if (c1 && c2 && c3 && c4) tryTrade("PUT", 2, "Cambio Tend. ↓");
      }

      // ── E3: PUT — Rebote Punto Medio a la Baja ───────────────────────────────
      // Global rules: DAY bearish trend (≥2d) + PM NOT lateral + 1H volatility
      if (dayCtx) {
        // PM lateral guard: daily BB mid must be moving (slope > 0.03%/day)
        const pmNotLateral = Math.abs(dayCtx.bbMidSlope) > 0.0003;
        // C1: DIA BAJISTA — BB mid falling, price below daily BB mid, PM not lateral
        const c1 = !dayCtx.bbMidUp && !dayCtx.priceAbove && pmNotLateral;
        // C1b: 1H has some volatility (strategy needs movement)
        const cVol = bb1H.width > 1.0;
        // C2: 1H BULLISTA (rally hacia PM diario — precio sobre BB media 1H)
        const c2 = bar.c > bb1H.mid && bb1H.mid > bb1HPrev.mid;
        // C3+C4: Price touched daily BB mid from below (within ±0.3%), closed below
        const distUp = (bar.h - dayCtx.bbMid) / dayCtx.bbMid;
        const c3c4   = distUp >= -0.003 && distUp <= 0.005 && bar.c < dayCtx.bbMid;
        // C5: Vela confirmación 1H bajista + 15min bajista
        const c5 = bar.c < bar.o && m15Bar.c < m15Bar.o;
        if (c1 && cVol && c2 && c3c4 && c5) tryTrade("PUT", 3, "Rebote PM ↓", 8);
      }

      // ── E4: CALL — Rebote Punto Medio al Alza ────────────────────────────────
      if (dayCtx) {
        // PM lateral guard: daily BB mid must be moving
        const pmNotLateral = Math.abs(dayCtx.bbMidSlope) > 0.0003;
        // C1: DIA ALCISTA — BB mid rising, price above daily BB mid, PM not lateral
        const c1 = dayCtx.bbMidUp && dayCtx.priceAbove && pmNotLateral;
        // C1b: 1H has some volatility
        const cVol = bb1H.width > 1.0;
        // C2: 1H BAJISTA (pullback hacia PM diario — precio bajo BB media 1H)
        const c2 = bar.c < bb1H.mid && bb1H.mid < bb1HPrev.mid;
        // C3+C4: Price touched daily BB mid from above (within ±0.3%), closed above
        const distDown = (dayCtx.bbMid - bar.l) / dayCtx.bbMid;
        const c3c4     = distDown >= -0.003 && distDown <= 0.005 && bar.c > dayCtx.bbMid;
        // C5: Vela confirmación 1H alcista + 15min alcista
        const c5 = bar.c > bar.o && m15Bar.c > m15Bar.o;
        if (c1 && cVol && c2 && c3c4 && c5) tryTrade("CALL", 4, "Rebote PM ↑", 8);
      }

      // ── E8: PUT — Efecto Imán Alcista ────────────────────────────────────────
      // Global rules: ≥2d uptrend, MA20>MA40 (no entanglement, no MAs in the path)
      {
        const tWin35  = h1Bars.slice(Math.max(0, i - 34), i + 1);
        // C1: Clear BULLISH ≥5d, MA20>MA40, MAs clearly separated (gap >0.3% = clean path)
        const maGap   = (ma20_1H - ma40_1H) / ma40_1H;
        const c1      = checkHigherHighs(tWin35.map(b => b.h)) && ma20_1H > ma40_1H && maGap > 0.003;
        // C2: Gap UP > 1.5% vs previous close
        const gap     = (bar.o - prev.c) / prev.c;
        const c2      = gap > 0.015;
        // C3: Price > 2% above MA20 (very stretched — strong magnet pull)
        const c3      = bar.c > ma20_1H * 1.02;
        // C4: First 15min bar completely ABOVE upper BB (low > upper band)
        let firstInHourIdx = m15Idx;
        while (firstInHourIdx > 0 && m15Bars[firstInHourIdx - 1].t >= bar.t) firstInHourIdx--;
        const first15     = m15Bars[firstInHourIdx];
        const c4          = first15 && m15BB ? first15.l > m15BB.upper : false;
        // C5: Volume surge on 1H (Worden Stochastics proxy > 80 = "cruza línea roja")
        const vols1H  = h1Bars.slice(0, i + 1).map(b => b.v);
        const c5      = volStochK(vols1H, 14) > 80;
        if (c1 && c2 && c3 && c4 && c5) tryTrade("PUT", 8, "Efecto Imán ↑→PUT", 4);
      }

      // ── E7: CALL — Efecto Imán Bajista ───────────────────────────────────────
      // Global rules: ≥2d downtrend, MA20<MA40 (no entanglement, no MAs in the path)
      {
        const tWin35  = h1Bars.slice(Math.max(0, i - 34), i + 1);
        // C1: Clear BEARISH ≥5d, MA20<MA40, MAs clearly separated (clean downward path)
        const maGap   = (ma40_1H - ma20_1H) / ma40_1H;
        const c1      = checkLowerLows(tWin35.map(b => b.l)) && ma20_1H < ma40_1H && maGap > 0.003;
        // C2: Gap DOWN > 1.5% vs previous close
        const gap     = (bar.o - prev.c) / prev.c;
        const c2      = gap < -0.015;
        // C3: Price > 2% below MA20 (very stretched — strong magnet pull)
        const c3      = bar.c < ma20_1H * 0.98;
        // C4: First 15min bar completely BELOW lower BB (high < lower band)
        let firstInHourIdx = m15Idx;
        while (firstInHourIdx > 0 && m15Bars[firstInHourIdx - 1].t >= bar.t) firstInHourIdx--;
        const first15     = m15Bars[firstInHourIdx];
        const c4          = first15 && m15BB ? first15.h < m15BB.lower : false;
        // C5: Volume surge on 1H (Worden Stochastics proxy > 80)
        const vols1H  = h1Bars.slice(0, i + 1).map(b => b.v);
        const c5      = volStochK(vols1H, 14) > 80;
        if (c1 && c2 && c3 && c4 && c5) tryTrade("CALL", 7, "Efecto Imán ↓→CALL", 4);
      }
    }

    // ── E5/E6 Pass: market-open 15min signals ──────────────────────────────────
    // E5 PUT: lateral BB + gap UP above upper BB + price starts falling  (9:30 ET only)
    // E6 CALL: lateral BB + gap DOWN below lower BB + price starts rising (9:30 ET only)
    for (let j = 22; j < m15Bars.length - 5; j++) {
      if (!isMarketOpen15(m15Bars[j].t)) continue;

      const bar15   = m15Bars[j];
      const dateStr = new Date(bar15.t).toISOString().split("T")[0];

      // BB from last 20 bars BEFORE open (previous session closes)
      const bbPre = calcBB(m15Bars.slice(0, j).map(b => b.c), 20);
      if (!bbPre) continue;

      // C1: Totally lateral, NO volatility — BB width < 1%
      if (bbPre.width >= 1.0) continue;

      const tryTrade56 = (dir, stratId, stratName) => {
        const nextIdx = j + 1;
        if (nextIdx >= m15Bars.length) return;
        const entry  = m15Bars[nextIdx].o;
        const target = dir === "CALL" ? entry * (1 + BT_WIN_MOVE_15M)
                                      : entry * (1 - BT_WIN_MOVE_15M);
        let outcome = "LOSS";
        for (let k = nextIdx; k <= nextIdx + 3 && k < m15Bars.length; k++) {
          if (dir === "CALL" ? m15Bars[k].h >= target : m15Bars[k].l <= target) {
            outcome = "WIN"; break;
          }
        }
        rawTrades.push({ id:`${sym}_${dir.toLowerCase()}_${bar15.t}_e${stratId}`,
          date: dateStr, sym, dir, stratId, stratName, entry, outcome });
      };

      // E6 CALL: opens below lower BB (extreme oversold gap down) + bullish candle
      // C2: bar15.o < lower BB  C3: close > open (price starting to rise)
      if (bar15.o < bbPre.lower && bar15.c > bar15.o) {
        tryTrade56("CALL", 6, "Lat. Aper. ↓CALL");
      }

      // E5 PUT: opens above upper BB (extreme overbought gap up) + bearish candle
      // C2: bar15.o > upper BB  C3: close < open (price starting to fall)
      if (bar15.o > bbPre.upper && bar15.c < bar15.o) {
        tryTrade56("PUT", 5, "Lat. Aper. ↑PUT");
      }
    }
  }

  // Sort chronologically; compute equity curve
  rawTrades.sort((a, b) => a.date.localeCompare(b.date));

  let equity = BT_CAPITAL;
  const curve = [{ date: "Inicio", equity: BT_CAPITAL }];
  for (const t of rawTrades) {
    const invest = equity * BT_POS_PCT;
    t.pnl = t.outcome === "WIN" ? invest * BT_WIN_PCT - BT_COMM : -invest - BT_COMM;
    equity += t.pnl;
    curve.push({ date: t.date, equity });
  }

  // Per-strategy summaries
  const stratDefs = [
    { id:1, name:"Cambio Tend. ↑",    dir:"CALL" },
    { id:2, name:"Cambio Tend. ↓",    dir:"PUT"  },
    { id:3, name:"Rebote PM ↓",       dir:"PUT"  },
    { id:4, name:"Rebote PM ↑",       dir:"CALL" },
    { id:5, name:"Lat. Aper. ↑PUT",   dir:"PUT"  },
    { id:6, name:"Lat. Aper. ↓CALL",  dir:"CALL" },
    { id:7, name:"Efecto Imán ↓CALL", dir:"CALL" },
    { id:8, name:"Efecto Imán ↑PUT",  dir:"PUT"  },
  ];
  const stratSums = stratDefs.map(s => {
    const st   = rawTrades.filter(t => t.stratId === s.id);
    const wins = st.filter(t => t.outcome === "WIN").length;
    const pnl  = st.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    return { ...s, fires:st.length, wins,
      winRate: st.length ? wins / st.length * 100 : 0, pnl };
  });

  const callTrades = rawTrades.filter(t => t.dir === "CALL");
  const putTrades  = rawTrades.filter(t => t.dir === "PUT");
  const callWins   = callTrades.filter(t => t.outcome === "WIN").length;
  const putWins    = putTrades.filter(t => t.outcome === "WIN").length;
  const callPnl    = callTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const putPnl     = putTrades.reduce((s, t)  => s + (t.pnl ?? 0), 0);
  const totalWins  = rawTrades.filter(t => t.outcome === "WIN").length;

  return {
    trades: rawTrades, curve, equity, stratSums,
    totalTrades: rawTrades.length, totalWins,
    winRate:     rawTrades.length   ? totalWins / rawTrades.length   * 100 : 0,
    totalPnl:    equity - BT_CAPITAL,
    callTrades:  callTrades.length, callWins, callPnl,
    callWinRate: callTrades.length  ? callWins / callTrades.length   * 100 : 0,
    putTrades:   putTrades.length,  putWins,  putPnl,
    putWinRate:  putTrades.length   ? putWins  / putTrades.length    * 100 : 0,
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
    const h1Data   = {};
    const m15Data  = {};
    const dayData  = {};
    // 4 symbols × 3 timeframes = 12 calls; 15s between each (~3 min total)
    const allFetches = [
      ...BT_SYMS.map(sym => ({ sym, type: "1h"  })),
      ...BT_SYMS.map(sym => ({ sym, type: "15m" })),
      ...BT_SYMS.map(sym => ({ sym, type: "day" })),
    ];
    try {
      for (let i = 0; i < allFetches.length; i++) {
        const { sym, type } = allFetches[i];
        const lbl = type === "1h" ? "1H" : type === "15m" ? "15min" : "Diario";
        setProgress(`${lbl} ${sym} (${i+1}/${allFetches.length})…`);
        if (type === "1h")  h1Data[sym]  = await fetch1HBars(sym, apiKey);
        else if (type === "15m") m15Data[sym] = await fetch15MinBars(sym, apiKey);
        else                dayData[sym] = await fetchDailyBars(sym, apiKey);
        if (i < allFetches.length - 1) {
          for (let s = 15; s >= 1; s--) {
            setProgress(`Esperando ${s}s — límite API… (${i+1}/${allFetches.length})`);
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
      setProgress("Detectando señales (E1–E4, E7–E8)…");
      await new Promise(r => setTimeout(r, 50));
      setResults(runBacktest(h1Data, m15Data, dayData));
    } catch(e) { setError(e.message); }
    setProgress(""); setRunning(false);
  };

  const filteredTrades = results?.trades.filter(t => {
    if (filterSym     !== "all" && t.sym              !== filterSym)     return false;
    if (filterStrat   !== "all" && String(t.stratId)  !== filterStrat)   return false;
    if (filterOutcome !== "all" && t.outcome           !== filterOutcome) return false;
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
        <div className="text-slate-300 text-xs font-semibold mb-1">8 Estrategias — Metodología Kaizen · DIA→HORA→15MIN</div>
        <div className="text-slate-400 text-xs font-medium mt-0.5 mb-1">Reglas globales</div>
        <div className="text-slate-500 text-xs">• Mínimo 2 días de tendencia (E1–E4, E7–E8) · E5/E6 exentas (lateral apertura)</div>
        <div className="text-slate-500 text-xs">• Orden análisis: DIA → HORA → 15min (solo BB) · PM lateral = NO rebote</div>
        <div className="text-slate-400 text-xs font-medium mt-1 mb-0.5">Estrategias</div>
        <div className="text-slate-500 text-xs">• E1 CALL: bajista 1H ≥2d → rompe MA20 al alza + BB 15min alcista + volatilidad &gt;2%</div>
        <div className="text-slate-500 text-xs">• E2 PUT: alcista 1H ≥2d → rompe MA20 a la baja + BB 15min bajista + volatilidad &gt;2%</div>
        <div className="text-slate-500 text-xs">• E3 PUT: DIA bajista + PM no lateral + 1H alcista toca PM día + confirmación 15min</div>
        <div className="text-slate-500 text-xs">• E4 CALL: DIA alcista + PM no lateral + 1H bajista toca PM día + confirmación 15min</div>
        <div className="text-slate-500 text-xs">• E5 PUT: BB &lt;1% lateral día anterior + gap sube &gt;BB sup a las 9:30 ET + vela bajista</div>
        <div className="text-slate-500 text-xs">• E6 CALL: BB &lt;1% lateral día anterior + gap baja &lt;BB inf a las 9:30 ET + vela alcista</div>
        <div className="text-slate-500 text-xs">• E7 CALL: bajista ≥2d + MA20&lt;MA40 limpio + gap baja &gt;1.5% + 15min bajo BB inf + vol surge</div>
        <div className="text-slate-500 text-xs">• E8 PUT: alcista ≥2d + MA20&gt;MA40 limpio + gap sube &gt;1.5% + 15min sobre BB sup + vol surge</div>
        <div className="text-slate-500 text-xs">• WIN E1/E2/E5–E8 = ±1.5% en 4×15min · WIN E3/E4 = ±1.5% en 8×15min (2h para rebote)</div>
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
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Señales totales", results.totalTrades, "text-white"],
              ["Acierto global",  results.totalTrades ? results.winRate.toFixed(1)+"%" : "—",
               results.winRate >= 50 ? "text-green-400" : "text-red-400"],
              ["Capital final",   `$${Math.round(results.equity).toLocaleString()}`,
               results.equity >= BT_CAPITAL ? "text-green-400" : "text-red-400"],
              ["P&L simulado",    `${results.totalPnl>=0?"+":""}$${Math.round(results.totalPnl)}`,
               results.totalPnl >= 0 ? "text-green-400" : "text-red-400"],
            ].map(([lbl,val,cls]) => (
              <div key={lbl} className="bg-slate-800 rounded-xl px-3 py-3 text-center border border-slate-700/40">
                <div className="text-slate-500 text-xs mb-0.5">{lbl}</div>
                <div className={`font-bold text-xl ${cls}`}>{val}</div>
              </div>
            ))}
          </div>

          {/* Per-strategy breakdown */}
          <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60">
            <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">Resultado por Estrategia</div>
            <div className="grid grid-cols-2 gap-2">
              {results.stratSums.map(s => (
                <div key={s.id} className={`rounded-xl px-3 py-2.5 border
                  ${s.dir==="CALL"?"bg-green-900/15 border-green-900/40":"bg-red-900/15 border-red-900/40"}`}>
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <span className={`font-black text-xs ${s.dir==="CALL"?"text-green-400":"text-red-400"}`}>
                        E{s.id} {s.dir}
                      </span>
                      <div className="text-slate-500 text-xs">{s.name}</div>
                    </div>
                    <div className={`font-black text-xl ${s.winRate>=50?"text-green-400":s.winRate>0?"text-yellow-400":"text-slate-600"}`}>
                      {s.fires ? s.winRate.toFixed(0)+"%" : "—"}
                    </div>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{s.fires} señales · {s.wins}W {s.fires-s.wins}L</span>
                    <span className={`font-bold ${s.pnl>=0?"text-green-400":"text-red-400"}`}>
                      {s.pnl>=0?"+":""}${Math.round(s.pnl)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {/* Total row */}
            <div className="mt-2 bg-slate-700/40 rounded-xl px-3 py-2 flex justify-between items-center">
              <span className="text-slate-300 text-xs font-bold">Total ({results.totalTrades} señales)</span>
              <div className="flex gap-3 text-xs">
                <span className={`font-black text-base ${results.winRate>=50?"text-green-400":results.winRate>0?"text-yellow-400":"text-red-400"}`}>
                  {results.winRate.toFixed(1)}%
                </span>
                <span className={`font-bold ${results.totalPnl>=0?"text-green-400":"text-red-400"}`}>
                  {results.totalPnl>=0?"+":""}${Math.round(results.totalPnl)}
                </span>
              </div>
            </div>
          </div>

          {/* Conditions legend */}
          <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60 space-y-2">
            <div className="text-slate-400 text-xs font-bold uppercase tracking-wider">Condiciones evaluadas</div>
            {[
              { label:"E1 CALL — Cambio Tendencia ↑", color:"text-green-400", bg:"bg-green-900/20",
                conds:["REGLA GLOBAL: ≥2 días tendencia · DIA→HORA→15min · BB 1H >2% (volatilidad)",
                       "C1: Tendencia BAJISTA 1H ≥2 días (mínimos más bajos, ≥60% de 13 barras)",
                       "C2: Rompe resistencia — cierre > máximos del período de tendencia",
                       "C3: Cruza MA20 al alza con vela alcista; barra anterior estaba bajo MA20",
                       "C4: BB 15min — precio > media y media apunta arriba  |  WIN: +1.5% en 4×15min"] },
              { label:"E2 PUT — Cambio Tendencia ↓",  color:"text-red-400",   bg:"bg-red-900/20",
                conds:["REGLA GLOBAL: ≥2 días tendencia · DIA→HORA→15min · BB 1H >2% (volatilidad)",
                       "C1: Tendencia ALCISTA 1H ≥2 días (máximos más altos, ≥60% de 13 barras)",
                       "C2: Rompe soporte — cierre < mínimos del período de tendencia",
                       "C3: Cruza MA20 a la baja con vela bajista; barra anterior estaba sobre MA20",
                       "C4: BB 15min — precio < media y media apunta abajo  |  WIN: −1.5% en 4×15min"] },
              { label:"E3 PUT — Rebote Punto Medio ↓", color:"text-red-400",  bg:"bg-red-900/20",
                conds:["REGLA GLOBAL: DIA bajista ≥2d + PM NO lateral (pendiente >0.03%/día) + vol 1H >1%",
                       "C1: DIA BAJISTA — BB media diaria apuntando abajo + precio bajo PM diario",
                       "C2: 1H ALCISTA — rally hacia PM diario (precio > BB media 1H subiendo)",
                       "C3+C4: Precio toca PM diario (máximo dentro ±0.3%) y cierra por debajo",
                       "C5: Vela confirmación 1H bajista + 15min bajista  |  WIN: −1.5% en 8×15min"] },
              { label:"E4 CALL — Rebote Punto Medio ↑", color:"text-green-400", bg:"bg-green-900/20",
                conds:["REGLA GLOBAL: DIA alcista ≥2d + PM NO lateral (pendiente >0.03%/día) + vol 1H >1%",
                       "C1: DIA ALCISTA — BB media diaria apuntando arriba + precio sobre PM diario",
                       "C2: 1H BAJISTA — pullback hacia PM diario (precio < BB media 1H bajando)",
                       "C3+C4: Precio toca PM diario (mínimo dentro ±0.3%) y cierra por encima",
                       "C5: Vela confirmación 1H alcista + 15min alcista  |  WIN: +1.5% en 8×15min"] },
              { label:"E5 PUT — Lateral Apertura Arriba", color:"text-red-400", bg:"bg-red-900/20",
                conds:["ÚNICA estrategia SIN tendencia previa — BB debe cerrar lateral el día anterior",
                       "C1: BB 15min COMPLETAMENTE LATERAL — ancho < 1% (calculado en cierre día anterior)",
                       "C2: GAP apertura AL ALZA — precio abre sobre disipador SUPERIOR (sobrecompra extrema)",
                       "C3: Precio comienza a BAJAR — vela 9:30 ET es bajista (cierre < apertura)",
                       "C4: Solo vela 9:30–9:35 ET válida  |  WIN: −1.5% en 4×15min · Sin señal = NO ENTRAR"] },
              { label:"E6 CALL — Lateral Apertura Abajo", color:"text-green-400", bg:"bg-green-900/20",
                conds:["ÚNICA estrategia SIN tendencia previa — BB debe cerrar lateral el día anterior",
                       "C1: BB 15min COMPLETAMENTE LATERAL — ancho < 1% (calculado en cierre día anterior)",
                       "C2: GAP apertura A LA BAJA — precio abre bajo disipador INFERIOR (sobreventa extrema)",
                       "C3: Precio comienza a SUBIR — vela 9:30 ET es alcista (cierre > apertura)",
                       "C4: Solo vela 9:30–9:35 ET válida  |  WIN: +1.5% en 4×15min · Sin señal = NO ENTRAR"] },
              { label:"E7 CALL — Efecto Imán Bajista", color:"text-green-400", bg:"bg-green-900/20",
                conds:["REGLA GLOBAL: ≥2d bajista · MA20<MA40 con recorrido limpio (separación >0.3%)",
                       "C1: 1H BAJISTA ≥5 días — mínimos más bajos, MA20 < MA40, NO entrelazadas ni en recorrido",
                       "C2: GAP apertura A LA BAJA > 1.5% vs cierre anterior",
                       "C3: Precio > 2% por debajo de MA20 (muy alejado — imán fuerte)",
                       "C4: Primera vela 15min completamente bajo disipador INFERIOR de BB",
                       "C5: Volumen 1H > línea roja Worden Stochastics (>80)  |  WIN: +1.5% en 4×15min"] },
              { label:"E8 PUT — Efecto Imán Alcista", color:"text-red-400", bg:"bg-red-900/20",
                conds:["REGLA GLOBAL: ≥2d alcista · MA20>MA40 con recorrido limpio (separación >0.3%)",
                       "C1: 1H ALCISTA ≥5 días — máximos más altos, MA20 > MA40, NO entrelazadas ni en recorrido",
                       "C2: GAP apertura AL ALZA > 1.5% vs cierre anterior",
                       "C3: Precio > 2% por encima de MA20 (muy alejado — imán fuerte)",
                       "C4: Primera vela 15min completamente sobre disipador SUPERIOR de BB",
                       "C5: Volumen 1H > línea roja Worden Stochastics (>80)  |  WIN: −1.5% en 4×15min"] },
            ].map(s => (
              <div key={s.label} className={`${s.bg} rounded-xl px-3 py-2`}>
                <div className={`font-bold text-xs mb-1 ${s.color}`}>{s.label}</div>
                {s.conds.map((c,i) => (
                  <div key={i} className="text-slate-400 text-xs leading-relaxed">{c}</div>
                ))}
              </div>
            ))}
          </div>

          {/* Equity curve */}
          <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700/60">
            <div className="text-slate-400 text-xs font-bold mb-2 uppercase tracking-wider">Curva de Equity Simulada</div>
            <EquityChart curve={results.curve}/>
          </div>

          {/* Trades list (collapsible) */}
          <div className="bg-slate-800 rounded-2xl border border-slate-700/60 overflow-hidden">
            <button onClick={() => setShowTrades(v => !v)}
              className="w-full px-4 py-3 flex justify-between items-center">
              <span className="text-slate-300 font-semibold text-sm">
                Lista de señales ({filteredTrades.length})
              </span>
              <span className="text-slate-600 text-xs">{showTrades ? "▲" : "▼"}</span>
            </button>

            {showTrades && (
              <>
                <div className="px-3 py-2 border-t border-b border-slate-700/40 flex gap-1.5 flex-wrap">
                  <select value={filterSym} onChange={e => setFilterSym(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todos los tickers</option>
                    {BT_SYMS.map(s => <option key={s}>{s}</option>)}
                  </select>
                  <select value={filterStrat} onChange={e => setFilterStrat(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todas las estrategias</option>
                    <option value="1">E1 — Cambio Tendencia ↑ CALL</option>
                    <option value="2">E2 — Cambio Tendencia ↓ PUT</option>
                    <option value="3">E3 — Rebote Punto Medio ↓ PUT</option>
                    <option value="4">E4 — Rebote Punto Medio ↑ CALL</option>
                    <option value="5">E5 — Lateral Apertura ↑ PUT</option>
                    <option value="6">E6 — Lateral Apertura ↓ CALL</option>
                    <option value="7">E7 — Efecto Imán ↓ CALL</option>
                    <option value="8">E8 — Efecto Imán ↑ PUT</option>
                  </select>
                  <select value={filterOutcome} onChange={e => setFilterOutcome(e.target.value)}
                    className="bg-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 border-0 focus:outline-none">
                    <option value="all">Todos</option>
                    <option value="WIN">WIN ✓</option>
                    <option value="LOSS">LOSS ✗</option>
                  </select>
                </div>

                <div className="max-h-80 overflow-y-auto divide-y divide-slate-700/20">
                  {filteredTrades.length === 0 ? (
                    <div className="text-center text-slate-600 text-xs py-8">Sin señales con estos filtros</div>
                  ) : filteredTrades.map(t => (
                    <div key={t.id} className="px-3 py-2.5 flex items-center gap-2">
                      <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded font-bold
                        ${t.outcome==="WIN"?"bg-green-900/60 text-green-400":"bg-red-900/60 text-red-400"}`}>
                        {t.outcome}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-baseline">
                          <span className={`font-bold text-xs ${t.dir==="CALL"?"text-green-400":"text-red-400"}`}>
                            {t.sym} {t.dir}
                          </span>
                          <span className="text-slate-600 text-xs">{t.date}</span>
                        </div>
                        <div className="text-slate-500 text-xs truncate">
                          {t.stratName} · entrada ${parseFloat(t.entry).toFixed(2)}
                        </div>
                      </div>
                      <span className={`shrink-0 font-mono font-bold text-xs ${(t.pnl??0)>=0?"text-green-400":"text-red-400"}`}>
                        {(t.pnl??0)>=0?"+":""}${Math.round(t.pnl??0)}
                      </span>
                    </div>
                  ))}
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
          ["Viernes","DTE 1 día (antes 12pm) / SEMANA SIGUIENTE (después 12pm)"],
        ]},
        { title:"Regla de Expiración", color:"text-amber-400", bullets:[
          "Siempre elegir la fecha MÁS CERCANA disponible",
          "Viernes >12pm ET → elegir expiración de SEMANA SIGUIENTE",
          "Misma fecha de expiración >12pm ET → elegir la siguiente fecha",
          "Más cercana = se valoriza más rápido, más barata, más dentro del rango",
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
