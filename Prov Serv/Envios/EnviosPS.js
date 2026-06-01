"use strict";

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";
const TABLA_DESTINO = "Envios a PS";
const TABLA_SP_KG = "SP Kg";
const TABLA_ENTREGAS = "Entregas PS";
const SUPABASE_TABLE = "Partes x PS";
const COL_PS = "PS";
const COL_PROCESO = "Proceso";
const COL_PARTE = "Parte";
const COL_SC = "SC";
const COL_SP = "SP";
const BUFFER_KEY = "enviosPS_pendientes";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.__sbClient__ = sb; // expuesto para cajones-popup.js

const psGrid = document.getElementById("psGrid");
const statusEl = document.getElementById("status");
const btnVolver = document.getElementById("btnVolver");
const btnSiguiente = document.getElementById("btnSiguiente");
const btnEnviar = document.getElementById("btnEnviar");
const btnVolverFase1 = document.getElementById("btnVolverFase1");
const btnVolverPS = document.getElementById("btnVolverPS");
const successCodeEl = document.getElementById("successCode");

const fase0 = document.getElementById("fase0");
const fase1 = document.getElementById("fase1");
const fase2 = document.getElementById("fase2");
const fase3 = document.getElementById("fase3");

const fase1TableBody = document.getElementById("fase1TableBody");
const fase2TableBody = document.getElementById("fase2TableBody");
const fase1Title = document.getElementById("fase1Title");
const fase2Title = document.getElementById("fase2Title");
const fase2HdrCantidad = document.getElementById("fase2HdrCantidad");

let currentPhase = 0;
let selectedPS = "";
let fetchedItems = [];
let availablePS = [];
let isSubmitting = false;
let cargaPorUnidades = false; // true cuando PS seleccionado tiene flag carga_por_unidades=TRUE (ej. AJ Adhesivos)
let cargaPorUniMap = new Map(); // ps -> boolean, se llena al cargar la lista de PS

