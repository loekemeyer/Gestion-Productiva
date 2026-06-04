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
const btnEnviar = document.getElementById("btnEnviar");
const btnVolverPS = document.getElementById("btnVolverPS");
const successCodeEl = document.getElementById("successCode");

const fase0 = document.getElementById("fase0");
const fase1 = document.getElementById("fase1");
const fase3 = document.getElementById("fase3");

const fase1TableBody = document.getElementById("fase1TableBody");
const fase1Title = document.getElementById("fase1Title");

let currentPhase = 0;
let selectedPS = "";
let fetchedItems = [];
let availablePS = [];
let isSubmitting = false;
let cargaPorUnidades = false; // true cuando PS seleccionado tiene flag carga_por_unidades=TRUE (ej. AJ Adhesivos)
let sinCajones = false; // true cuando PS seleccionado tiene flag sin_cajones=TRUE (ej. Charcas, AJ Adhesivos)
let cargaPorUniMap = new Map(); // ps -> boolean
let sinCajonesMap = new Map(); // ps -> boolean

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
         cargarTablaPaginada("Entregas Tallerista Virgilio").then(r => r.filter(x => {
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

async function precargarDatosStock() {
  if (stockDataCache) return stockDataCache;
  if (stockDataPromise) return stockDataPromise;

  stockDataPromise = (async () => {
    // Calc inline (legacy restaurado). Movimientos (envios/entregas PS+Tall+Log) usan
    // Cajones SUMA DIRECTA. Stock inicial y fabricacion derivan de Kg (no son movimientos).
    const [
      spKgRows, entregasPSRows, enviosTallRows, enviosAPSRows,
      entregasLogRows, despieceRows, causaEfectoRows, dbEspejoRows
    ] = await Promise.all([
      sb.from("SP Kg").select("*").then(r => r.data || []),
      cargarTablaPaginada("Entregas PS").then(r => r),
      cargarTablaPaginada("Envios a Talleristas").then(r => r),
      cargarTablaPaginada("Envios a PS").then(r => r),
      cargarTablaPaginada("Entregas_Tall_Todas").then(r => r.filter(x => {
        const cod = String(x["Codigo_Tall"] || "").trim();
        const nom = String(x["Nombre_Tall"] || "").trim().toLowerCase();
        return cod === "0001" || nom.includes("log");
      })),
      sb.from("Despiece x Articulo").select('"COD","Sector Proce"').then(r => r.data || []),
      sb.from("Causa-Efecto").select("*").then(r => r.data || []),
      cargarTablaPaginada("db_n8n_espejo", [{ col: "Legajo", val: "1" }])
    ]);

    // SP Kg index: spKgByKey y maps auxiliares
    const spKgByKey = new Map();
    const spSet = new Set();
    const kgXUniMap = new Map(); // SP uppercase -> KGxUni
    const kgXCajonMap = new Map(); // SP normalizado -> KGxCajon
    const mvBySP = new Map(); // mantiene API compatibility con renderizarFase1
    spKgRows.forEach(r => {
      const sp = String(r["Sp"] || "").trim();
      if (!sp) return;
      const key = normalizeText(sp);
      const kgCaj = parseDecimal(r["KG x Cajon"] || r["KG Cajon"] || 0);
      const kgU = parseDecimal(r["Kg X Uni"] || 0);
      const stockIni = parseDecimal(r["Stock Inicial"] || 0);
      const maxCaj = parseDecimal(r["Max Cajon SP Cerv"] || 0);
      spKgByKey.set(key, { kgCaj, kgU, stockIni, maxCaj });
      spSet.add(sp.toUpperCase());
      kgXCajonMap.set(key, kgCaj);
      if (kgU > 0) kgXUniMap.set(sp.toUpperCase(), kgU);
      // Online SP inicial (sin movimientos): stock inicial / kg cajon
      const stockIniCaj = kgCaj > 0 ? stockIni / kgCaj : 0;
      mvBySP.set(key, { maxCajCerv: maxCaj, onlineCaj: stockIniCaj });
    });

    // ENTREGAS PS por SP: sumar Cajones DIRECTO (suman al SP)
    entregasPSRows.forEach(r => {
      const k = normalizeText(r["Sector SP"]);
      const caj = Number(r["Cajones"] || 0);
      if (!k || !caj) return;
      const mv = mvBySP.get(k);
      if (mv) mv.onlineCaj += caj;
    });

    // ENVIOS PS por Sector SC (cuando SC es un SP que se manda como crudo a otro PS): resta del SP
    enviosAPSRows.forEach(r => {
      const k = normalizeText(r["Sector SC"]);
      const caj = Number(r["Cajones"] || 0);
      if (!k || !caj) return;
      const mv = mvBySP.get(k);
      if (mv) mv.onlineCaj -= caj;
    });

    // ENVIOS TALLERISTAS por Sector: resta del SP (solo si el sector es un SP valido)
    enviosTallRows.forEach(r => {
      const k = normalizeText(r["Sector"]);
      const caj = Number(r["Cajones"] || 0);
      if (!k || !caj) return;
      const mv = mvBySP.get(k);
      if (mv) mv.onlineCaj -= caj;
    });

    // ENTREGAS TALL VIRG -> Log (cod=0001): cruza por Despiece x Articulo (Cod -> Sector Proce)
    const codToSector = new Map();
    despieceRows.forEach(r => {
      const cod = normalizeCod3(r["COD"]);
      const sector = normalizeText(r["Sector Proce"]);
      if (cod && sector) codToSector.set(cod, sector);
    });
    entregasLogRows.forEach(r => {
      const codN = normalizeCod3(r["Cod"]);
      const cajas = Number(r["Cajas"] || 0);
      if (!codN || !cajas) return;
      const sector = codToSector.get(codN);
      if (!sector) return;
      const mv = mvBySP.get(sector);
      if (mv) mv.onlineCaj -= cajas;
    });

    // FABRICACION (derivada de db_n8n_espejo + Causa-Efecto): aumenta/descuenta SP en cajones
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
    for (const [, { matriz, uni }] of prodMap.entries()) {
      const efectos = causaMap.get(matriz) || [];
      for (const ef of efectos) {
        if (spSet.has(ef.aumenta)) {
          const k = normalizeText(ef.aumenta);
          const kgU = kgXUniMap.get(ef.aumenta) || 0;
          const kgCaj = kgXCajonMap.get(k) || 0;
          if (kgCaj > 0) {
            const fabCaj = (uni * kgU) / kgCaj;
            const mv = mvBySP.get(k);
            if (mv) mv.onlineCaj += fabCaj;
          }
        }
        if (spSet.has(ef.descuenta)) {
          const k = normalizeText(ef.descuenta);
          const kgU = kgXUniMap.get(ef.descuenta) || 0;
          const kgCaj = kgXCajonMap.get(k) || 0;
          if (kgCaj > 0) {
            const fabCaj = (uni * kgU) / kgCaj;
            const mv = mvBySP.get(k);
            if (mv) mv.onlineCaj -= fabCaj;
          }
        }
      }
    }

    // Online PS POR (PS, SP) y global por SP
    // global = suma todos los PSs (todos los provs que entregan esa parte)
    // Cajones para columna numerica + Kg para popup desglose
    const onlinePSCajGlobalBySP = new Map();
    const onlinePSCajByPSAndSP = new Map(); // key: `${ps}||${sp}` -> caj
    const onlinePSKgByPSAndSP = new Map();  // key: `${ps}||${sp}` -> kg
    const onlinePSUniByPSAndSP = new Map(); // key: `${ps}||${sp}` -> uni (solo para PSs cargaPorUnidades)

    const addRow = (ps, sp, caj, kg, uni, signo) => {
      if (!sp) return;
      if (caj) {
        onlinePSCajGlobalBySP.set(sp, (onlinePSCajGlobalBySP.get(sp) || 0) + caj * signo);
        if (ps) {
          const k = `${ps}||${sp}`;
          onlinePSCajByPSAndSP.set(k, (onlinePSCajByPSAndSP.get(k) || 0) + caj * signo);
        }
      }
      if (kg && ps) {
        const k = `${ps}||${sp}`;
        onlinePSKgByPSAndSP.set(k, (onlinePSKgByPSAndSP.get(k) || 0) + kg * signo);
      }
      if (uni && ps) {
        const k = `${ps}||${sp}`;
        onlinePSUniByPSAndSP.set(k, (onlinePSUniByPSAndSP.get(k) || 0) + uni * signo);
      }
    };
    enviosAPSRows.forEach(r => addRow(
      String(r["Prov_Serv"] || "").trim(),
      normalizeText(r["Sector SP"]),
      Number(r["Cajones"] || 0),
      Number(r["KG"] || 0),
      Number(r["Unidades"] || 0),
      +1
    ));
    entregasPSRows.forEach(r => addRow(
      String(r["Prov_Serv"] || "").trim(),
      normalizeText(r["Sector SP"]),
      Number(r["Cajones"] || 0),
      Number(r["KG"] || 0),
      0, // Entregas PS no tiene columna Unidades
      -1
    ));

    stockDataCache = { mvBySP, onlinePSCajGlobalBySP, onlinePSCajByPSAndSP, onlinePSKgByPSAndSP, onlinePSUniByPSAndSP };
    return stockDataCache;
  })();

  return stockDataPromise;
}

// Devuelve [{ps, kg, caj, uni}, ...] PSs con kg/cajones/uni online != 0 para la parte sp
function getBreakdownPorPS(sp) {
  if (!stockDataCache) return [];
  const key = normalizeText(sp);
  const psSet = new Set();
  for (const m of [stockDataCache.onlinePSKgByPSAndSP, stockDataCache.onlinePSCajByPSAndSP, stockDataCache.onlinePSUniByPSAndSP]) {
    for (const k of m.keys()) {
      const idx = k.indexOf("||");
      if (idx >= 0 && k.slice(idx + 2) === key) psSet.add(k.slice(0, idx));
    }
  }
  const out = [];
  for (const ps of psSet) {
    const kg = stockDataCache.onlinePSKgByPSAndSP.get(`${ps}||${key}`) || 0;
    const caj = stockDataCache.onlinePSCajByPSAndSP.get(`${ps}||${key}`) || 0;
    const uni = stockDataCache.onlinePSUniByPSAndSP.get(`${ps}||${key}`) || 0;
    if (!kg && !caj && !uni) continue;
    out.push({ ps, kg, caj, uni });
  }
  out.sort((a, b) => Math.abs(b.kg) + Math.abs(b.uni) - Math.abs(a.kg) - Math.abs(a.uni));
  return out;
}

function formatKg(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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

// Mapa global: PS -> proceso (especializacion) leído de Tall_ProvAT_PS
let procesoPorPSMap = new Map();
let psPorProcesoMap = new Map(); // proceso -> [ps,...]

async function getPSDisponibles() {
  const { data, error } = await sb.from(SUPABASE_TABLE).select(COL_PS);
  if (error) throw error;
  // Cargar flags + especializacion de Tall_ProvAT_PS en paralelo
  try {
    const { data: flagsData } = await sb.from("Tall_ProvAT_PS").select("nombre, carga_por_unidades, sin_cajones, especializacion");
    if (flagsData) {
      cargaPorUniMap = new Map(flagsData.map(r => [String(r.nombre || "").trim(), Boolean(r.carga_por_unidades)]));
      sinCajonesMap = new Map(flagsData.map(r => [String(r.nombre || "").trim(), Boolean(r.sin_cajones)]));
      procesoPorPSMap = new Map(flagsData.map(r => [String(r.nombre || "").trim(), (r.especializacion && String(r.especializacion).trim()) || "Sin asignar"]));
    }
  } catch (e) {
    console.warn("No se pudo cargar flags PS:", e);
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
  fase3.classList.toggle("hidden", n !== 3);
  btnVolver.classList.toggle("hidden", n === 0 || n === 3);
  // Al entrar a Fase 1, resetear fecha a hoy
  if (n === 1) {
    const fechaInput = document.getElementById("fechaEnvio");
    if (fechaInput && !fechaInput.value) fechaInput.value = new Date().toISOString().slice(0,10);
  }
}

function actualizarBtnEnviar() {
  const buf = getBuffer();
  const tieneItems = buf.some(b => b.ps === selectedPS && (
    Number(b.cajones) > 0 || Number(b.unidades) > 0 || parseDecimal(b.kg) > 0
  ));
  btnEnviar.disabled = !tieneItems;
  btnEnviar.classList.toggle("disabled", !tieneItems);
  btnEnviar.classList.remove("hidden");
  btnEnviar.textContent = "Enviar";
}
// Alias para no romper llamadas existentes
const actualizarBtnSiguiente = actualizarBtnEnviar;

// Render 2-pasos: primero procesos, click → PSs del proceso
let procesoSeleccionado = null;
function renderPSButtons(values) {
  psGrid.innerHTML = "";
  // Construir mapa proceso -> [ps]
  psPorProcesoMap = new Map();
  values.forEach(ps => {
    const proc = procesoPorPSMap.get(ps) || "Sin asignar";
    if (!psPorProcesoMap.has(proc)) psPorProcesoMap.set(proc, []);
    psPorProcesoMap.get(proc).push(ps);
  });
  procesoSeleccionado = null;
  renderProcesos();
}

function renderProcesos() {
  psGrid.innerHTML = "";
  const procs = [...psPorProcesoMap.keys()].sort((a,b) => {
    if (a === "Sin asignar") return 1;
    if (b === "Sin asignar") return -1;
    return a.localeCompare(b, "es");
  });
  procs.forEach(proc => {
    const cnt = psPorProcesoMap.get(proc).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill proceso-pill";
    btn.innerHTML = `${escapeHtml(proc)}<br><span style="font-size:11px;opacity:.75">${cnt} prov.</span>`;
    btn.addEventListener("click", () => {
      procesoSeleccionado = proc;
      renderPSDelProceso(proc);
    });
    psGrid.appendChild(btn);
  });
}

function renderPSDelProceso(proc) {
  psGrid.innerHTML = "";
  // Barra superior con back + label del proceso
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;margin-bottom:10px";
  bar.innerHTML = `<button type="button" class="ps-pill" style="background:#fff;color:#111;border:2px solid #d0d7de" id="psBackToProc">← Procesos</button>
    <div style="font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px">${escapeHtml(proc)}</div>`;
  psGrid.appendChild(bar);
  document.getElementById("psBackToProc").addEventListener("click", () => renderProcesos());
  const list = psPorProcesoMap.get(proc) || [];
  list.sort((a,b) => a.localeCompare(b, "es")).forEach(ps => {
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
  sinCajones = Boolean(sinCajonesMap.get(ps));
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

    // Tandas (si hay): inputs Caj/Kg read-only mostrando totales sumados
    const tandasArr = (bufItem && Array.isArray(bufItem.tandas)) ? bufItem.tandas : [];
    const hayTandas = tandasArr.length > 0;
    const totCajTandas = tandasArr.reduce((s, t) => s + (Number(t.caj) || 0), 0);
    const totKgTandas = tandasArr.reduce((s, t) => s + (parseDecimal(t.kg) || 0), 0);

    let cajCellHtml, kgCellHtml, tandaCellHtml = "";
    if (sinCajones) {
      // Charcas (kg) / AJ Adhesivos (uni): input directo en Fase 1
      const placeholder = cargaPorUnidades ? '0' : '0,0';
      const imode = cargaPorUnidades ? 'numeric' : 'decimal';
      const valStored = bufItem ? (cargaPorUnidades ? (bufItem.unidades || '') : (bufItem.kg || '')) : '';
      const labelTipo = cargaPorUnidades ? 'uni' : 'kg';
      cajCellHtml = `<input type="text" inputmode="${imode}" class="cell-input input-directo" data-tipo="${labelTipo}" placeholder="${placeholder}" value="${valStored}" autocomplete="off" style="width:80px">`;
      kgCellHtml = `<span class="zero">—</span>`;
    } else {
      // PSs con cajones: input cajones int + input kg neto decimal (unificado Fase 1)
      const bufKgVal = bufItem ? (bufItem.kg || '') : '';
      const cajVal = hayTandas ? totCajTandas : (bufCajVal || '');
      const kgVal = hayTandas ? (totKgTandas > 0 ? String(totKgTandas) : '') : bufKgVal;
      const cajCls = hayTandas ? 'cell-input input-cajones input-with-tandas' : 'cell-input input-cajones';
      const kgCls  = hayTandas ? 'cell-input input-kg input-with-tandas' : 'cell-input input-kg';
      const ro = hayTandas ? 'readonly' : '';
      cajCellHtml = `<input type="text" inputmode="numeric" class="${cajCls}" placeholder="0" value="${cajVal}" autocomplete="off" style="width:60px;text-align:center" ${ro}>`;
      kgCellHtml = `<input type="text" inputmode="decimal" class="${kgCls}" placeholder="0,0" value="${kgVal}" autocomplete="off" style="width:80px;text-align:center" ${ro}>`;
      tandaCellHtml = `<button type="button" class="tanda-trigger ${hayTandas ? 'has-tandas' : ''}" data-action="tandas" title="Cargar por tandas">${hayTandas ? tandasArr.length : '+'}</button>`;
    }

    return `
      <tr class="${rowClass}" data-idx="${i}" data-sug="${sug ?? ""}" data-sp="${escapeHtml(item.sp)}" data-parte="${escapeHtml(item.parte)}" data-cajones="${bufCajVal}" data-peso-cajones="${bufPesoCaj}">
        <td>${escapeHtml(item.parte)}</td>
        <td>${escapeHtml(item.proceso)}</td>
        <td class="right col-caj-only"><b>${maxTxt}</b></td>
        <td class="${onlineSPClass} col-caj-only"><b>${onlineSPTxt}</b></td>
        <td class="right col-caj-only">
          <div class="cell-combo">
            <span><b>${onlinePSTxt}</b></span>
            <button type="button" class="mini-popup-btn" data-action="popup-online">+</button>
          </div>
        </td>
        <td class="right sug-cell col-caj-only"><b>${sugTxt}</b></td>
        <td>${escapeHtml(item.sc)}</td>
        <td class="right">${cajCellHtml}</td>
        <td class="right col-caj-only">${kgCellHtml}</td>
        <td class="center col-caj-only">${tandaCellHtml}</td>
        <td class="center col-caj-only"><div class="${faltClass}">${faltTxt}</div></td>
      </tr>
    `;
  }).join("");

  // Toggle clase para ocultar columnas de cajones (Max/Online SP/Online PS/Cajones a Enviar/F)
  // cuando el PS no usa cajones (Charcas, AJ Adhesivos).
  const tbl = fase1TableBody.closest("table");
  if (tbl) tbl.classList.toggle("hide-caj-cols", sinCajones);
  // Rename header "Caj" segun tipo de carga
  const hdrCant = document.getElementById("fase1HdrCantidad");
  if (hdrCant) {
    hdrCant.textContent = sinCajones
      ? (cargaPorUnidades ? "Uni" : "Kg")
      : "Caj";
  }

  fase1TableBody.querySelectorAll("tr").forEach((row, idx) => {
    const box = row.querySelector(".faltante-box");
    const inputDirecto = row.querySelector(".input-directo");

    if (inputDirecto) {
      inputDirecto.addEventListener("input", () => {
        const tipo = inputDirecto.dataset.tipo;
        if (tipo === 'uni') inputDirecto.value = inputDirecto.value.replace(/\D/g,"");
        else inputDirecto.value = inputDirecto.value.replace(/[^0-9,.\-]/g,"");
        registrarCambioFila1Directo(idx);
      });
      inputDirecto.addEventListener("change", () => registrarCambioFila1Directo(idx));
    }

    const inputCaj = row.querySelector(".input-cajones");
    if (inputCaj) {
      inputCaj.addEventListener("input", () => {
        inputCaj.value = inputCaj.value.replace(/\D/g, "");
      });
      inputCaj.addEventListener("change", () => {
        const totalCaj = parseInt(inputCaj.value, 10) || 0;
        actualizarRowConCajones(idx, {}, totalCaj, 0);
        actualizarFaltanteAuto(row);
      });
    }

    // Input Kg neto (unificado Fase 1)
    const inputKg = row.querySelector(".input-kg");
    if (inputKg) {
      inputKg.addEventListener("input", () => {
        inputKg.value = inputKg.value.replace(/[^0-9,.\-]/g, "");
      });
      inputKg.addEventListener("change", () => {
        registrarKgFila(idx, inputKg.value);
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

    // Botón Tandas (T)
    const tandaBtn = row.querySelector('[data-action="tandas"]');
    if (tandaBtn) {
      tandaBtn.addEventListener("click", () => {
        abrirTandasFila(idx);
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
    body.innerHTML = `<div class="popup-line">Sin stock online en ningún PS</div>`;
  } else {
    // Por PS: si cargaPorUnidades → "X uni"; si sinCajones → "X kg"; else → "X kg — Y caj"
    const lineas = items.map(x => {
      const porUni = Boolean(cargaPorUniMap.get(x.ps));
      const sinCaj = Boolean(sinCajonesMap.get(x.ps));
      let valTxt;
      if (porUni) valTxt = `${Math.round(x.uni)} uni`;
      else if (sinCaj) valTxt = `${formatKg(x.kg)} kg`;
      else valTxt = `${formatKg(x.kg)} kg — ${Math.round(x.caj)} caj`;
      return `<div class="popup-line"><b>${escapeHtml(x.ps)}</b>: ${valTxt}</div>`;
    });
    // Totales separados según tipo
    const totalKg = items.reduce((s, x) => s + (cargaPorUniMap.get(x.ps) ? 0 : x.kg), 0);
    const totalUni = items.reduce((s, x) => s + (cargaPorUniMap.get(x.ps) ? x.uni : 0), 0);
    const totalCaj = items.reduce((s, x) => s + ((sinCajonesMap.get(x.ps) || cargaPorUniMap.get(x.ps)) ? 0 : x.caj), 0);
    const hayKg = items.some(x => !cargaPorUniMap.get(x.ps));
    const hayUni = items.some(x => cargaPorUniMap.get(x.ps));
    const hayCaj = items.some(x => !sinCajonesMap.get(x.ps) && !cargaPorUniMap.get(x.ps));
    const partes = [];
    if (hayKg) partes.push(`${formatKg(totalKg)} kg`);
    if (hayUni) partes.push(`${Math.round(totalUni)} uni`);
    if (hayCaj) partes.push(`${Math.round(totalCaj)} caj`);
    body.innerHTML = lineas.join("") + `<div class="popup-line popup-total"><b>Total: ${partes.join(" — ")}</b></div>`;
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

  // Persistir en buffer
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  const box = row.querySelector(".faltante-box");
  const faltante = !!box?.classList.contains("active");

  if (totalCaj > 0) {
    const prevKg = bufIdx >= 0 ? (buf[bufIdx].kg || "") : "";
    const prevTandas = bufIdx >= 0 && Array.isArray(buf[bufIdx].tandas) ? buf[bufIdx].tandas : [];
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
      kg: prevKg,
      tandas: prevTandas
    };
    if (bufIdx >= 0) buf[bufIdx] = newItem;
    else buf.push(newItem);
  } else {
    if (bufIdx >= 0) buf.splice(bufIdx, 1);
  }
  saveBuffer(buf);
}

// Para PSs sin_cajones (Charcas) — guardar valor directo (kg) directamente desde Fase 1.
// Saltea popup y Fase 2.
function registrarCambioFila1Directo(idx) {
  const item = fetchedItems[idx];
  if (!item) return;
  const rows = fase1TableBody.querySelectorAll("tr");
  const row = rows[idx];
  const input = row?.querySelector(".input-directo");
  if (!input) return;
  const raw = input.value.trim();
  const num = parseDecimal(raw);
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  if (num > 0) {
    const newItem = {
      ps: selectedPS,
      parte: item.parte,
      proceso: item.proceso,
      sc: item.sc,
      sp: item.sp,
      cajones: 0,
      cajonesSel: {},
      pesoCajones: 0,
      faltante: false,
      kg: cargaPorUnidades ? "" : String(num),
      unidades: cargaPorUnidades ? num : 0,
      modoDirecto: true
    };
    if (bufIdx >= 0) buf[bufIdx] = newItem;
    else buf.push(newItem);
  } else {
    if (bufIdx >= 0) buf.splice(bufIdx, 1);
  }
  saveBuffer(buf);
}

// Popup confirmación: muestra items a enviar + totales. Devuelve Promise<bool>
function mostrarConfirmacionEnvio(items) {
  return new Promise(resolve => {
    let overlay = document.getElementById("confirmEnvioOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "confirmEnvioOverlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2000;padding:16px";
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:14px;width:min(640px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden">
          <div style="background:#111;color:#fff;padding:14px 18px;font-weight:800;font-size:17px">Confirmar Envío</div>
          <div id="confirmEnvioBody" style="padding:14px 18px;overflow-y:auto;flex:1"></div>
          <div style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e5e7eb">
            <button id="confirmEnvioCancel" type="button" style="background:#fff;color:#111;border:2px solid #d0d7de;border-radius:10px;padding:10px 20px;font-weight:800;cursor:pointer;font-size:15px">Cancelar</button>
            <button id="confirmEnvioOk" type="button" style="background:#111;color:#fff;border:0;border-radius:10px;padding:10px 24px;font-weight:800;cursor:pointer;font-size:15px">✓ Confirmar Envío</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    const body = document.getElementById("confirmEnvioBody");
    let totCaj = 0, totKg = 0, totUni = 0;
    // Header dinamico segun tipo PS
    const labelCaj = sinCajones ? (cargaPorUnidades ? "Unidades" : "—") : "Cajones Enviados";
    const labelKg = sinCajones ? (cargaPorUnidades ? "—" : "Kg Neto") : "Kg Neto";
    const rows = items.map(it => {
      const caj = Number(it.cajones) || 0;
      const kg = parseDecimal(it.kg);
      const uni = Number(it.unidades) || 0;
      totCaj += caj; totKg += kg; totUni += uni;
      const cajCell = sinCajones
        ? (cargaPorUnidades ? `<b>${uni}</b>` : `—`)
        : `<b>${caj}</b>`;
      const kgCell = sinCajones
        ? (cargaPorUnidades ? `—` : `<b>${kg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`)
        : `<b>${kg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`;
      return `<tr>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.parte)}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.sp || it.sc || "")}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${cajCell}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${kgCell}</td>
      </tr>`;
    }).join("");
    const totCajTxt = sinCajones
      ? (cargaPorUnidades ? `<b>${totUni}</b>` : `—`)
      : `<b>${totCaj}</b>`;
    const totKgTxt = sinCajones
      ? (cargaPorUnidades ? `—` : `<b>${totKg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`)
      : `<b>${totKg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`;
    body.innerHTML = `
      <div style="font-weight:700;margin-bottom:10px;color:#555;font-size:15px;text-align:center">${items.length} artículo${items.length>1?'s':''} a <b style="color:#111">${escapeHtml(selectedPS)}</b></div>
      <div style="display:flex;justify-content:center">
        <table style="width:auto;border-collapse:collapse;font-size:16px;table-layout:auto">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Descripción</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Sector</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">${labelCaj}</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">${labelKg}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    overlay.style.display = "flex";
    const cleanup = () => { overlay.style.display = "none"; };
    document.getElementById("confirmEnvioOk").onclick = () => { cleanup(); resolve(true); };
    document.getElementById("confirmEnvioCancel").onclick = () => { cleanup(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
  });
}

// Abre popup de tandas para una fila
function abrirTandasFila(idx) {
  const item = fetchedItems[idx];
  if (!item) return;
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  let tandasIni = (bufIdx >= 0 && Array.isArray(buf[bufIdx].tandas)) ? buf[bufIdx].tandas : [];
  // Si no hay tandas pero hay valores cargados a mano → preload como tanda 1
  if (tandasIni.length === 0 && bufIdx >= 0) {
    const caj = Number(buf[bufIdx].cajones) || 0;
    const kg = parseDecimal(buf[bufIdx].kg);
    if (caj > 0 || kg > 0) {
      tandasIni = [{ caj, kg, uni: 0 }];
    }
  }
  window.tandasPopup.open({
    titulo: `Tandas — ${item.parte}`,
    initial: tandasIni,
    pedirCaj: true,
    pedirKg: true,
    pedirUni: false,
    onConfirm: (tandas, totales) => {
      // Persistir tandas en el buffer. Cajones y kg quedan como totales.
      const buf2 = getBuffer();
      const bufIdx2 = buf2.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
      if (tandas.length === 0 && totales.caj === 0 && totales.kg === 0) {
        // Sin tandas válidas: limpiar entrada si existe
        if (bufIdx2 >= 0) {
          buf2[bufIdx2].tandas = [];
          buf2[bufIdx2].cajones = 0;
          buf2[bufIdx2].kg = "";
          // Si quedó todo en 0, remover entrada
          if (!Number(buf2[bufIdx2].unidades || 0)) buf2.splice(bufIdx2, 1);
          saveBuffer(buf2);
        }
      } else {
        const newItem = bufIdx2 >= 0 ? buf2[bufIdx2] : {
          ps: selectedPS,
          parte: item.parte,
          proceso: item.proceso,
          sc: item.sc,
          sp: item.sp,
          faltante: false
        };
        newItem.tandas = tandas;
        newItem.cajones = totales.caj;
        newItem.kg = totales.kg > 0 ? String(totales.kg) : "";
        if (bufIdx2 >= 0) buf2[bufIdx2] = newItem;
        else buf2.push(newItem);
        saveBuffer(buf2);
      }
      // Re-render fase 1 para reflejar totales
      renderizarFase1();
    }
  });
}

// Persistir Kg en el buffer cuando el operario lo carga en Fase 1 unificada
function registrarKgFila(idx, rawValue) {
  const item = fetchedItems[idx];
  if (!item) return;
  const num = parseDecimal(rawValue);
  const buf = getBuffer();
  const bufKey = `${selectedPS}__${item.sc}__${item.parte}`;
  const bufIdx = buf.findIndex(b => `${b.ps}__${b.sc}__${b.parte}` === bufKey);
  if (bufIdx >= 0) {
    buf[bufIdx].kg = num > 0 ? String(num) : "";
    saveBuffer(buf);
  } else if (num > 0) {
    // No habia entrada (no se cargaron cajones aun), igual guardar kg
    buf.push({
      ps: selectedPS,
      parte: item.parte,
      proceso: item.proceso,
      sc: item.sc,
      sp: item.sp,
      cajones: 0,
      kg: String(num),
      faltante: false
    });
    saveBuffer(buf);
  }
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

function formatNumKg(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

btnEnviar.addEventListener("click", async () => {
  // Defensivo: persistir valores del DOM por si el operario clickea Enviar sin perder focus.
  // Skip inputs READONLY (tienen tandas — el valor mostrado es derivado y se perdería).
  fase1TableBody.querySelectorAll(".input-cajones, .input-kg, .input-directo").forEach(input => {
    if (input.readOnly) return;
    if (input.classList.contains("input-cajones")) {
      const row = input.closest("tr");
      const idx = Number(row?.dataset.idx);
      if (Number.isInteger(idx)) {
        const totalCaj = parseInt(input.value, 10) || 0;
        if (totalCaj > 0) actualizarRowConCajones(idx, {}, totalCaj, 0);
      }
    } else if (input.classList.contains("input-kg")) {
      const row = input.closest("tr");
      const idx = Number(row?.dataset.idx);
      if (Number.isInteger(idx)) registrarKgFila(idx, input.value);
    } else if (input.classList.contains("input-directo")) {
      const row = input.closest("tr");
      const idx = Number(row?.dataset.idx);
      if (Number.isInteger(idx)) registrarCambioFila1Directo(idx);
    }
  });

  const buf = getBuffer();
  const itemsConCaj = buf.filter(b => b.ps === selectedPS && (
    Number(b.cajones) > 0 || Number(b.unidades) > 0 || parseDecimal(b.kg) > 0
  ));

  if (!itemsConCaj.length) {
    alert("Cargá al menos un artículo");
    return;
  }

  // Para PSs con cajones (no sinCajones): validar que tengan kg cargado para cada fila con cajones
  if (!sinCajones) {
    const faltanKg = itemsConCaj.filter(b => Number(b.cajones) > 0 && !(parseDecimal(b.kg) > 0));
    if (faltanKg.length) {
      alert("Falta cargar Kg neto para: " + faltanKg.map(b => b.parte).join(", "));
      return;
    }
  }

  // Confirmación visual antes de insertar
  const confirmado = await mostrarConfirmacionEnvio(itemsConCaj);
  if (!confirmado) return;

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
        // PS con carga_por_unidades=TRUE (Charcas, AJ Adhesivos): guardar en Unidades, KG queda null
        // Para sinCajones (input directo Fase 1) el valor queda en item.unidades.
        // Para flujo normal con cargaPorUnidades el operario lo carga como "kg" en Fase 2.
        base["Unidades"] = parseInt(item.unidades || item.kg, 10) || 0;
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

// Botón Limpiar: vacía todo lo cargado (cajones, kg, tandas) del PS actual
const btnLimpiar = document.getElementById("btnLimpiar");
if (btnLimpiar) {
  btnLimpiar.addEventListener("click", () => {
    const buf = getBuffer();
    const tieneAlgo = buf.some(b => b.ps === selectedPS && (
      Number(b.cajones) > 0 || Number(b.unidades) > 0 || parseDecimal(b.kg) > 0 ||
      (Array.isArray(b.tandas) && b.tandas.length > 0)
    ));
    if (!tieneAlgo) {
      alert("No hay nada cargado para limpiar.");
      return;
    }
    if (!confirm("¿Vaciar todo lo cargado para " + selectedPS + "? (cajones, kg, tandas)")) return;
    // Eliminar entradas del PS actual
    const restante = buf.filter(b => b.ps !== selectedPS);
    localStorage.setItem(BUFFER_KEY, JSON.stringify(restante));
    actualizarBtnEnviar();
    renderizarFase1();
  });
}

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

    // Auto-seleccionar PS si viene ?ps=X en la URL (desde envios-only-ps.html)
    const params = new URLSearchParams(window.location.search);
    const psParam = params.get("ps");
    if (psParam && availablePS.includes(psParam)) {
      await seleccionarPS(psParam);
    }

    // Precarga en background datos para "Cajones sugeridos"
    precargarDatosStock().then(() => {
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
