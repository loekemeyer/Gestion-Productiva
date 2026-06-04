"use strict";

/****************************************************************
 * Stock Online — vista por Prov. Servicios y Talleristas
 * Para cada parte, muestra Cajones + Kg que tiene actualmente
 * el PS/Tall = Σ envios - Σ entregas hasta fecha cutoff.
 * Filtros: descripción, sector, nombre (PS/Tall), fecha hasta.
 ****************************************************************/

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let selOrigen = "ps"; // 'ps' | 'tall'
let fechaHasta = "";  // YYYY-MM-DD
let cache = { ps: null, tall: null }; // datos crudos cacheados

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const inHasta = document.getElementById("inHasta");
const filtroDescEl = document.getElementById("filtroDesc");
const filtroSectorEl = document.getElementById("filtroSector");
const selNombreEl = document.getElementById("selNombre");
const labelNombreEl = document.getElementById("labelNombre");
const filtroCountEl = document.getElementById("filtroCount");

// ===== Helpers =====
function setStatus(t){ statusEl.textContent = t || ""; }
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function pick(o, keys){
  for (const k of keys) if (o && k in o) return o[k];
  return "";
}
function parseDecimal(v){
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[^\d,.-]/g,"");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function normalizeText(v){
  return String(v || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
}
function fmtKg(n){
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtInt(n){
  return Math.round(Number(n || 0)).toLocaleString('es-AR');
}
// Parsea "DD/MM" o "DD-MM" o "YYYY-MM-DD" o "DD/MM/YYYY" → YYYY-MM-DD (asume año actual si falta)
function parseFechaToISO(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY o DD-MM-YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  // DD/MM (asume año actual)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m){
    const y = new Date().getFullYear();
    return `${y}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  }
  return null;
}

async function cargarTabla(tabla, sel = "*"){
  const out = [];
  const PAGE = 1000;
  let from = 0;
  while (true){
    const { data, error } = await sb.from(tabla).select(sel).range(from, from + PAGE - 1);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ===== Carga datos crudos según origen =====
async function cargarDatosPS(){
  if (cache.ps) return cache.ps;
  setStatus("Cargando datos PS...");
  const [envios, entregas, partesPS] = await Promise.all([
    cargarTabla("Envios a PS", '"Dia-mes","Prov_Serv","Sector SC","Parte","Cajones","KG","Unidades","Sector SP","Proceso"'),
    cargarTabla("Entregas PS", '"Dia-mes","Prov_Serv","Sector SC","Parte","Cajones","KG","Sector SP","Proceso"'),
    cargarTabla("Partes x PS", '"PS","Parte","SP","KG x Cajon","KG x Uni","Stock Inicial","Stock Inicial Caj","Stock Inicial Kg"')
  ]);
  // Mapa por (ps__sp__parte) → { stockIni, kgCaj, kgUni, uniCaj }
  const factores = new Map();
  partesPS.forEach(r => {
    const ps = normalizeText(r["PS"]);
    const sp = normalizeText(r["SP"]);
    const parte = normalizeText(r["Parte"]);
    if (!ps || !parte) return;
    const kgCaj = parseDecimal(r["KG x Cajon"]);
    const kgUni = parseDecimal(r["KG x Uni"]);
    const stockIniUni = parseDecimal(r["Stock Inicial"]);
    const stockIniCaj = parseDecimal(r["Stock Inicial Caj"]);
    const stockIniKg = parseDecimal(r["Stock Inicial Kg"]);
    const uniCaj = (kgCaj > 0 && kgUni > 0) ? (kgCaj / kgUni) : 0;
    factores.set(`${ps}__${sp}__${parte}`, { stockIniUni, stockIniCaj, stockIniKg, kgCaj, kgUni, uniCaj });
  });
  cache.ps = { envios, entregas, factores };
  setStatus("");
  return cache.ps;
}

async function cargarDatosTall(){
  if (cache.tall) return cache.tall;
  setStatus("Cargando datos Tall...");
  const [envios, entregasVirg, entregasCerv, partesTall] = await Promise.all([
    cargarTabla("Envios a Talleristas", '"Dia-mes","Tallerista","Sector","Descripcion","Cajones","KG","Unidades"'),
    cargarTabla("Entregas Tallerista Virgilio", '"Fecha","Nombre_Tall","Cod","Cajas","Kg_GRJ","Cod_GRJ"'),
    cargarTabla("Entregas Tallerista Cervantes", '"Fecha","Nombre_Tall","Cod","Cajas","Kg_GRJ","Cod_GRJ"'),
    cargarTabla("Partes x Tallerista", '"tallerista","cod_art","descripcion_parte","sector_proce","uni_x_cja","partes_x_cja","kgxuni","kg_x_caj","stock_inicial","stock_inicial_caj","stock_inicial_kg"')
  ]);
  // Mantener nombre legacy para compatibilidad downstream
  const entregasTall = entregasVirg;
  // Mapa cod → {desc, sector} por tallerista (para mapear entregas Cod → desc/sector)
  const codInfo = new Map();
  const codInfoGen = new Map();
  // Mapa factores: por (tallNorm__sector__desc) → { stockIni, partesCaj, kgxuni, kgCaj }
  const factores = new Map();
  partesTall.forEach(r => {
    const t = normalizeText(pick(r, ["tallerista", "Tallerista"]));
    const cod = String(pick(r, ["cod_art", "Cod_Art"]) || "").trim();
    const desc = String(pick(r, ["descripcion_parte"]) || "").trim();
    const sector = String(pick(r, ["sector_proce"]) || "").trim();
    const info = { desc, sector };
    if (t && cod) codInfo.set(`${t}__${cod}`, info);
    if (cod && !codInfoGen.has(cod)) codInfoGen.set(cod, info);
    // Factores por (tall, sector, desc)
    if (!t || !desc) return;
    const descNorm = normalizeText(desc);
    const sectorNorm = normalizeText(sector);
    const partesCaj = parseDecimal(pick(r, ["partes_x_cja"])) || parseDecimal(pick(r, ["uni_x_cja"]));
    const kgxuni = parseDecimal(pick(r, ["kgxuni"]));
    const kgCaj = parseDecimal(pick(r, ["kg_x_caj"]));
    const stockIniUni = parseDecimal(pick(r, ["stock_inicial"]));
    const stockIniCaj = parseDecimal(pick(r, ["stock_inicial_caj"]));
    const stockIniKg = parseDecimal(pick(r, ["stock_inicial_kg"]));
    const key = `${t}__${sectorNorm}__${descNorm}`;
    if (!factores.has(key)){
      factores.set(key, { stockIniUni, stockIniCaj, stockIniKg, partesCaj, kgxuni, kgCaj });
    }
  });
  cache.tall = { envios, entregasTall, entregasVirg, entregasCerv, codInfo, codInfoGen, factores };
  setStatus("");
  return cache.tall;
}

// ===== Calcula stock online por nombre+parte =====
// Devuelve: Map<nombre, Map<parteKey, {desc, sector, cajones, kg, uni}>>
function calcularStockPS(datos, fechaHastaISO){
  const result = new Map();
  // Inicializar con stock inicial desde Partes x PS
  // (factores key: ${psNorm}__${spNorm}__${parteNorm})
  // Iteramos al revés: para cada PS+SP+parte que tenga stockIni > 0, creamos entrada vacía + stockIni
  // Necesitamos los nombres "originales" del PS y la parte. Los buscamos en envios y entregas (cualquiera que aparezca primero).
  const nombresPS = new Map(); // psNorm → nombre original
  const partesDesc = new Map(); // `${spNorm}__${parteNorm}` → {parte, sector}
  [...datos.envios, ...datos.entregas].forEach(r => {
    const ps = String(r["Prov_Serv"] || "").trim();
    const sp = String(r["Sector SP"] || "").trim();
    const parte = String(r["Parte"] || "").trim();
    if (ps) nombresPS.set(normalizeText(ps), ps);
    if (parte) partesDesc.set(`${normalizeText(sp)}__${normalizeText(parte)}`, { parte, sector: sp });
  });

  const add = (nombre, parte, sector, signo, caj, kgRaw, uniRaw) => {
    if (!nombre) nombre = "(sin nombre)";
    if (!result.has(nombre)) result.set(nombre, new Map());
    const partes = result.get(nombre);
    const key = `${sector}__${parte}`;
    const fkey = `${normalizeText(nombre)}__${normalizeText(sector)}__${normalizeText(parte)}`;
    const f = datos.factores.get(fkey) || { stockIniUni: 0, stockIniCaj: 0, stockIniKg: 0, kgCaj: 0, kgUni: 0, uniCaj: 0 };
    if (!partes.has(key)){
      partes.set(key, {
        desc: parte || "(sin desc)",
        sector: sector || "",
        stockIniUni: f.stockIniUni,
        stockIniCaj: f.stockIniCaj,
        stockIniKg: f.stockIniKg,
        cajones: 0,
        kg: 0,
        uni: 0
      });
    }
    const ent = partes.get(key);
    // Prioridad: lo cargado por el operario. Si es 0, fallback al calculo desde factor.
    let kg = kgRaw > 0 ? kgRaw : (f.kgCaj > 0 ? caj * f.kgCaj : 0);
    let uni = uniRaw > 0 ? uniRaw : (f.uniCaj > 0 ? caj * f.uniCaj : 0);
    ent.cajones += signo * caj;
    ent.kg += signo * kg;
    ent.uni += signo * uni;
  };
  const filtraFecha = (fechaRaw) => {
    if (!fechaHastaISO) return true;
    const iso = parseFechaToISO(fechaRaw);
    if (!iso) return false;
    return iso <= fechaHastaISO;
  };
  // Seed: agregar entradas con stockIni (cualquiera de las 3 unidades) > 0 sin movimientos
  datos.factores.forEach((f, fkey) => {
    if (!f.stockIniUni && !f.stockIniCaj && !f.stockIniKg) return;
    const [psNorm, spNorm, parteNorm] = fkey.split("__");
    const nombre = nombresPS.get(psNorm);
    const partInfo = partesDesc.get(`${spNorm}__${parteNorm}`);
    if (!nombre || !partInfo) return;
    add(nombre, partInfo.parte, partInfo.sector, 0, 0, 0, 0);
  });
  datos.envios.forEach(r => {
    if (!filtraFecha(r["Dia-mes"])) return;
    add(
      String(r["Prov_Serv"] || "").trim(),
      String(r["Parte"] || "").trim(),
      String(r["Sector SP"] || "").trim(),
      +1,
      Number(r["Cajones"] || 0),
      parseDecimal(r["KG"]),
      Number(r["Unidades"] || 0)
    );
  });
  datos.entregas.forEach(r => {
    if (!filtraFecha(r["Dia-mes"])) return;
    add(
      String(r["Prov_Serv"] || "").trim(),
      String(r["Parte"] || "").trim(),
      String(r["Sector SP"] || "").trim(),
      -1,
      Number(r["Cajones"] || 0),
      parseDecimal(r["KG"]),
      0
    );
  });
  return result;
}

function calcularStockTall(datos, fechaHastaISO){
  const result = new Map();
  const nombresTall = new Map();
  const partesDescTall = new Map();
  [...datos.envios].forEach(r => {
    const t = String(r["Tallerista"] || "").trim();
    const sector = String(r["Sector"] || "").trim();
    const desc = String(r["Descripcion"] || "").trim();
    if (t) nombresTall.set(normalizeText(t), t);
    if (desc) partesDescTall.set(`${normalizeText(sector)}__${normalizeText(desc)}`, { parte: desc, sector });
  });
  // Tambien sacar desc/sector desde el mapa codInfoGen (entregas)
  datos.codInfoGen.forEach(info => {
    if (info.desc) partesDescTall.set(`${normalizeText(info.sector)}__${normalizeText(info.desc)}`, { parte: info.desc, sector: info.sector });
  });

  const add = (nombre, parte, sector, signo, caj, kgRaw, uniRaw) => {
    if (!nombre) nombre = "(sin nombre)";
    if (!result.has(nombre)) result.set(nombre, new Map());
    const partes = result.get(nombre);
    const key = `${sector}__${parte}`;
    const fkey = `${normalizeText(nombre)}__${normalizeText(sector)}__${normalizeText(parte)}`;
    const f = datos.factores.get(fkey) || { stockIniUni: 0, stockIniCaj: 0, stockIniKg: 0, partesCaj: 0, kgxuni: 0, kgCaj: 0 };
    if (!partes.has(key)){
      partes.set(key, {
        desc: parte || "(sin desc)",
        sector: sector || "",
        stockIniUni: f.stockIniUni,
        stockIniCaj: f.stockIniCaj,
        stockIniKg: f.stockIniKg,
        cajones: 0,
        kg: 0,
        uni: 0
      });
    }
    const ent = partes.get(key);
    // Prioridad: lo cargado por el operario. Si es 0, fallback al calculo desde factor.
    let uni = uniRaw > 0 ? uniRaw : (f.partesCaj > 0 ? caj * f.partesCaj : 0);
    let kg  = kgRaw > 0  ? kgRaw  : (f.kgCaj > 0     ? caj * f.kgCaj     : 0);
    if (kg === 0 && uni > 0 && f.kgxuni > 0) kg = uni * f.kgxuni;
    ent.cajones += signo * caj;
    ent.kg += signo * kg;
    ent.uni += signo * uni;
  };
  const filtraFecha = (fechaRaw) => {
    if (!fechaHastaISO) return true;
    const iso = parseFechaToISO(fechaRaw);
    if (!iso) return false;
    return iso <= fechaHastaISO;
  };
  // Seed: entradas con stockIni (cualquiera de las 3 unidades) > 0 aunque no haya movimientos
  datos.factores.forEach((f, fkey) => {
    if (!f.stockIniUni && !f.stockIniCaj && !f.stockIniKg) return;
    const [tNorm, sectorNorm, descNorm] = fkey.split("__");
    const nombre = nombresTall.get(tNorm);
    const partInfo = partesDescTall.get(`${sectorNorm}__${descNorm}`);
    if (!nombre || !partInfo) return;
    add(nombre, partInfo.parte, partInfo.sector, 0, 0, 0, 0);
  });
  // ENVIOS Talleristas: Cervantes → Tall (suma stock Tall)
  datos.envios.forEach(r => {
    if (!filtraFecha(r["Dia-mes"])) return;
    add(
      String(r["Tallerista"] || "").trim(),
      String(r["Descripcion"] || "").trim(),
      String(r["Sector"] || "").trim(),
      +1,
      Number(r["Cajones"] || 0),
      parseDecimal(r["KG"]),
      Number(r["Unidades"] || 0)
    );
  });
  // ENTREGAS VIRGILIO: Tall → Virgilio (resta stock Tall)
  // "Cajas" = CAJAS DE ARTICULO TERMINADO. Convertir cajas × partes_x_cja → unidades de la parte.
  // NO restar Cajones (caja de art != cajon de parte).
  (datos.entregasVirg || datos.entregasTall || []).forEach(r => {
    if (!filtraFecha(r["Fecha"])) return;
    const tall = String(r["Nombre_Tall"] || "").trim();
    const tallNorm = normalizeText(tall);
    const cod = String(r["Cod"] || "").trim();
    const info = datos.codInfo.get(`${tallNorm}__${cod}`) || datos.codInfoGen.get(cod) || null;
    const desc = (info && info.desc) || (cod ? `Cod ${cod}` : "(sin cod)");
    const sector = (info && info.sector) || "";
    const cajasArt = Number(r["Cajas"] || 0);
    const kgGrj = parseDecimal(r["Kg_GRJ"]);
    const fkey = `${tallNorm}__${normalizeText(sector)}__${normalizeText(desc)}`;
    const f = datos.factores.get(fkey) || { partesCaj: 0, kgxuni: 0 };
    const uniParte = cajasArt * (f.partesCaj || 0);
    add(tall, desc, sector, -1, 0, kgGrj, uniParte);
  });

  // ENTREGAS CERVANTES: Tall → Cervantes (resta stock Tall)
  // Son PARTES PROCESADAS, no articulo terminado. Cajas = cajones de la parte (directo).
  // Kg_GRJ = kg cargado. Restar normal.
  (datos.entregasCerv || []).forEach(r => {
    if (!filtraFecha(r["Fecha"])) return;
    const tall = String(r["Nombre_Tall"] || "").trim();
    const tallNorm = normalizeText(tall);
    const cod = String(r["Cod"] || "").trim();
    const info = datos.codInfo.get(`${tallNorm}__${cod}`) || datos.codInfoGen.get(cod) || null;
    const desc = (info && info.desc) || (cod ? `Cod ${cod}` : "(sin cod)");
    const sector = (info && info.sector) || "";
    const cajas = Number(r["Cajas"] || 0);
    const kg = parseDecimal(r["Kg_GRJ"]);
    add(tall, desc, sector, -1, cajas, kg, 0);
  });
  return result;
}

// ===== Poblar dropdown nombres del origen actual =====
function poblarSelNombre(stockMap){
  const prev = selNombreEl.value;
  const nombres = [...stockMap.keys()].sort((a,b) => a.localeCompare(b, "es"));
  selNombreEl.innerHTML = `<option value="__todos__">Todos</option>` +
    nombres.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  // Restaurar selección anterior si sigue presente
  if (prev && (prev === "__todos__" || nombres.includes(prev))){
    selNombreEl.value = prev;
  }
  labelNombreEl.textContent = selOrigen === "ps" ? "Proveedor de Servicios" : "Tallerista";
}

// ===== Render =====
function renderTabla(stockMap){
  // stockMap: Map<nombre, Map<parteKey, {desc, sector, cajones, kg, uni}>>
  const fDesc = normalizeText(filtroDescEl.value);
  const fSec = normalizeText(filtroSectorEl.value);
  const selNom = selNombreEl.value;
  const fNom = (selNom && selNom !== "__todos__") ? normalizeText(selNom) : "";

  const rows = [];
  let totalFilas = 0;
  let totalNombres = 0;

  const nombres = [...stockMap.keys()].sort((a,b) => a.localeCompare(b, "es"));

  nombres.forEach(nombre => {
    if (fNom && normalizeText(nombre) !== fNom) return;
    const partes = stockMap.get(nombre);
    const filas = [];
    let subCaj = 0, subKg = 0, subUni = 0;
    [...partes.values()]
      .filter(p => !fDesc || normalizeText(p.desc).includes(fDesc))
      .filter(p => !fSec || normalizeText(p.sector).includes(fSec))
      .sort((a,b) => (a.sector || "").localeCompare(b.sector || "", "es", { numeric: true }) ||
                     a.desc.localeCompare(b.desc, "es"))
      .forEach(p => {
        // Saltea filas todo 0 (sin stock inicial en ninguna unidad y sin movimientos)
        const noStockIni = Math.abs(p.stockIniUni || 0) < 0.0001 && Math.abs(p.stockIniCaj || 0) < 0.0001 && Math.abs(p.stockIniKg || 0) < 0.0001;
        if (Math.abs(p.cajones) < 0.0001 && Math.abs(p.kg) < 0.0001 && Math.abs(p.uni) < 0.0001 && noStockIni) return;
        filas.push(p);
        subCaj += p.cajones;
        subKg += p.kg;
        subUni += p.uni;
      });
    if (!filas.length) return;
    totalNombres++;
    totalFilas += filas.length;
    rows.push(`<tr class="group-header"><td colspan="8">${escapeHtml(nombre)}</td></tr>`);
    // Nota: el colspan=8 cubre las 8 cols (Sector + Desc + 3 ini + 3 final)
    filas.forEach(p => {
      // Cada Stock Inicial es independiente — no se convierte, se suma a su unidad respectiva
      const finalCaj = (p.stockIniCaj || 0) + p.cajones;
      const finalKg  = (p.stockIniKg || 0)  + p.kg;
      const finalUni = (p.stockIniUni || 0) + p.uni;
      const negCaj = finalCaj < 0 ? "neg" : "";
      const negKg  = finalKg < 0 ? "neg" : "";
      const negUni = finalUni < 0 ? "neg" : "";
      const sIniCajTxt = p.stockIniCaj ? fmtInt(p.stockIniCaj) : "—";
      const sIniKgTxt  = p.stockIniKg  ? fmtKg(p.stockIniKg)   : "—";
      const sIniUniTxt = p.stockIniUni ? fmtInt(p.stockIniUni) : "—";
      const finalCajTxt = finalCaj !== 0 ? fmtInt(finalCaj) : "—";
      const finalKgTxt  = finalKg  !== 0 ? fmtKg(finalKg)   : "—";
      const finalUniTxt = finalUni !== 0 ? fmtInt(finalUni) : "—";
      rows.push(`<tr class="parte-row" data-nombre="${escapeHtml(nombre)}" data-parte="${escapeHtml(p.desc)}" data-sector="${escapeHtml(p.sector || "")}">
        <td>${escapeHtml(p.sector || "—")}</td>
        <td class="col-desc">${escapeHtml(p.desc)}</td>
        <td class="num col-ini">${sIniCajTxt}</td>
        <td class="num sep-uni-r col-ini">${sIniKgTxt}</td>
        <td class="num col-uni-ini sep-uni-l col-ini">${sIniUniTxt}</td>
        <td class="num ${negCaj}">${finalCajTxt}</td>
        <td class="num sep-uni-r ${negKg}">${finalKgTxt}</td>
        <td class="num col-uni-fin sep-uni-l ${negUni}">${finalUniTxt}</td>
      </tr>`);
    });
  });

  filtroCountEl.textContent = totalNombres
    ? `${totalNombres} ${selOrigen === "ps" ? "proveedores" : "talleristas"}, ${totalFilas} partes`
    : "Sin resultados";

  if (!rows.length){
    resultEl.innerHTML = `<div class="status">No hay datos para mostrar.</div>`;
    return;
  }

  resultEl.innerHTML = `
    <div id="printArea">
      <div class="report-head">Stock Online ${selOrigen === "ps" ? "Prov. Servicios" : "Talleristas"} — Hasta: ${fechaHasta || "(todo)"}</div>
      <table class="stock-table">
        <thead>
          <tr class="hdr-top">
            <th rowspan="2">Sector</th>
            <th rowspan="2">Descripción</th>
            <th colspan="2" class="sep-uni-r col-ini">Stock Inicial</th>
            <th rowspan="2" class="col-uni-ini sep-uni-l col-ini">Uni Inicial</th>
            <th colspan="2" class="sep-uni-r">Stock Online</th>
            <th rowspan="2" class="col-uni-fin sep-uni-l">Uni Online</th>
          </tr>
          <tr class="hdr-sub">
            <th class="col-ini">Cajones</th>
            <th class="sep-uni-r col-ini">Kg</th>
            <th>Cajones</th>
            <th class="sep-uni-r">Kg</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
  `;
  // Wire click handlers para abrir popup detalle
  resultEl.querySelectorAll("tr.parte-row").forEach(tr => {
    tr.addEventListener("click", () => {
      abrirPopupDetalle(tr.dataset.nombre, tr.dataset.parte, tr.dataset.sector);
    });
  });
}

// ===== Popup detalle envios + entregas =====
function abrirPopupDetalle(nombre, parte, sector){
  const datos = selOrigen === "ps" ? cache.ps : cache.tall;
  if (!datos) return;
  const overlay = document.getElementById("popupOverlay");
  const titulo = document.getElementById("popupTitle");
  const body = document.getElementById("popupBody");
  titulo.textContent = `${nombre} — ${parte}${sector ? " (" + sector + ")" : ""}`;

  const parteNorm = normalizeText(parte);
  const sectorNorm = normalizeText(sector);
  const nombreNorm = normalizeText(nombre);
  const hastaISO = fechaHasta || "";
  const filtraFecha = (raw) => {
    if (!hastaISO) return true;
    const iso = parseFechaToISO(raw);
    return iso ? iso <= hastaISO : false;
  };

  let enviosList = [];
  let entregasList = [];

  if (selOrigen === "ps"){
    // Factor PS: uniCaj = uni de la parte por cajon, kgUni = kg por unidad
    const fkeyPS = `${nombreNorm}__${sectorNorm}__${parteNorm}`;
    const fPS = (datos.factores && datos.factores.get(fkeyPS)) || { uniCaj: 0, kgUni: 0 };
    const calcUni = (caj, kg, uniCargado) => {
      if (uniCargado > 0) return uniCargado;
      if (caj > 0 && fPS.uniCaj > 0) return caj * fPS.uniCaj;
      if (kg > 0 && fPS.kgUni > 0) return kg / fPS.kgUni;
      return 0;
    };
    enviosList = datos.envios
      .filter(r => normalizeText(r["Prov_Serv"]) === nombreNorm
                && normalizeText(r["Parte"]) === parteNorm
                && normalizeText(r["Sector SP"]) === sectorNorm
                && filtraFecha(r["Dia-mes"]))
      .map(r => {
        const caj = Number(r["Cajones"] || 0);
        const kg = parseDecimal(r["KG"]);
        return { fecha: r["Dia-mes"] || "", caj, kg, uni: calcUni(caj, kg, Number(r["Unidades"] || 0)) };
      });
    entregasList = datos.entregas
      .filter(r => normalizeText(r["Prov_Serv"]) === nombreNorm
                && normalizeText(r["Parte"]) === parteNorm
                && normalizeText(r["Sector SP"]) === sectorNorm
                && filtraFecha(r["Dia-mes"]))
      .map(r => {
        const caj = Number(r["Cajones"] || 0);
        const kg = parseDecimal(r["KG"]);
        return { fecha: r["Dia-mes"] || "", caj, kg, uni: calcUni(caj, kg, 0) };
      });
  } else {
    // Tall: envios match por Tallerista + Descripcion + Sector
    enviosList = datos.envios
      .filter(r => normalizeText(r["Tallerista"]) === nombreNorm
                && normalizeText(r["Descripcion"]) === parteNorm
                && normalizeText(r["Sector"]) === sectorNorm
                && filtraFecha(r["Dia-mes"]))
      .map(r => ({
        fecha: r["Dia-mes"] || "",
        caj: Number(r["Cajones"] || 0),
        kg: parseDecimal(r["KG"]),
        uni: Number(r["Unidades"] || 0)
      }));
    // Entregas Tall Virgilio: cajas de articulo terminado
    const matchFn = r => {
      if (normalizeText(r["Nombre_Tall"]) !== nombreNorm) return false;
      if (!filtraFecha(r["Fecha"])) return false;
      const cod = String(r["Cod"] || "").trim();
      const tNorm = normalizeText(r["Nombre_Tall"]);
      const info = datos.codInfo.get(`${tNorm}__${cod}`) || datos.codInfoGen.get(cod) || null;
      const d = info ? info.desc : (cod ? `Cod ${cod}` : "");
      const s = info ? info.sector : "";
      return normalizeText(d) === parteNorm && normalizeText(s) === sectorNorm;
    };
    // Virgilio: convertir cajas (de art terminado) a uni de la parte usando partes_x_cja
    const fkeyTall = `${nombreNorm}__${sectorNorm}__${parteNorm}`;
    const fTall = datos.factores.get(fkeyTall) || { partesCaj: 0 };
    entregasList = (datos.entregasVirg || datos.entregasTall || [])
      .filter(matchFn)
      .map(r => {
        const caj = Number(r["Cajas"] || 0);
        return {
          fecha: r["Fecha"] || "",
          caj,
          kg: parseDecimal(r["Kg_GRJ"]),
          uni: caj * (fTall.partesCaj || 0)
        };
      });
    // 2da lista: entregas Cervantes (partes procesadas)
    // Uni = cajones * partes_x_cja (mismo factor que Virgilio aplicado al cajon de la parte).
    // Si no hay factor, fallback: kg / kgxuni.
    var entregasCervList = (datos.entregasCerv || [])
      .filter(matchFn)
      .map(r => {
        const caj = Number(r["Cajas"] || 0);
        const kg = parseDecimal(r["Kg_GRJ"]);
        let uni = caj * (fTall.partesCaj || 0);
        if (!uni && kg > 0 && fTall.kgxuni > 0) uni = kg / fTall.kgxuni;
        return { fecha: r["Fecha"] || "", caj, kg, uni };
      });
  }

  // Sort por fecha (parsed)
  const sortByFecha = (a,b) => (parseFechaToISO(b.fecha) || "").localeCompare(parseFechaToISO(a.fecha) || "");
  enviosList.sort(sortByFecha);
  entregasList.sort(sortByFecha);

  const renderList = (list, titulo, labelUni) => {
    if (!list.length) return `<h3>${titulo}</h3><div class="empty">Sin registros.</div>`;
    const tot = list.reduce((acc, x) => ({ caj: acc.caj+x.caj, kg: acc.kg+x.kg, uni: acc.uni+x.uni }), { caj:0, kg:0, uni:0 });
    return `<h3>${titulo} — ${list.length} reg.</h3>
      <table>
        <thead><tr><th class="col-fecha">Fecha</th><th>${labelUni}</th><th>Kg</th><th>Uni</th></tr></thead>
        <tbody>${list.map(x => `<tr>
          <td>${escapeHtml(x.fecha)}</td>
          <td>${fmtInt(x.caj)}</td>
          <td>${fmtKg(x.kg)}</td>
          <td>${x.uni ? fmtInt(x.uni) : "—"}</td>
        </tr>`).join("")}</tbody>
        <tfoot><tr style="font-weight:800">
          <td>Total</td>
          <td>${fmtInt(tot.caj)}</td>
          <td>${fmtKg(tot.kg)}</td>
          <td>${tot.uni ? fmtInt(tot.uni) : "—"}</td>
        </tr></tfoot>
      </table>`;
  };

  // Tall: 3 listas (envios + entregas Virg + entregas Cerv). PS: 2 listas tradicionales.
  if (selOrigen === "tall") {
    if (entregasCervList) entregasCervList.sort(sortByFecha);
    body.innerHTML = renderList(enviosList, "📤 Envíos (Cervantes → Tall)", "Cajones")
                   + renderList(entregasCervList || [], "📥 Entregas Cervantes (partes procesadas)", "Cajones")
                   + renderList(entregasList, "📥 Entregas Virgilio (artículo terminado)", "Cajas");
  } else {
    body.innerHTML = renderList(enviosList, "📤 Envíos (Cervantes → PS)", "Cajones")
                   + renderList(entregasList, "📥 Entregas (PS → Cervantes)", "Cajones");
  }
  overlay.classList.remove("hidden");
}

document.getElementById("popupClose").addEventListener("click", () => {
  document.getElementById("popupOverlay").classList.add("hidden");
});
document.getElementById("popupOverlay").addEventListener("click", (e) => {
  if (e.target.id === "popupOverlay") e.target.classList.add("hidden");
});

// ===== Generar (carga + calcula + render) =====
async function generar(){
  fechaHasta = inHasta.value || "";
  try {
    let datos, stockMap;
    if (selOrigen === "ps"){
      datos = await cargarDatosPS();
      stockMap = calcularStockPS(datos, fechaHasta);
    } else {
      datos = await cargarDatosTall();
      stockMap = calcularStockTall(datos, fechaHasta);
    }
    poblarSelNombre(stockMap);
    renderTabla(stockMap);
  } catch(e){
    console.error(e);
    setStatus("Error: " + e.message);
  }
}

// ===== Wiring =====
function wireGrupo(idGrupo, setter){
  const grp = document.getElementById(idGrupo);
  grp.querySelectorAll(".opt").forEach(b => {
    b.addEventListener("click", () => {
      grp.querySelectorAll(".opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      setter(b.dataset.val);
    });
  });
}

wireGrupo("grpOrigen", v => { selOrigen = v; generar(); });

document.getElementById("btnHoy").addEventListener("click", () => {
  const hoy = new Date();
  inHasta.value = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,"0")}-${String(hoy.getDate()).padStart(2,"0")}`;
  generar();
});

inHasta.addEventListener("change", generar);
[filtroDescEl, filtroSectorEl].forEach(el => {
  el.addEventListener("input", () => {
    const datos = selOrigen === "ps" ? cache.ps : cache.tall;
    if (!datos) return;
    const stockMap = selOrigen === "ps"
      ? calcularStockPS(datos, fechaHasta)
      : calcularStockTall(datos, fechaHasta);
    renderTabla(stockMap);
  });
});
selNombreEl.addEventListener("change", () => {
  const datos = selOrigen === "ps" ? cache.ps : cache.tall;
  if (!datos) return;
  const stockMap = selOrigen === "ps"
    ? calcularStockPS(datos, fechaHasta)
    : calcularStockTall(datos, fechaHasta);
  renderTabla(stockMap);
});

document.getElementById("btnToggleIni").addEventListener("click", (e) => {
  const tbl = resultEl.querySelector(".stock-table");
  if (!tbl) return;
  const hidden = tbl.classList.toggle("hide-ini");
  e.currentTarget.textContent = hidden ? "👁 Mostrar Stock Inicial" : "👁 Ocultar Stock Inicial";
});

document.getElementById("btnRefresh").addEventListener("click", () => {
  cache.ps = null; cache.tall = null;
  generar();
});

document.getElementById("btnImprimir").addEventListener("click", () => {
  const cont = document.getElementById("printArea");
  if (!cont) return;
  const win = window.open("", "_blank", "width=1100,height=750");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Stock Online</title>
    <style>
      *{box-sizing:border-box;background:transparent !important;color:#111 !important}
      body{font-family:Arial,sans-serif;padding:14px;color:#111;background:#fff}
      table{border-collapse:collapse;border:2.5px solid #111;background:transparent}
      th,td{border:1px solid #111;padding:4px 8px;font-size:12px;text-align:center;white-space:nowrap;background:transparent !important;color:#111 !important}
      thead th{font-weight:800;border:2.5px solid #111}
      tr.group-header td{text-align:left;font-weight:800;border-top:2px solid #111;border-bottom:2px solid #111}
      tr.subtotal-row td{font-weight:800}
      td.col-desc{text-align:left}
      .num{font-variant-numeric:tabular-nums}
      .neg{color:#111 !important;font-weight:700}
      .report-head{font-weight:700;font-size:14px;margin-bottom:8px}
      @page{margin:12mm;size:landscape}
      @media print{
        *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      }
    </style></head><body>${cont.innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  win.onload = () => win.print();
  setTimeout(() => { try { win.print(); } catch(e){} }, 300);
});

// Init
(function init(){
  const hoy = new Date();
  inHasta.value = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,"0")}-${String(hoy.getDate()).padStart(2,"0")}`;
  generar();
})();