function getBuffer() {
  try {
    return JSON.parse(localStorage.getItem(BUFFER_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveBuffer(arr) {
  localStorage.setItem(BUFFER_KEY, JSON.stringify(arr));
  actualizarBtnSiguiente();
}

function clearBuffer() {
  localStorage.removeItem(BUFFER_KEY);
  actualizarBtnSiguiente();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pick(o, keys) {
  for (const k of keys) {
    if (o && k in o) return o[k];
  }
  return "";
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let s = String(value).trim();
  if (!s || s === "-" || s === "—") return 0;
  s = s.replace(/[^\d,.-]/g, "");
  if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseInputNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function getDiaMesHoy() {
  const hoy = new Date();
  const dia = String(hoy.getDate()).padStart(2, "0");
  const mes = String(hoy.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}`;
}

function normalizarTexto(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function uniqueSorted(arr) {
  return [...new Set(arr.map(v => String(v || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function genNumericCode(len = 4) {
  const min = Math.pow(10, len - 1);
  const max = Math.pow(10, len) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

let spKgCache = null;
async function getSpKgMap() {
  if (spKgCache) return spKgCache;
  const { data, error } = await sb.from(TABLA_SP_KG).select("*");
  if (error) throw error;
  const map = new Map();
  (data || []).forEach(r => {
    const key = String(r.Sp || r.SP || "").trim().toLowerCase();
    if (!key) return;
    map.set(key, {
      kgCaj: parseDecimal(pick(r, ["KG Cajon", "KG x Cajon", "kg cajon", "kg x cajon"]))
    });
  });
  spKgCache = map;
  return map;
}

/* =========================================================
   PRELOAD DATOS PARA "CAJONES A ENVIAR"
   - mv_stock_online_sp: max_caj_sp_cerv + online_caj (precalculado por MV)
   - Sum global por SP de Envios a PS.Cajones - Entregas PS.Cajones
     (sin filtro de Prov_Serv: incluye todos los PSs)

   --- VERSION ANTIGUA (preload pesado, sin MV, filtro por PS) ---
   Para volver al modo anterior:
     1) Comentar precargarDatosStock + calcCajonesSugeridos abajo.
     2) Descomentar el bloque LEGACY (entre "BEGIN LEGACY" y "END LEGACY").
     3) En renderizarFase1: cambiar calcCajonesSugeridos(item.sp)
        por calcCajonesSugeridos(item.sp, selectedPS).
     4) Razon de cambio (2026-05-27): MV mv_stock_online_sp + suma global
        de todos los PSs (no solo selectedPS). 9 tablas + db_n8n_espejo
        paginado (~5-8s) reemplazadas por 3 queries (~300ms).

   ============== BEGIN LEGACY ==============
   function normalizeCod3(value) {
     let s = String(value || "").trim().toUpperCase();
     if (!s) return "";
     const m = s.match(/^(\d+)(.*)$/);
     if (!m) return s;
     return `${m[1].padStart(3, "0")}${String(m[2] || "").trim().toUpperCase()}`;
   }
   async function cargarTablaPaginada(tabla, filtros) {
     const all = [];
     const PAGE = 1000;
     let from = 0;
     while (true) {
       let q = sb.from(tabla).select("*").range(from, from + PAGE - 1);
       if (filtros) filtros.forEach(f => { q = q.neq(f.col, f.val); });
       const { data, error } = await q;
       if (error) throw new Error(`${tabla}: ${error.message}`);
       if (!data || !data.length) break;
       all.push(...data);
       if (data.length < PAGE) break;
       from += PAGE;
     }
     return all;
   }
   async function precargarDatosStock_LEGACY() {
     if (stockDataCache) return stockDataCache;
     if (stockDataPromise) return stockDataPromise;
     stockDataPromise = (async () => {
       const [spKgRows, entregasPSRows, enviosTallRows, enviosAPSRows,
              entregasLogRows, despieceRows, eMadreLK, eMadreCH,
              causaEfectoRows, dbEspejoRows] = await Promise.all([
         sb.from("SP Kg").select("*").then(r => r.data || []),
         sb.from("Entregas PS").select('"Sector SP","KG"').limit(20000).then(r => r.data || []),
         sb.from("Envios a Talleristas").select('"Sector","KG"').limit(20000).then(r => r.data || []),
         sb.from("Envios a PS").select('"Prov_Serv","Sector SC","Sector SP","Cajones","KG"').limit(20000).then(r => r.data || []),
         sb.from("Entregas Tallerista Virgilio").select("*").then(r => (r.data || []).filter(x => {
           const cod = String(x["Codigo_Tall"] || "").trim();
           const nom = String(x["Nombre_Tall"] || "").trim().toLowerCase();
           return cod === "0001" || nom.includes("log");
         })),
         sb.from("Despiece x Articulo").select('"COD","Sector Proce"').then(r => r.data || []),
         sb.from("E. Madre LK").select("*").then(r => r.data || []),
         sb.from("E. Madre CH").select("*").then(r => r.data || []),
         sb.from("Causa-Efecto").select("*").then(r => r.data || []),
         cargarTablaPaginada("db_n8n_espejo", [{ col: "Legajo", val: "1" }])
       ]);
       const spKgByKey = new Map();
       const spSet = new Set();
       const kgXUniMap = new Map();
       spKgRows.forEach(r => {
         const sp = String(r["Sp"] || "").trim();
         if (!sp) return;
         const key = normalizeText(sp);
         spKgByKey.set(key, r);
         spSet.add(sp.toUpperCase());
         const kgU = parseDecimal(r["Kg X Uni"]);
         if (kgU > 0) kgXUniMap.set(sp.toUpperCase(), kgU);
       });
       const entregasPSKg = new Map();
       entregasPSRows.forEach(r => {
         const k = normalizeText(r["Sector SP"]);
         const kg = parseDecimal(r["KG"]);
         if (!k || !kg) return;
         entregasPSKg.set(k, (entregasPSKg.get(k) || 0) + kg);
       });
       const enviosTallKg = new Map();
       const spSetNorm = new Set(spKgRows.map(r => normalizeText(r["Sp"])).filter(Boolean));
       enviosTallRows.forEach(r => {
         const k = normalizeText(r["Sector"]);
         const kg = parseDecimal(r["KG"]);
         if (!k || !kg) return;
         if (!spSetNorm.has(k)) return;
         enviosTallKg.set(k, (enviosTallKg.get(k) || 0) + kg);
       });
       const enviosPSInputKg = new Map();
       const enviosPSCajByPsSp = new Map();
       enviosAPSRows.forEach(r => {
         const sectorSCNorm = normalizeText(r["Sector SC"]);
         const sectorSPNorm = normalizeText(r["Sector SP"]);
         const ps = String(r["Prov_Serv"] || "").trim();
         const kg = parseDecimal(r["KG"]);
         const caj = Number(r["Cajones"] || 0);
         if (sectorSCNorm && spSetNorm.has(sectorSCNorm) && kg) {
           enviosPSInputKg.set(sectorSCNorm, (enviosPSInputKg.get(sectorSCNorm) || 0) + kg);
         }
         if (ps && sectorSPNorm && caj) {
           const k = `${ps}||${sectorSPNorm}`;
           enviosPSCajByPsSp.set(k, (enviosPSCajByPsSp.get(k) || 0) + caj);
         }
       });
       const { data: entPSCajRows } = await sb.from("Entregas PS").select('"Prov_Serv","Sector SP","Cajones"').limit(20000);
       const entregasPSCajByPsSp = new Map();
       (entPSCajRows || []).forEach(r => {
         const ps = String(r["Prov_Serv"] || "").trim();
         const sp = normalizeText(r["Sector SP"]);
         const caj = Number(r["Cajones"] || 0);
         if (!ps || !sp || !caj) return;
         const k = `${ps}||${sp}`;
         entregasPSCajByPsSp.set(k, (entregasPSCajByPsSp.get(k) || 0) + caj);
       });
       const codToSector = new Map();
       despieceRows.forEach(r => {
         const cod = normalizeCod3(r["COD"]);
         const sector = normalizeText(r["Sector Proce"]);
         if (cod && sector) codToSector.set(cod, sector);
       });
       const entregasLogCaj = new Map();
       entregasLogRows.forEach(r => {
         const codN = normalizeCod3(r["Cod"]);
         const cajas = Number(r["Cajas"] || 0);
         if (!codN || !cajas) return;
         const sector = codToSector.get(codN);
         if (!sector) return;
         entregasLogCaj.set(sector, (entregasLogCaj.get(sector) || 0) + cajas);
       });
       const causaMap = new Map();
       causaEfectoRows.forEach(r => {
         const matriz = String(r["Matriz"] || "").trim();
         if (!matriz) return;
         const desc = String(r["Descuenta"] || "").trim().toUpperCase();
         const aum = String(r["Aumenta"] || "").trim().toUpperCase();
         if (!spSet.has(desc) && !spSet.has(aum)) return;
         if (!causaMap.has(matriz)) causaMap.set(matriz, []);
         causaMap.get(matriz).push({ descuenta: desc, aumenta: aum });
       });
       const prodMap = new Map();
       dbEspejoRows.forEach(r => {
         const matriz = String(r["Matriz"] || "").trim();
         const uni = parseDecimal(r["Uni"]);
         if (!matriz || !uni) return;
         if (!causaMap.has(matriz)) return;
         const key = `${matriz}|||${r["Mes"]}|||${r["Dia"]}|||${r["Legajo"]}`;
         if (!prodMap.has(key)) prodMap.set(key, { matriz, uni: 0 });
         prodMap.get(key).uni += uni;
       });
       const fabKgBySP = new Map();
       for (const [, { matriz, uni }] of prodMap.entries()) {
         const efectos = causaMap.get(matriz) || [];
         for (const ef of efectos) {
           if (spSet.has(ef.aumenta)) {
             const k = normalizeText(ef.aumenta);
             const kgU = kgXUniMap.get(ef.aumenta) || 0;
             fabKgBySP.set(k, (fabKgBySP.get(k) || 0) + uni * kgU);
           }
           if (spSet.has(ef.descuenta)) {
             const k = normalizeText(ef.descuenta);
             const kgU = kgXUniMap.get(ef.descuenta) || 0;
             fabKgBySP.set(k, (fabKgBySP.get(k) || 0) - uni * kgU);
           }
         }
       }
       stockDataCache = { spKgByKey, entregasPSKg, enviosTallKg, enviosPSInputKg,
                          entregasLogCaj, fabKgBySP, enviosPSCajByPsSp, entregasPSCajByPsSp };
       return stockDataCache;
     })();
     return stockDataPromise;
   }
   function calcCajonesSugeridos_LEGACY(sp, ps) {
     if (!stockDataCache) return null;
     const d = stockDataCache;
     const key = normalizeText(sp);
     const r = d.spKgByKey.get(key);
     if (!r) return 0;
     const maxCajSPCerv = parseDecimal(r["Max Cajon SP Cerv"]);
     const kgXCajon = parseDecimal(r["KG x Cajon"]);
     if (kgXCajon <= 0) return Math.max(0, Math.round(maxCajSPCerv));
     const stockInicial = parseDecimal(r["Stock Inicial"]);
     const entregasPS = d.entregasPSKg.get(key) || 0;
     const enviosTall = d.enviosTallKg.get(key) || 0;
     const enviosPSInput = d.enviosPSInputKg.get(key) || 0;
     const entregasLogKg = (d.entregasLogCaj.get(key) || 0) * kgXCajon;
     const fabNetaKg = d.fabKgBySP.get(key) || 0;
     const onlineKg = stockInicial + entregasPS + fabNetaKg - (enviosTall + enviosPSInput) - entregasLogKg;
     const onlineSPCaj = onlineKg / kgXCajon;
     const psSpKey = `${ps}||${key}`;
     const onlinePSCaj = (d.enviosPSCajByPsSp.get(psSpKey) || 0) - (d.entregasPSCajByPsSp.get(psSpKey) || 0);
     return Math.max(0, Math.round(maxCajSPCerv - onlineSPCaj - onlinePSCaj));
   }
   ============== END LEGACY ==============
========================================================= */
let stockDataCache = null; // { mvBySP, onlinePSCajGlobalBySP }
let stockDataPromise = null;

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

async function precargarDatosStock() {
  if (stockDataCache) return stockDataCache;
  if (stockDataPromise) return stockDataPromise;

  stockDataPromise = (async () => {
    const [mvRows, enviosPSRows, entregasPSRows] = await Promise.all([
      sb.from("mv_stock_online_sp").select("sp,max_caj_sp_cerv,online_caj").then(r => r.data || []),
      sb.from("Envios a PS").select('"Prov_Serv","Sector SP","Cajones"').limit(20000).then(r => r.data || []),
      sb.from("Entregas PS").select('"Prov_Serv","Sector SP","Cajones"').limit(20000).then(r => r.data || [])
    ]);

    const mvBySP = new Map();
    mvRows.forEach(r => {
      const k = normalizeText(r.sp);
      if (!k) return;
      mvBySP.set(k, {
        maxCajCerv: Number(r.max_caj_sp_cerv) || 0,
        onlineCaj: Number(r.online_caj) || 0
      });
    });

    // Online PS POR (PS, SP) y global por SP
    // global = suma todos los PSs (todos los provs que entregan esa parte)
    const onlinePSCajGlobalBySP = new Map();
    const onlinePSCajByPSAndSP = new Map(); // key: `${ps}||${sp}` -> caj

    const addCaj = (ps, sp, c) => {
      if (!sp || !c) return;
      onlinePSCajGlobalBySP.set(sp, (onlinePSCajGlobalBySP.get(sp) || 0) + c);
      if (ps) {
        const k = `${ps}||${sp}`;
        onlinePSCajByPSAndSP.set(k, (onlinePSCajByPSAndSP.get(k) || 0) + c);
      }
    };
    enviosPSRows.forEach(r => addCaj(
      String(r["Prov_Serv"] || "").trim(),
      normalizeText(r["Sector SP"]),
      Number(r["Cajones"] || 0)
    ));
    entregasPSRows.forEach(r => addCaj(
      String(r["Prov_Serv"] || "").trim(),
      normalizeText(r["Sector SP"]),
      -Number(r["Cajones"] || 0)
    ));

    stockDataCache = { mvBySP, onlinePSCajGlobalBySP, onlinePSCajByPSAndSP };
    return stockDataCache;
  })();

  return stockDataPromise;
}

// Devuelve [{ps, caj}, ...] solo PSs con online != 0 para la parte sp
function getBreakdownPorPS(sp) {
  if (!stockDataCache) return [];
  const key = normalizeText(sp);
  const out = [];
  for (const [k, caj] of stockDataCache.onlinePSCajByPSAndSP.entries()) {
    if (!caj) continue;
    const idx = k.indexOf("||");
    if (idx < 0) continue;
    if (k.slice(idx + 2) !== key) continue;
    out.push({ ps: k.slice(0, idx), caj });
  }
  out.sort((a, b) => b.caj - a.caj);
  return out;
}

function calcCajonesSugeridos(sp) {
  if (!stockDataCache) return null;
  const d = stockDataCache;
  const key = normalizeText(sp);
  const mv = d.mvBySP.get(key);
  if (!mv) return 0;
  const onlinePSGlobal = d.onlinePSCajGlobalBySP.get(key) || 0;
  // Clamp negativos a 0: si MV reporta online negativo (data quality issue),
  // tratamos como 0 para que la sugerencia no exceda Max.
  const onlineSPClamp = Math.max(0, mv.onlineCaj);
  const onlinePSClamp = Math.max(0, onlinePSGlobal);
  return Math.max(0, Math.round(mv.maxCajCerv - onlineSPClamp - onlinePSClamp));
}

async function getPSDisponibles() {
  const { data, error } = await sb.from(SUPABASE_TABLE).select(COL_PS);
  if (error) throw error;
  // Cargar flags carga_por_unidades de Tall_ProvAT_PS en paralelo
  try {
    const { data: flagsData } = await sb.from("Tall_ProvAT_PS").select("nombre, carga_por_unidades");
    if (flagsData) {
      cargaPorUniMap = new Map(flagsData.map(r => [String(r.nombre || "").trim(), Boolean(r.carga_por_unidades)]));
    }
  } catch (e) {
    console.warn("No se pudo cargar carga_por_unidades flags:", e);
  }
  return uniqueSorted((data || []).map(r => r[COL_PS]));
}

async function getItemsPorPS(ps) {
  const { data, error } = await sb
    .from(SUPABASE_TABLE)
    .select(`${COL_PS}, ${COL_PROCESO}, ${COL_PARTE}, ${COL_SC}, ${COL_SP}`)
    .eq(COL_PS, ps)
    .order(COL_PROCESO, { ascending: true })
    .order(COL_PARTE, { ascending: true });

  if (error) throw error;

  const uniques = [];
  const seen = new Set();

  (data || []).forEach(r => {
    const parte = String(r[COL_PARTE] || "").trim();
    const proceso = String(r[COL_PROCESO] || "").trim();
    const psVal = String(r[COL_PS] || "").trim();
    const sc = String(r[COL_SC] || "").trim();
    const sp = String(r[COL_SP] || "").trim();
    if (!parte) return;
    const key = [parte, proceso, sc, sp].join("||");
    if (seen.has(key)) return;
    seen.add(key);
    uniques.push({ ps: psVal, proceso, parte, sc, sp });
  });

  return uniques;
}

function mostrarFase(n) {
  currentPhase = n;
  fase0.classList.toggle("hidden", n !== 0);
  fase1.classList.toggle("hidden", n !== 1);
  fase2.classList.toggle("hidden", n !== 2);
  fase3.classList.toggle("hidden", n !== 3);
  btnVolver.classList.toggle("hidden", n === 0 || n === 3);
  // Al entrar a fase 2, resetear fecha a hoy + ajustar UI Kg vs Uni
  if (n === 2) {
    const fechaInput = document.getElementById("fechaEnvio");
    if (fechaInput) fechaInput.value = new Date().toISOString().slice(0,10);
    if (fase2Title) fase2Title.textContent = cargaPorUnidades ? "Cargar Unidades" : "Cargar Pesos (Kg)";
    if (fase2HdrCantidad) fase2HdrCantidad.textContent = cargaPorUnidades ? "Uni" : "Kg Bruto";
  }
}

function actualizarBtnSiguiente() {
  const buf = getBuffer();
  const tieneItems = buf.some(b => b.ps === selectedPS && Number(b.cajones) > 0);
  btnSiguiente.disabled = !tieneItems;
  btnSiguiente.classList.toggle("disabled", !tieneItems);
  btnSiguiente.classList.remove("hidden");
}

function renderPSButtons(values) {
  psGrid.innerHTML = "";
  values.forEach(ps => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill";
    btn.textContent = ps;
    btn.addEventListener("click", async () => {
      if (isSubmitting) return;
      await seleccionarPS(ps);
    });
    psGrid.appendChild(btn);
  });
}

async function seleccionarPS(ps) {
  selectedPS = ps;
  cargaPorUnidades = Boolean(cargaPorUniMap.get(ps));
  isSubmitting = true;
  statusEl.textContent = "Buscando partes...";

  try {
    const itemsBase = await getItemsPorPS(ps);
    fetchedItems = itemsBase;

    renderizarFase1();
    mostrarFase(1);
    statusEl.textContent = "";

    actualizarBtnSiguiente();
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Error al cargar partes";
    isSubmitting = false;
  }
}

function renderizarFase1() {
  const buf = getBuffer();
  fase1Title.textContent = selectedPS;

  fase1TableBody.innerHTML = fetchedItems.map((item, i) => {
    const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
    const bufItem = buf.find(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
    const bufCajVal = bufItem ? bufItem.cajones : 0;
    const bufFalt = bufItem ? !!bufItem.faltante : false;
    const bufSel = (bufItem && bufItem.cajonesSel) || {};
    const bufPesoCaj = (bufItem && Number(bufItem.pesoCajones)) || 0;

    const sug = stockDataCache ? calcCajonesSugeridos(item.sp) : null;
    const sugTxt = sug === null ? "…" : String(sug);
    const faltClass = bufFalt ? "faltante-box active" : "faltante-box";
    const faltTxt = bufFalt ? "F" : "";

    // Max SP de la parte + Online SP (del sector) + Online PS global
    const mv = stockDataCache ? stockDataCache.mvBySP.get(normalizeText(item.sp)) : null;
    const maxTxt = mv ? String(Math.round(mv.maxCajCerv)) : "…";
    const onlineSP = mv ? mv.onlineCaj : null;
    const onlineSPTxt = onlineSP === null ? "…" : String(Math.round(onlineSP));
    const onlineSPClass = (onlineSP !== null && onlineSP < 0) ? "right neg-online" : "right";
    const onlinePS = stockDataCache ? (stockDataCache.onlinePSCajGlobalBySP.get(normalizeText(item.sp)) || 0) : null;
    const onlinePSTxt = onlinePS === null ? "…" : String(Math.round(onlinePS));

    const rowClass = (mv && mv.maxCajCerv === 0) ? "row-max-zero" : "";

    const triggerCls = bufCajVal > 0 ? 'cajpop-trigger has-sel' : 'cajpop-trigger';
    const triggerLabel = bufCajVal > 0
      ? `${bufCajVal} caj<span class="sub">${bufPesoCaj.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span>`
      : '📦 Cargar';

    return `
      <tr class="${rowClass}" data-idx="${i}" data-sug="${sug ?? ""}" data-sp="${escapeHtml(item.sp)}" data-parte="${escapeHtml(item.parte)}" data-cajones="${bufCajVal}" data-peso-cajones="${bufPesoCaj}">
        <td>${escapeHtml(item.parte)}</td>
        <td>${escapeHtml(item.proceso)}</td>
        <td class="right"><b>${maxTxt}</b></td>
        <td class="${onlineSPClass}"><b>${onlineSPTxt}</b></td>
        <td class="right">
          <div class="cell-combo">
            <span><b>${onlinePSTxt}</b></span>
            <button type="button" class="mini-popup-btn" data-action="popup-online">+</button>
          </div>
        </td>
        <td class="right sug-cell"><b>${sugTxt}</b></td>
        <td>${escapeHtml(item.sc)}</td>
        <td class="right">
          <button type="button" class="${triggerCls}" data-action="popup-cajones">${triggerLabel}</button>
        </td>
        <td class="center"><div class="${faltClass}">${faltTxt}</div></td>
      </tr>
    `;
  }).join("");

  fase1TableBody.querySelectorAll("tr").forEach((row, idx) => {
    const box = row.querySelector(".faltante-box");
    const trigger = row.querySelector('[data-action="popup-cajones"]');

    if (trigger) {
      trigger.addEventListener("click", () => {
        const item = fetchedItems[idx];
        const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
        const buf = getBuffer();
        const bufItem = buf.find(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
        const initial = (bufItem && bufItem.cajonesSel) || {};
        cajonesPopup.open({
          titulo: `Cajones — ${item.parte}`,
          initial: initial,
          onConfirm: (sel, totalCaj, pesoTotal) => {
            actualizarRowConCajones(idx, sel, totalCaj, pesoTotal);
            actualizarFaltanteAuto(row);
          }
        });
      });
    }

    if (box) {
      box.addEventListener("click", () => {
        box.classList.toggle("active");
        box.textContent = box.classList.contains("active") ? "F" : "";
        registrarCambioFila1(idx);
      });
    }

    const popupBtn = row.querySelector('[data-action="popup-online"]');
    if (popupBtn) {
      popupBtn.addEventListener("click", () => {
        abrirPopupOnlinePS(row.dataset.sp, row.dataset.parte);
      });
    }
  });

  isSubmitting = false;
}

function abrirPopupOnlinePS(sp, parte) {
  const items = getBreakdownPorPS(sp);
  let overlay = document.getElementById("popupOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "popupOverlay";
    overlay.className = "popup-overlay hidden";
    overlay.innerHTML = `
      <div class="popup-box">
        <div class="popup-head">
          <div id="popupTitle" class="popup-title"></div>
          <button id="popupClose" type="button" class="popup-close">✕</button>
        </div>
        <div id="popupBody" class="popup-body"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
    overlay.querySelector("#popupClose").addEventListener("click", () => overlay.classList.add("hidden"));
  }
  overlay.querySelector("#popupTitle").textContent = `Online PS — ${parte} (${sp})`;
  const body = overlay.querySelector("#popupBody");
  if (!items.length) {
    body.innerHTML = `<div class="popup-line">Sin cajones online en ningún PS</div>`;
  } else {
    const total = items.reduce((s, x) => s + x.caj, 0);
    body.innerHTML = items.map(x =>
      `<div class="popup-line"><b>${escapeHtml(x.ps)}</b>: ${Math.round(x.caj)} caj</div>`
    ).join("") + `<div class="popup-line popup-total"><b>Total: ${Math.round(total)} caj</b></div>`;
  }
  overlay.classList.remove("hidden");
}

function actualizarFaltanteAuto(row) {
  const sug = Number(row.dataset.sug || 0);
  const box = row.querySelector(".faltante-box");
  if (!box || !sug) return;
  const cargado = Number(row.dataset.cajones || 0);
  if (!cargado) {
    box.classList.remove("active");
    box.textContent = "";
    return;
  }
  if (cargado < sug) {
    box.classList.add("active");
    box.textContent = "F";
  } else {
    box.classList.remove("active");
    box.textContent = "";
  }
}

function actualizarRowConCajones(idx, sel, totalCaj, pesoTotal) {
  const item = fetchedItems[idx];
  if (!item) return;
  const rows = fase1TableBody.querySelectorAll("tr");
  const row = rows[idx];
  if (!row) return;
  row.dataset.cajones = totalCaj;
  row.dataset.pesoCajones = pesoTotal;

  const trigger = row.querySelector('[data-action="popup-cajones"]');
  if (trigger) {
    if (totalCaj > 0) {
      trigger.classList.add("has-sel");
      trigger.innerHTML = `${totalCaj} caj<span class="sub">${pesoTotal.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span>`;
    } else {
      trigger.classList.remove("has-sel");
      trigger.innerHTML = '📦 Cargar';
    }
  }

  // Persistir en buffer
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  const box = row.querySelector(".faltante-box");
  const faltante = !!box?.classList.contains("active");

  if (totalCaj > 0) {
    const prevKg = bufIdx >= 0 ? (buf[bufIdx].kg || "") : "";
    const newItem = {
      ps: selectedPS,
      parte: item.parte,
      proceso: item.proceso,
      sc: item.sc,
      sp: item.sp,
      cajones: totalCaj,
      cajonesSel: sel,
      pesoCajones: pesoTotal,
      faltante: faltante,
      kg: prevKg
    };
    if (bufIdx >= 0) buf[bufIdx] = newItem;
    else buf.push(newItem);
  } else {
    if (bufIdx >= 0) buf.splice(bufIdx, 1);
  }
  saveBuffer(buf);
}

// Solo se usa para refrescar el flag faltante en el buffer cuando el operador toca el F box.
// Las cajones se persisten via actualizarRowConCajones (popup confirm).
function registrarCambioFila1(idx) {
  const item = fetchedItems[idx];
  if (!item) return;
  const rows = fase1TableBody.querySelectorAll("tr");
  const row = rows[idx];
  const box = row?.querySelector(".faltante-box");
  const faltante = !!box?.classList.contains("active");
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  if (bufIdx >= 0) {
    buf[bufIdx].faltante = faltante;
    saveBuffer(buf);
  }
}

function renderizarFase2() {
  const buf = getBuffer();
  // Mapeo con indice ORIGINAL del buffer, luego filtra por PS (para que data-buf-idx apunte a la posicion real en localStorage)
  const itemsConCaj = buf
    .map((b, originalIdx) => ({ ...b, _idx: originalIdx }))
    .filter(b => b.ps === selectedPS && Number(b.cajones) > 0);

  const ph = cargaPorUnidades ? "0" : "0,0";
  const im = cargaPorUnidades ? "numeric" : "decimal";

  fase2TableBody.innerHTML = itemsConCaj.map(item => {
    const i = item._idx;
    const pesoCaj = Number(item.pesoCajones) || 0;
    const kgBruto = Number(item.kgBruto) || (item.kg ? parseDecimal(item.kg) + pesoCaj : 0);
    const kgNeto = Math.max(0, kgBruto - pesoCaj);
    return `
      <tr data-buf-idx="${i}">
        <td>${escapeHtml(item.parte)}</td>
        <td>${escapeHtml(item.proceso)}</td>
        <td>${escapeHtml(item.sc)}</td>
        <td class="right"><b>${item.cajones}</b><br><span class="kg-caj">${pesoCaj.toLocaleString('es-AR',{maximumFractionDigits:2})} kg caj</span></td>
        <td class="right"><input type="text" inputmode="${im}" class="cell-input input-kg-fase2" data-buf-idx="${i}" placeholder="${ph}" value="${kgBruto ? formatNumKg(kgBruto) : ''}" autocomplete="off"></td>
        <td class="right kg-neto-cell" data-buf-idx="${i}"><b>${kgNeto ? formatNumKg(kgNeto) : '—'}</b></td>
      </tr>
    `;
  }).join("");

  fase2TableBody.querySelectorAll(".input-kg-fase2").forEach(input => {
    input.addEventListener("input", () => {
      input.value = cargaPorUnidades
        ? input.value.replace(/\D/g, "")
        : input.value.replace(/[^0-9,.\-]/g, "");
      recalcularKgNeto(input);
      validarFase2Completa();
    });
    input.addEventListener("change", () => {
      const idx = Number(input.dataset.bufIdx);
      const buf = getBuffer();
      if (buf[idx]) {
        const bruto = parseDecimal(input.value);
        const pesoCaj = Number(buf[idx].pesoCajones) || 0;
        buf[idx].kgBruto = bruto;
        buf[idx].kg = String(Math.max(0, bruto - pesoCaj));
      }
      localStorage.setItem(BUFFER_KEY, JSON.stringify(buf));
      validarFase2Completa();
    });
  });

  validarFase2Completa();
}

function formatNumKg(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function recalcularKgNeto(input) {
  const idx = Number(input.dataset.bufIdx);
  const buf = getBuffer();
  if (!buf[idx]) return;
  const bruto = parseDecimal(input.value);
  const pesoCaj = Number(buf[idx].pesoCajones) || 0;
  const neto = Math.max(0, bruto - pesoCaj);
  const cell = fase2TableBody.querySelector(`.kg-neto-cell[data-buf-idx="${idx}"] b`);
  if (cell) cell.textContent = neto ? formatNumKg(neto) : '—';
}

function validarFase2Completa() {
  const inputs = fase2TableBody.querySelectorAll(".input-kg-fase2");
  const todosLlenos = Array.from(inputs).every(input => {
    const val = input.value.trim();
    return val && parseDecimal(val) > 0;
  });
  btnEnviar.disabled = !todosLlenos;
  btnEnviar.classList.toggle("disabled", !todosLlenos);
}

btnSiguiente.addEventListener("click", () => {
  const buf = getBuffer();
  const itemsPS = buf.filter(b => b.ps === selectedPS && Number(b.cajones) > 0);
  if (!itemsPS.length) {
    alert("Selecciona al menos un artículo con cajones para enviar");
    return;
  }
  renderizarFase2();
  mostrarFase(2);
});

btnVolverFase1.addEventListener("click", () => {
  mostrarFase(1);
});

btnEnviar.addEventListener("click", async () => {
  // Defensivo: persistir cualquier valor del DOM que no se haya commiteado por change (ej. usuario clickea Enviar sin perder focus del input)
  const inputsActuales = fase2TableBody.querySelectorAll(".input-kg-fase2");
  if (inputsActuales.length) {
    const bufAct = getBuffer();
    inputsActuales.forEach(input => {
      const idx = Number(input.dataset.bufIdx);
      if (Number.isInteger(idx) && bufAct[idx]) {
        const bruto = parseDecimal(input.value);
        const pesoCaj = Number(bufAct[idx].pesoCajones) || 0;
        bufAct[idx].kgBruto = bruto;
        // Si carga por unidades: el valor es unidades, no kg. No restamos pesoCaj.
        if (cargaPorUnidades) {
          bufAct[idx].kg = String(input.value || "").trim();
        } else {
          bufAct[idx].kg = String(Math.max(0, bruto - pesoCaj));
        }
      }
    });
    localStorage.setItem(BUFFER_KEY, JSON.stringify(bufAct));
  }

  const buf = getBuffer();
  const itemsConCaj = buf.filter(b => b.ps === selectedPS && Number(b.cajones) > 0);

  const faltanKg = itemsConCaj.filter(b => !(parseDecimal(b.kg) > 0));
  if (faltanKg.length) {
    const etiqueta = cargaPorUnidades ? "Unidades" : "Kg";
    alert("Por favor ingresa " + etiqueta + " para todos los artículos");
    return;
  }

  btnEnviar.disabled = true;
  const textOriginal = btnEnviar.textContent;
  btnEnviar.textContent = "Enviando...";

  try {
    // Tomar fecha seleccionada (default hoy). Convertir YYYY-MM-DD → DD/MM
    const fechaInput = document.getElementById("fechaEnvio");
    let diaMes = getDiaMesHoy();
    if (fechaInput && fechaInput.value) {
      const [y, m, d] = fechaInput.value.split("-");
      diaMes = `${d}/${m}`;
    }
    const payload = itemsConCaj.map(item => {
      const base = {
        "Dia-mes": diaMes,
        "Prov_Serv": selectedPS,
        "Sector SC": item.sc || "",
        "Parte": item.parte || "",
        "Faltante": !!item.faltante,
        "Cajones": Number(item.cajones),
        "Sector SP": item.sp || "",
        "Proceso": item.proceso || ""
      };
      if (cargaPorUnidades) {
        // PS con carga_por_unidades=TRUE (ej. AJ Adhesivos): guardar en Unidades, KG queda null
        base["Unidades"] = parseInt(item.kg, 10) || 0;
      } else {
        base["KG"] = parseDecimal(item.kg);
      }
      return base;
    });

    const { error } = await sb.from(TABLA_DESTINO).insert(payload);
    if (error) throw error;

    const codigo = genNumericCode(4);
    successCodeEl.textContent = codigo;

    clearBuffer();
    mostrarFase(3);
  } catch (err) {
    console.error(err);
    alert("Error: " + (err.message || "no se pudo enviar"));
  } finally {
    btnEnviar.disabled = false;
    btnEnviar.textContent = textOriginal;
  }
});

btnVolver.addEventListener("click", () => {
  selectedPS = "";
  fetchedItems = [];
  clearBuffer();
  psGrid.querySelectorAll(".ps-pill").forEach(btn => {
    btn.classList.remove("active");
  });
  mostrarFase(0);
  statusEl.textContent = "Selecciona un proveedor para continuar.";
});

btnVolverPS.addEventListener("click", () => {
  selectedPS = "";
  fetchedItems = [];
  clearBuffer();
  psGrid.querySelectorAll(".ps-pill").forEach(btn => {
    btn.classList.remove("active");
  });
  mostrarFase(0);
  statusEl.textContent = "Selecciona un proveedor para continuar.";
});

async function init() {
  try {
    statusEl.textContent = "Cargando proveedores...";
    availablePS = await getPSDisponibles();
    renderPSButtons(availablePS);
    mostrarFase(0);
    statusEl.textContent = "Selecciona un proveedor para continuar.";

    // Precarga en background datos para "Cajones sugeridos"
    precargarDatosStock().then(() => {
      // Si el usuario ya entro a fase 1, re-render para mostrar los sugeridos
      if (currentPhase === 1 && selectedPS && fetchedItems.length) {
        renderizarFase1();
      }
    }).catch(e => console.warn("Preload stock data fallo:", e));
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Error al cargar proveedores";
  }
}

init();
