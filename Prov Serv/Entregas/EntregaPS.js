"use strict";

/***********************
 * CONFIG
 ***********************/
const SUCURSAL = "Cerv";

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";

const SUPABASE_TABLE = "Partes x PS";
const COL_PS = "PS";
const COL_PROCESO = "Proceso";
const COL_PARTE = "Parte";
const COL_SC = "SC";
const COL_SP = "SP";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function formatNumKgEnt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

// Tandas por idx (en memoria de esta vista)
const tandasByIdx = {};

function parseDecimalEPS(v){
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[^\d,.-]/g,"");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Flags por PS (carga_por_unidades, sin_cajones)
let psFlagsMap = new Map(); // ps -> { cargaPorUnidades, sinCajones }

async function cargarPSFlags() {
  try {
    const { data } = await sb.from("Tall_ProvAT_PS").select("nombre, carga_por_unidades, sin_cajones");
    if (data) {
      psFlagsMap = new Map(data.map(r => [
        String(r.nombre || "").trim(),
        { cargaPorUnidades: Boolean(r.carga_por_unidades), sinCajones: Boolean(r.sin_cajones) }
      ]));
    }
  } catch (e) { console.warn("[EntregaPS] cargarPSFlags fallo:", e); }
}

function getPSFlags(ps) {
  return psFlagsMap.get(ps) || { cargaPorUnidades: false, sinCajones: false };
}

/***********************
 * DOM
 ***********************/
const statusEl = document.getElementById("status");
const psGridWrap = document.getElementById("psGridWrap");
const psGrid = document.getElementById("psGrid");

const selectedBar = document.getElementById("selectedBar");
const selectedBadge = document.getElementById("selectedBadge");
const btnVolver = document.getElementById("btnVolver");
const btnEnviarCambios = document.getElementById("btnEnviarCambios");
const btnEnviarCambiosTop = document.getElementById("btnEnviarCambiosTop");
// Espejo del boton de abajo en el header. Hereda enabled/disabled del original.
if (btnEnviarCambiosTop) {
  btnEnviarCambiosTop.addEventListener("click", () => btnEnviarCambios.click());
  const sync = () => {
    btnEnviarCambiosTop.disabled = btnEnviarCambios.disabled;
    btnEnviarCambiosTop.classList.toggle("disabled", btnEnviarCambios.disabled);
  };
  new MutationObserver(sync).observe(btnEnviarCambios, { attributes: true, attributeFilter: ['disabled', 'class'] });
}

const detailWrap = document.getElementById("detailWrap");
const resultBody = document.getElementById("resultBody");
const tableTitle = document.getElementById("tableTitle");
const tableMsg = document.getElementById("tableMsg");

const successBox = document.getElementById("successBox");
const successCodeEl = document.getElementById("successCode");
const okBtn = document.getElementById("okBtn");

const sheetForm = document.getElementById("sheetForm");
const payloadField = document.getElementById("payloadField");
const iframe = document.querySelector('iframe[name="sheet_iframe"]');

/***********************
 * STATE
 ***********************/
let availablePS = [];
let selectedPS = "";
let fetchedItems = [];
let isSubmitting = false;
let lastSendCode = null;

/***********************
 * HELPERS
 ***********************/
function uniqueSorted(arr) {
  return [...new Set(arr.map(v => String(v || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function arDateISO() {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
}

function genNumericCode(len = 4) {
  const min = Math.pow(10, len - 1);
  const max = Math.pow(10, len) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

function showSuccess(code) {
  successCodeEl.textContent = code;
  successBox.style.display = "block";
}

function hideSuccess() {
  successBox.style.display = "none";
  successCodeEl.textContent = "—";
}

function setStatus(text, type = "") {
  statusEl.className = "status" + (type ? ` ${type}` : "");
  statusEl.textContent = text;
}

function setTableMsg(text, type = "") {
  tableMsg.className = "status" + (type ? ` ${type}` : "");
  tableMsg.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/***********************
 * DATA
 ***********************/
// Mapa PS -> proceso (lee Tall_ProvAT_PS.especializacion)
let procesoPorPSMapEnt = new Map();
let psPorProcesoMapEnt = new Map();

// ===== Datos de stock (Online SP / Online PS) — portado de EnviosPS =====
const parseDecimal = parseDecimalEPS;
let stockDataCache = null;
let stockDataPromise = null;

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
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
    const [spKgRows, entregasPSRows, enviosTallRows, enviosAPSRows, entregasLogRows, despieceRows, causaEfectoRows, dbEspejoRows] = await Promise.all([
      sb.from("SP Kg").select("*").then(r => r.data || []),
      cargarTablaPaginada("Entregas PS"),
      cargarTablaPaginada("Envios a Talleristas"),
      cargarTablaPaginada("Envios a PS"),
      cargarTablaPaginada("Entregas_Tall_Todas").then(r => r.filter(x => {
        const cod = String(x["Codigo_Tall"] || "").trim();
        const nom = String(x["Nombre_Tall"] || "").trim().toLowerCase();
        return cod === "0001" || nom.includes("log");
      })),
      sb.from("Despiece x Articulo").select('"COD","Sector Proce"').then(r => r.data || []),
      sb.from("Causa-Efecto").select("*").then(r => r.data || []),
      cargarTablaPaginada("db_n8n_espejo", [{ col: "Legajo", val: "1" }])
    ]);
    const spSet = new Set();
    const kgXUniMap = new Map();
    const kgXCajonMap = new Map();
    const mvBySP = new Map();
    spKgRows.forEach(r => {
      const sp = String(r["Sp"] || "").trim();
      if (!sp) return;
      const key = normalizeText(sp);
      const kgCaj = parseDecimal(r["KG x Cajon"] || r["KG Cajon"] || 0);
      const kgU = parseDecimal(r["Kg X Uni"] || 0);
      const stockIni = parseDecimal(r["Stock Inicial"] || 0);
      const maxCaj = parseDecimal(r["Max Cajon SP Cerv"] || 0);
      spSet.add(sp.toUpperCase());
      kgXCajonMap.set(key, kgCaj);
      if (kgU > 0) kgXUniMap.set(sp.toUpperCase(), kgU);
      mvBySP.set(key, { maxCajCerv: maxCaj, onlineCaj: kgCaj > 0 ? stockIni / kgCaj : 0 });
    });
    entregasPSRows.forEach(r => { const k = normalizeText(r["Sector SP"]); const caj = Number(r["Cajones"] || 0); if (k && caj) { const mv = mvBySP.get(k); if (mv) mv.onlineCaj += caj; } });
    enviosAPSRows.forEach(r => { const k = normalizeText(r["Sector SC"]); const caj = Number(r["Cajones"] || 0); if (k && caj) { const mv = mvBySP.get(k); if (mv) mv.onlineCaj -= caj; } });
    enviosTallRows.forEach(r => { const k = normalizeText(r["Sector"]); const caj = Number(r["Cajones"] || 0); if (k && caj) { const mv = mvBySP.get(k); if (mv) mv.onlineCaj -= caj; } });
    const codToSector = new Map();
    despieceRows.forEach(r => { const cod = normalizeCod3(r["COD"]); const sector = normalizeText(r["Sector Proce"]); if (cod && sector) codToSector.set(cod, sector); });
    entregasLogRows.forEach(r => { const codN = normalizeCod3(r["Cod"]); const cajas = Number(r["Cajas"] || 0); if (!codN || !cajas) return; const sector = codToSector.get(codN); if (!sector) return; const mv = mvBySP.get(sector); if (mv) mv.onlineCaj -= cajas; });
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
      (causaMap.get(matriz) || []).forEach(ef => {
        if (spSet.has(ef.aumenta)) { const k = normalizeText(ef.aumenta); const kgU = kgXUniMap.get(ef.aumenta) || 0; const kgCaj = kgXCajonMap.get(k) || 0; if (kgCaj > 0) { const mv = mvBySP.get(k); if (mv) mv.onlineCaj += (uni * kgU) / kgCaj; } }
        if (spSet.has(ef.descuenta)) { const k = normalizeText(ef.descuenta); const kgU = kgXUniMap.get(ef.descuenta) || 0; const kgCaj = kgXCajonMap.get(k) || 0; if (kgCaj > 0) { const mv = mvBySP.get(k); if (mv) mv.onlineCaj -= (uni * kgU) / kgCaj; } }
      });
    }
    const onlinePSCajGlobalBySP = new Map();
    const add = (sp, caj, signo) => { if (sp && caj) onlinePSCajGlobalBySP.set(sp, (onlinePSCajGlobalBySP.get(sp) || 0) + caj * signo); };
    enviosAPSRows.forEach(r => add(normalizeText(r["Sector SP"]), Number(r["Cajones"] || 0), +1));
    entregasPSRows.forEach(r => add(normalizeText(r["Sector SP"]), Number(r["Cajones"] || 0), -1));
    stockDataCache = { mvBySP, onlinePSCajGlobalBySP };
    return stockDataCache;
  })();
  return stockDataPromise;
}

async function getPSDisponibles() {
  const [{ data, error }, { data: flagsData }] = await Promise.all([
    sb.from(SUPABASE_TABLE).select(COL_PS),
    sb.from("Tall_ProvAT_PS").select("nombre, especializacion, ps")
  ]);
  if (error) throw error;
  procesoPorPSMapEnt = new Map();
  const psOcultos = new Set(); // nombres con ps=false (no mostrar como Prov Serv)
  (flagsData || []).forEach(r => {
    const ps = String(r.nombre || "").trim();
    if (!ps) return;
    procesoPorPSMapEnt.set(ps, (r.especializacion && String(r.especializacion).trim()) || "Sin asignar");
    if (r.ps === false) psOcultos.add(ps.toLowerCase());
  });
  return uniqueSorted((data || []).map(r => r[COL_PS]))
    .filter(n => !psOcultos.has(String(n || "").trim().toLowerCase()));
}

async function getItemsPorPS(ps) {
  const { data, error } = await sb
    .from(SUPABASE_TABLE)
    .select(`${COL_PS}, ${COL_PROCESO}, ${COL_PARTE}, ${COL_SC}, ${COL_SP}, "Cod_Prov_Externo", "Cod_ISIS"`)
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
    const cod = String(r["Cod_Prov_Externo"] || "").trim();
    const codIsis = String(r["Cod_ISIS"] || "").trim();

    if (!parte) return;

    const key = [parte, proceso, sc, sp].join("||");
    if (seen.has(key)) return;

    seen.add(key);
    uniques.push({
      ps: psVal,
      proceso,
      parte,
      sc,
      sp,
      cod,
      codIsis
    });
  });

  return uniques;
}

/***********************
 * UI
 ***********************/
// 2-pasos: proceso → PS
let procesoSelEnt = null;
function renderPSButtons(values) {
  psGrid.innerHTML = "";
  psPorProcesoMapEnt = new Map();
  values.forEach(ps => {
    const proc = procesoPorPSMapEnt.get(ps) || "Sin asignar";
    if (!psPorProcesoMapEnt.has(proc)) psPorProcesoMapEnt.set(proc, []);
    psPorProcesoMapEnt.get(proc).push(ps);
  });
  // Merge: Cementado + Templado → "Cementado / Templado"
  const cem = psPorProcesoMapEnt.get("Cementado") || [];
  const tem = psPorProcesoMapEnt.get("Templado") || [];
  if (cem.length || tem.length){
    psPorProcesoMapEnt.set("Cementado / Templado", [...new Set([...cem, ...tem])]);
    psPorProcesoMapEnt.delete("Cementado");
    psPorProcesoMapEnt.delete("Templado");
  }
  procesoSelEnt = null;
  renderProcesosEnt();
}

const PS_DISPLAY_ALIAS_ENT = { "gaston almafuerte": "Almafuerte" };
function aliasPS(n){ return PS_DISPLAY_ALIAS_ENT[String(n || "").trim().toLowerCase()] || n; }

function setEntregaPSTitulo(txt){
  const h1 = document.querySelector(".header-bar h1, .header-top h1, h1");
  if (h1) h1.textContent = txt;
}

// Orden custom de procesos solicitado por logística
const ORDEN_PROCESOS_ENT = [
  "Cromado", "Pintado", "Niquelado", "Pavonado",
  "Cementado / Templado",
  "Serigrafiado", "Rectificado",
  "Cortado", "Calado",
  "Adhesivado", "Armado"
];
function ordenarProcesosEnt(arr){
  const norm = s => String(s || "").trim().toLowerCase();
  const idx = new Map(ORDEN_PROCESOS_ENT.map((p,i) => [norm(p), i]));
  return [...arr].sort((a,b) => {
    if (a === "Sin asignar") return 1;
    if (b === "Sin asignar") return -1;
    const ia = idx.has(norm(a)) ? idx.get(norm(a)) : 999;
    const ib = idx.has(norm(b)) ? idx.get(norm(b)) : 999;
    if (ia !== ib) return ia - ib;
    return String(a).localeCompare(String(b), "es");
  });
}

function renderProcesosEnt() {
  setEntregaPSTitulo("Entrega de Proveedores de Servicios");
  if (btnVolver) btnVolver.classList.add("hidden"); // en procesos no hay atras
  backActionEnt = null;
  psGrid.innerHTML = "";
  const procs = ordenarProcesosEnt([...psPorProcesoMapEnt.keys()]);
  procs.forEach(proc => {
    const provs = (psPorProcesoMapEnt.get(proc) || []).slice().sort((a,b) => a.localeCompare(b, "es"));
    const provsArr = provs.map(aliasPS);
    const provsHtml = provsArr.map(escapeHtml).join("<br>");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill proceso-pill";
    btn.title = provsArr.join(", ");
    btn.innerHTML = `${escapeHtml(proc)}<br><span style="font-size:12px;opacity:.85;font-weight:600">${provsHtml}</span>`;
    btn.addEventListener("click", () => {
      procesoSelEnt = proc;
      // Si el proceso tiene un solo PS, ir directo
      if (provs.length === 1) {
        seleccionarPS(provs[0]);
      } else {
        renderPSDelProcesoEnt(proc);
      }
    });
    psGrid.appendChild(btn);
  });
}

function renderPSDelProcesoEnt(proc) {
  setEntregaPSTitulo(`Entrega · ${proc}`);
  if (btnVolver) btnVolver.classList.remove("hidden"); // Atras → procesos
  backActionEnt = () => renderProcesosEnt();
  psGrid.innerHTML = "";
  const list = psPorProcesoMapEnt.get(proc) || [];
  list.sort((a,b) => a.localeCompare(b, "es")).forEach(ps => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill";
    btn.textContent = aliasPS(ps);
    btn.addEventListener("click", async () => {
      if (isSubmitting) return;
      await seleccionarPS(ps);
    });
    psGrid.appendChild(btn);
  });
}

function renderTable(items) {
  resultBody.innerHTML = "";

  if (!items.length) {
    resultBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;color:#b42318;font-weight:700;">
          No hay partes para este proveedor.
        </td>
      </tr>
    `;
    return;
  }

  const flags = getPSFlags(selectedPS);
  const isUni = flags.cargaPorUnidades;
  const isSinCaj = flags.sinCajones;

  const rows = items.map((item, i) => {
    let cajCell, kgCell, tandaCell;
    if (isSinCaj) {
      // Charcas (kg) / AJ (uni): NO cajones, input directo
      const placeholder = isUni ? '0' : '0,0';
      const imode = isUni ? 'numeric' : 'decimal';
      const label = isUni ? 'uni' : 'kg';
      cajCell = `<td><span class="zero">—</span></td>`;
      kgCell = `<td><input class="input-kg" type="text" inputmode="${imode}" placeholder="${placeholder}" data-role="directo-${label}" data-idx="${i}"/></td>`;
      tandaCell = `<td><span class="zero">—</span></td>`;
    } else {
      // Resto: input cajones int directo + input Kg neto directo + botón T tandas
      const t = tandasByIdx[i];
      const hayTandas = Array.isArray(t) && t.length > 0;
      const totCaj = hayTandas ? t.reduce((s, x) => s + (Number(x.caj) || 0), 0) : '';
      const totKg = hayTandas ? t.reduce((s, x) => s + (parseDecimalEPS(x.kg) || 0), 0) : '';
      const cajVal = hayTandas ? totCaj : '';
      const kgVal = hayTandas ? totKg : '';
      const ro = hayTandas ? 'readonly' : '';
      const cajCls = hayTandas ? 'input-cajones input-with-tandas' : 'input-cajones';
      const kgCls = hayTandas ? 'input-kg input-with-tandas' : 'input-kg';
      cajCell = `<td><input class="${cajCls}" type="text" inputmode="numeric" placeholder="0" data-role="cajones" data-idx="${i}" style="width:60px;text-align:center" value="${cajVal}" ${ro}/></td>`;
      kgCell = `<td><input class="${kgCls}" type="text" inputmode="decimal" placeholder="0,0" data-role="kg-neto" data-idx="${i}" value="${kgVal}" ${ro}/></td>`;
      tandaCell = `<td class="center"><button type="button" class="tanda-trigger ${hayTandas ? 'has-tandas' : ''}" data-role="tandas" data-idx="${i}" title="Cargar por tandas">${hayTandas ? t.length : '+'}</button></td>`;
    }
    return `
      <tr data-idx="${i}">
        <td>${escapeHtml(item.parte)}</td>
        <td>${escapeHtml(item.proceso)}</td>
        <td>${escapeHtml(item.sc)}</td>
        <td>${escapeHtml(item.sp)}</td>
        ${cajCell}
        ${kgCell}
        ${tandaCell}
      </tr>
    `;
  }).join("");

  resultBody.innerHTML = rows;

  // Botón Tandas
  resultBody.querySelectorAll('button[data-role="tandas"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.idx);
      abrirTandasFilaEntPS(i);
    });
  });

  // Input cajones: solo enteros
  resultBody.querySelectorAll('input[data-role="cajones"]').forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "");
      updateEnviarState();
    });
  });

  // Input Kg neto directo (no se recalcula nada)
  resultBody.querySelectorAll('input[data-role="kg-neto"]').forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value
        .replace(/[^0-9,]/g, "")
        .replace(/(,.*),/g, '$1');
      updateEnviarState();
    });
  });

  // Inputs directos (sin_cajones): Kg para Charcas, Uni para AJ
  resultBody.querySelectorAll('input[data-role^="directo-"]').forEach(input => {
    input.addEventListener("input", () => {
      const isUni = input.dataset.role === 'directo-uni';
      input.value = isUni
        ? input.value.replace(/\D/g, "")
        : input.value.replace(/[^0-9,]/g, "").replace(/(,.*),/g, '$1');
      updateEnviarState();
    });
  });
}

// Acción del botón "Atras" del header, seteada por cada vista
let backActionEnt = null;

function goBackFromTableEnt(){
  if (isSubmitting) return;
  // Si entramos por familia (multi-familia PS) → volver a familias sin perder lo cargado
  if (familiaSelEnt && itemsBasePSEnt.length > 0 && familiasPresentesEnt(itemsBasePSEnt).size > 1) {
    familiaSelEnt = null;
    fetchedItems = [];
    selectedBadge.textContent = selectedPS;
    tableTitle.textContent = selectedPS;
    resultBody.innerHTML = "";
    setTableMsg("");
    hideSuccess();
    showSelectionView();
    setStatus("Seleccioná una familia para continuar.", "");
    renderFamiliasEnt();
    return;
  }
  resetAll();
}

function showSelectionView() {
  psGridWrap.classList.remove("hidden");
  detailWrap.classList.add("hidden");
  selectedBar.classList.add("hidden");
  btnEnviarCambios.classList.add("hidden");
  if (btnVolver) btnVolver.classList.add("hidden");
}

function showDetailView() {
  psGridWrap.classList.add("hidden");
  detailWrap.classList.remove("hidden");
  selectedBar.classList.remove("hidden");
  btnEnviarCambios.classList.remove("hidden");
  if (btnVolver) btnVolver.classList.remove("hidden");
  backActionEnt = goBackFromTableEnt;
}

function updateEnviarState() {
  const items = getItemsFromTable();
  const filtered = filterItemsToSend(items);
  const enabled = !isSubmitting && selectedPS && filtered.length > 0;

  btnEnviarCambios.classList.toggle("enabled", enabled);
  btnEnviarCambios.disabled = !enabled;
  if (btnEnviarCambiosTop){
    btnEnviarCambiosTop.classList.toggle("enabled", enabled);
    btnEnviarCambiosTop.disabled = !enabled;
  }
}

function resetAll() {
  selectedPS = "";
  fetchedItems = [];
  itemsBasePSEnt = [];
  familiaSelEnt = null;
  clearEntregaBuf();
  gruposAbiertosEnt = new Set();
  isSubmitting = false;
  lastSendCode = null;

  selectedBadge.textContent = "";
  tableTitle.textContent = "Proveedor";
  resultBody.innerHTML = "";
  setTableMsg("");

  hideSuccess();
  showSelectionView();
  setStatus("Seleccioná un proveedor para continuar.", "bad");
  updateEnviarState();

  // Restaurar lista de PSs del proceso actual (psGrid puede estar mostrando familias)
  if (typeof procesoSelEnt !== 'undefined' && procesoSelEnt && typeof renderPSDelProcesoEnt === 'function') {
    renderPSDelProcesoEnt(procesoSelEnt);
  } else if (typeof renderProcesosEnt === 'function') {
    renderProcesosEnt();
  } else {
    psGrid.querySelectorAll(".ps-pill").forEach(btn => btn.classList.remove("active"));
  }
}

// === Agrupado por familia (Pelador / Sacacorchos / Abrelatas / Otros) ===
const FAMILIAS_ORDEN_ENT = ["Pelador", "Sacacorchos", "Abrelatas", "Otros"];
// PSs que NO usan el paso de familias (van directo a la tabla completa)
const PS_SIN_FAMILIAS_ENT = new Set(["pedernera"]);
// PSs que usan agrupacion POR CODIGO (botones de 9 partes -> popup de entrega)
const PS_POR_CODIGO_ENT = new Set(["pedernera"]);
let itemsBasePSEnt = [];
let familiaSelEnt = null;
let gruposAbiertosEnt = new Set();
let entregaBuf = {}; // buffer en memoria del flujo por codigo: key sc__parte -> {sc,parte,sp,proceso,cajones,kg,tandas}

function clasificarFamiliaEnt(parte) {
  const p = String(parte || '').toLowerCase();
  if (/pelad|pelap/.test(p)) return 'Pelador';
  if (/sacacorch|sac\s*comb|sac\s*mozo|sacatap|aleta|cabezal|destapacorona/.test(p)) return 'Sacacorchos';
  if (/abrelat|maripos|varilla\s*c\/?\s*cuch|manija|mgo\s*plano|engranaje|cpo\s*u[ñn]a/.test(p)) return 'Abrelatas';
  return 'Otros';
}

function familiasPresentesEnt(items) {
  const s = new Set();
  items.forEach(it => s.add(clasificarFamiliaEnt(it.parte || it.Parte)));
  return s;
}

function renderFamiliasEnt() {
  setEntregaPSTitulo(`Entrega de ${aliasPS(selectedPS)}`);
  if (btnVolver) btnVolver.classList.remove("hidden"); // Atras → PS/procesos
  backActionEnt = () => {
    selectedPS = "";
    itemsBasePSEnt = [];
    fetchedItems = [];
    familiaSelEnt = null;
    const provs = procesoSelEnt ? (psPorProcesoMapEnt.get(procesoSelEnt) || []) : [];
    if (procesoSelEnt && provs.length > 1) renderPSDelProcesoEnt(procesoSelEnt);
    else { procesoSelEnt = null; renderProcesosEnt(); }
  };
  psGrid.innerHTML = "";
  familiaSelEnt = null;
  const counts = new Map();
  itemsBasePSEnt.forEach(it => {
    const f = clasificarFamiliaEnt(it.parte || it.Parte);
    counts.set(f, (counts.get(f) || 0) + 1);
  });
  FAMILIAS_ORDEN_ENT.forEach(fam => {
    const cnt = counts.get(fam) || 0;
    if (cnt === 0) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill familia-pill";
    btn.textContent = fam;
    btn.addEventListener("click", () => seleccionarFamiliaEnt(fam));
    psGrid.appendChild(btn);
  });
}

function seleccionarFamiliaEnt(fam) {
  familiaSelEnt = fam;
  fetchedItems = itemsBasePSEnt.filter(it => clasificarFamiliaEnt(it.parte || it.Parte) === fam);
  setEntregaPSTitulo(`Entrega de ${aliasPS(selectedPS)} · ${fam}`);
  selectedBadge.textContent = `${selectedPS} · ${fam}`;
  tableTitle.textContent = `${selectedPS} · ${fam}`;
  renderTable(fetchedItems);
  showDetailView();
  setStatus("Proveedor cargado correctamente.", "ok");
  setTableMsg("Completá solo cajones enteros mayores a 0.");
  updateEnviarState();
}

// === Pedernera: un botón por item (código + descripción) + buscador → popup de entrega ===
function clearEntregaBuf(){ entregaBuf = {}; }

// Codigo a mostrar: el nuevo de ISIS (Cod_ISIS). Si la parte todavia no tiene, cae al viejo de 7 digitos.
// Sin Cod_ISIS al 2026-07-15: 5160600, 5204600, 5206600, Plancha de Niquel, Destapador Pie Cromado.
// Ver PROBLEMAS_CODIGOS_ISIS_2026-07-15.md en la raiz.
function codMostrarEnt(item){ return item.codIsis || item.cod || "—"; }

function renderGruposCodigoEnt() {
  setEntregaPSTitulo(`Entrega de ${aliasPS(selectedPS)}`);
  showSelectionView();
  if (btnVolver) btnVolver.classList.remove("hidden");
  gruposAbiertosEnt = new Set();
  backActionEnt = () => {
    clearEntregaBuf();
    gruposAbiertosEnt = new Set();
    selectedPS = ""; itemsBasePSEnt = []; fetchedItems = [];
    const provs = procesoSelEnt ? (psPorProcesoMapEnt.get(procesoSelEnt) || []) : [];
    if (procesoSelEnt && provs.length > 1) renderPSDelProcesoEnt(procesoSelEnt);
    else { procesoSelEnt = null; renderProcesosEnt(); }
  };
  psGrid.innerHTML = "";

  const buscador = document.createElement("div");
  buscador.className = "item-buscador";
  buscador.innerHTML = `<input type="search" id="buscadorItemsEnt" placeholder="Buscar por código o descripción..." autocomplete="off">
    <label for="fechaEntregaGrupos">Fecha:</label><input type="date" id="fechaEntregaGrupos">`;
  psGrid.appendChild(buscador);

  const vacio = document.createElement("div");
  vacio.id = "itemsVacioEnt";
  vacio.className = "item-vacio hidden";
  vacio.textContent = "Sin resultados para esa búsqueda.";
  psGrid.appendChild(vacio);

  const sorted = [...itemsBasePSEnt].sort((a,b)=>{ const ca=a.cod||"zzzzzzzz",cb=b.cod||"zzzzzzzz"; return ca.localeCompare(cb,"es",{numeric:true}); });
  sorted.forEach(item => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill item-cod-pill";
    btn.dataset.key = `${item.sc}__${item.parte}`;
    // Busca por codigo nuevo (ISIS) y por el viejo: durante la transicion los papeles traen cualquiera de los dos
    btn.dataset.search = normalizeText(`${item.codIsis||""} ${item.cod||""} ${item.parte||""} ${item.sc||""}`);
    btn.innerHTML = `<span class="ic-cod">${escapeHtml(codMostrarEnt(item))}</span><span class="ic-desc">${escapeHtml(item.parte||"")}</span>`;
    btn.addEventListener("click", () => abrirPopupGrupoEntrega([item]));
    psGrid.appendChild(btn);
  });

  const inputBuscar = buscador.querySelector("#buscadorItemsEnt");
  inputBuscar.addEventListener("input", () => filtrarItemsEnt(inputBuscar.value));

  const acciones = document.createElement("div");
  acciones.className = "grupo-acciones";
  acciones.innerHTML = `<button id="btnEnviarGruposEnt" class="btn-enviar" type="button">Enviar</button>`;
  psGrid.appendChild(acciones);
  const fInput = buscador.querySelector("#fechaEntregaGrupos");
  if (fInput && !fInput.value) fInput.value = arDateISO();
  acciones.querySelector("#btnEnviarGruposEnt").addEventListener("click", async (e) => {
    const btnE = e.currentTarget;
    const fecha = (fInput && fInput.value) ? fInput.value : arDateISO();
    btnE.disabled = true; const t = btnE.textContent; btnE.textContent = "Enviando...";
    try { const ok = await ejecutarEntregaGrupo(fecha); if (ok){ gruposAbiertosEnt = new Set(); refreshItemPillsEnt(); } }
    finally { btnE.disabled = false; btnE.textContent = t; }
  });

  refreshItemPillsEnt();
}

// Filtra los botones por código o descripción (todas las palabras tipeadas deben matchear)
function filtrarItemsEnt(q){
  const toks = normalizeText(q).split(" ").filter(Boolean);
  let visibles = 0;
  psGrid.querySelectorAll(".item-cod-pill").forEach(btn => {
    const hay = toks.every(t => btn.dataset.search.includes(t));
    btn.classList.toggle("hidden", !hay);
    if (hay) visibles++;
  });
  const vacio = document.getElementById("itemsVacioEnt");
  if (vacio) vacio.classList.toggle("hidden", visibles > 0);
}

// Verde = item con algo cargado en el buffer (cajones, kg o unidades)
function tieneCargaEnt(b){
  return !!b && (Number(b.cajones) > 0 || parseDecimal(b.kg) > 0 || Number(b.unidades) > 0);
}
function refreshItemPillsEnt(){
  psGrid.querySelectorAll(".item-cod-pill").forEach(btn => {
    btn.classList.toggle("cargado", tieneCargaEnt(entregaBuf[btn.dataset.key]));
  });
}

function upsertEntregaBuf(item, cajones, kg){
  const key = `${item.sc}__${item.parte}`;
  if (!entregaBuf[key]) entregaBuf[key] = { sc:item.sc, parte:item.parte, sp:item.sp, proceso:item.proceso, cajones:0, kg:"", tandas:[] };
  if (cajones !== undefined) entregaBuf[key].cajones = cajones;
  if (kg !== undefined) entregaBuf[key].kg = kg;
  entregaBuf[key].sp = item.sp; entregaBuf[key].proceso = item.proceso;
  refreshItemPillsEnt();
}

function abrirPopupGrupoEntrega(grupo) {
  let ov = document.getElementById("popupGrupoEntOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "popupGrupoEntOverlay";
    ov.className = "popup-overlay hidden";
    ov.innerHTML = `<div class="popup-box popup-grupo">
      <div class="popup-head"><div id="popupGrupoEntTitle" class="popup-title"></div><button id="popupGrupoEntClose" type="button" class="popup-close">✕</button></div>
      <div id="popupGrupoEntBody" class="popup-body"></div>
      <div class="popup-grupo-actions"><button id="popupGrupoEntListo" class="btn-enviar" type="button">Listo</button></div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e)=>{ if(e.target===ov) ov.classList.add("hidden"); });
    ov.querySelector("#popupGrupoEntClose").addEventListener("click", ()=>ov.classList.add("hidden"));
    ov.querySelector("#popupGrupoEntListo").addEventListener("click", ()=>ov.classList.add("hidden"));
  }
  const rot = grupo.length === 1
    ? `${codMostrarEnt(grupo[0])} · ${grupo[0].parte||""}`
    : `${codMostrarEnt(grupo[0])} / ${codMostrarEnt(grupo[grupo.length-1])}`;
  ov.querySelector("#popupGrupoEntTitle").textContent = `${aliasPS(selectedPS)} — ${rot}`;
  renderGrupoPopupBodyEnt(grupo);
  ov.classList.remove("hidden");
}

function renderGrupoPopupBodyEnt(grupo){
  const ov = document.getElementById("popupGrupoEntOverlay");
  if (!ov) return;
  const abrevPS = (selectedPS||"").trim().slice(0,5);
  // PS con sin_cajones (AJ Adhesivos: uni / Charcas: kg): una sola columna de carga, sin Cajón ni Tandas
  const flags = getPSFlags(selectedPS);
  const isSinCaj = flags.sinCajones;
  const isUni = flags.cargaPorUnidades;
  if (isSinCaj) { renderGrupoPopupBodySinCajEnt(grupo, isUni, abrevPS); return; }
  const rows = grupo.map((item,i) => {
    const spKey = normalizeText(item.sp);
    const mv = stockDataCache ? stockDataCache.mvBySP.get(spKey) : null;
    const onlineSP = mv ? Math.round(mv.onlineCaj) : "…";
    const onlinePS = stockDataCache ? Math.round(stockDataCache.onlinePSCajGlobalBySP.get(spKey) || 0) : "…";
    const negSP = (mv && mv.onlineCaj < 0) ? "pg-neg" : "";
    const b = entregaBuf[`${item.sc}__${item.parte}`];
    const tandasArr = (b && Array.isArray(b.tandas)) ? b.tandas : [];
    const hayTandas = tandasArr.length > 0;
    const totCaj = tandasArr.reduce((s,t)=>s+(Number(t.caj)||0),0);
    const totKg = tandasArr.reduce((s,t)=>s+(parseDecimal(t.kg)||0),0);
    const cajVal = hayTandas ? totCaj : (b ? (b.cajones||"") : "");
    const kgVal = hayTandas ? (totKg>0?String(totKg):"") : (b ? (b.kg||"") : "");
    const ro = hayTandas ? "readonly" : "";
    const cajCls = hayTandas ? "pg-caj input-with-tandas" : "pg-caj";
    const kgCls = hayTandas ? "pg-kg input-with-tandas" : "pg-kg";
    return `<tr data-i="${i}">
      <td class="pg-desc">${escapeHtml(item.parte)}</td>
      <td>${escapeHtml(codMostrarEnt(item))}</td>
      <td><input type="text" inputmode="decimal" class="${kgCls}" value="${kgVal}" placeholder="0,0" ${ro}></td>
      <td><input type="text" inputmode="numeric" class="${cajCls}" value="${cajVal}" ${ro}></td>
      <td><button type="button" class="tanda-trigger ${hayTandas?'has-tandas':''}" data-action="tandas-grupo-ent" title="Cargar por tandas">${hayTandas?tandasArr.length:'+'}</button></td>
      <td class="pg-sep"></td>
      <td class="right ${negSP}"><b>${onlineSP}</b></td>
      <td>${escapeHtml(item.sp||"—")}</td>
      <td class="right"><b>${onlinePS}</b></td>
    </tr>`;
  }).join("");
  ov.querySelector("#popupGrupoEntBody").innerHTML = `
    <table class="pg-table">
      <thead><tr>
        <th>Desc</th><th>Cód</th><th>KG</th><th>Cajón</th><th title="Tandas">T</th><th class="pg-sep"></th>
        <th>Online<br>SP</th><th>SP</th><th>Online<br>${escapeHtml(abrevPS)}</th>
      </tr></thead><tbody>${rows}</tbody>
    </table>`;
  ov.querySelectorAll("#popupGrupoEntBody tr[data-i]").forEach(tr => {
    const item = grupo[Number(tr.dataset.i)];
    const cajIn = tr.querySelector(".pg-caj");
    const kgIn = tr.querySelector(".pg-kg");
    if (cajIn && !cajIn.readOnly) cajIn.addEventListener("input", () => { cajIn.value = cajIn.value.replace(/\D/g,""); upsertEntregaBuf(item, parseInt(cajIn.value,10)||0, undefined); });
    if (kgIn && !kgIn.readOnly) kgIn.addEventListener("input", () => { kgIn.value = kgIn.value.replace(/[^0-9,.]/g,""); upsertEntregaBuf(item, undefined, kgIn.value); });
    const tBtn = tr.querySelector('[data-action="tandas-grupo-ent"]');
    if (tBtn) tBtn.addEventListener("click", () => abrirTandasGrupoEnt(item, grupo));
  });
}

// PS con sin_cajones: una sola columna de carga (Uni para AJ Adhesivos, Kg para Charcas). Sin Cajón ni Tandas.
function renderGrupoPopupBodySinCajEnt(grupo, isUni, abrevPS){
  const ov = document.getElementById("popupGrupoEntOverlay");
  if (!ov) return;
  const label = isUni ? "Uni" : "KG";
  const rows = grupo.map((item,i) => {
    const spKey = normalizeText(item.sp);
    const mv = stockDataCache ? stockDataCache.mvBySP.get(spKey) : null;
    const onlineSP = mv ? Math.round(mv.onlineCaj) : "…";
    const onlinePS = stockDataCache ? Math.round(stockDataCache.onlinePSCajGlobalBySP.get(spKey) || 0) : "…";
    const negSP = (mv && mv.onlineCaj < 0) ? "pg-neg" : "";
    const b = entregaBuf[`${item.sc}__${item.parte}`];
    const val = b ? (isUni ? (b.unidades || "") : (b.kg || "")) : "";
    return `<tr data-i="${i}">
      <td class="pg-desc">${escapeHtml(item.parte)}</td>
      <td>${escapeHtml(codMostrarEnt(item))}</td>
      <td><input type="text" inputmode="${isUni?'numeric':'decimal'}" class="pg-directo" value="${val}" placeholder="${isUni?'0':'0,0'}"></td>
      <td class="pg-sep"></td>
      <td class="right ${negSP}"><b>${onlineSP}</b></td>
      <td>${escapeHtml(item.sp||"—")}</td>
      <td class="right"><b>${onlinePS}</b></td>
    </tr>`;
  }).join("");
  ov.querySelector("#popupGrupoEntBody").innerHTML = `
    <table class="pg-table">
      <thead><tr>
        <th>Desc</th><th>Cód</th><th>${label}</th><th class="pg-sep"></th>
        <th>Online<br>SP</th><th>SP</th><th>Online<br>${escapeHtml(abrevPS)}</th>
      </tr></thead><tbody>${rows}</tbody>
    </table>`;
  ov.querySelectorAll("#popupGrupoEntBody tr[data-i]").forEach(tr => {
    const item = grupo[Number(tr.dataset.i)];
    const inp = tr.querySelector(".pg-directo");
    if (!inp) return;
    inp.addEventListener("input", () => {
      inp.value = isUni ? inp.value.replace(/\D/g,"") : inp.value.replace(/[^0-9,.]/g,"");
      upsertEntregaBufDirecto(item, inp.value, isUni);
    });
  });
}

// Buffer para PS sin_cajones: guarda unidades (AJ) o kg (Charcas); cajones siempre 0.
function upsertEntregaBufDirecto(item, valor, isUni){
  const key = `${item.sc}__${item.parte}`;
  if (!entregaBuf[key]) entregaBuf[key] = { sc:item.sc, parte:item.parte, sp:item.sp, proceso:item.proceso, cajones:0, kg:"", unidades:0, tandas:[] };
  const b = entregaBuf[key];
  b.sp = item.sp; b.proceso = item.proceso; b.cajones = 0;
  if (isUni) { b.unidades = parseInt(valor,10) || 0; b.kg = ""; }
  else { b.kg = valor; b.unidades = 0; }
  refreshItemPillsEnt();
}

function abrirTandasGrupoEnt(item, grupo){
  const key = `${item.sc}__${item.parte}`;
  let tandasIni = (entregaBuf[key] && Array.isArray(entregaBuf[key].tandas)) ? entregaBuf[key].tandas : [];
  if (tandasIni.length === 0 && entregaBuf[key]){
    const caj = Number(entregaBuf[key].cajones)||0, kg = parseDecimal(entregaBuf[key].kg);
    if (caj>0||kg>0) tandasIni = [{caj,kg,uni:0}];
  }
  window.tandasPopup.open({
    titulo:`Tandas — ${item.parte}`,
    initial: tandasIni, pedirCaj:true, pedirKg:true, pedirUni:false,
    onConfirm:(tandas, totales) => {
      if (tandas.length===0 && totales.caj===0 && totales.kg===0){
        delete entregaBuf[key];
      } else {
        if (!entregaBuf[key]) entregaBuf[key] = { sc:item.sc, parte:item.parte, sp:item.sp, proceso:item.proceso };
        entregaBuf[key].tandas = tandas;
        entregaBuf[key].cajones = totales.caj;
        entregaBuf[key].kg = totales.kg>0?String(totales.kg):"";
      }
      renderGrupoPopupBodyEnt(grupo);
      refreshItemPillsEnt();
    }
  });
}

async function ejecutarEntregaGrupo(fecha){
  const items = Object.values(entregaBuf).filter(tieneCargaEnt);
  if (!items.length){
    alert(getPSFlags(selectedPS).cargaPorUnidades ? "Cargá al menos una unidad" : "Cargá al menos un cajón");
    return false;
  }
  const ok = await mostrarConfirmacionEntregaPS(items);
  if (!ok) return false;
  const rows = items.map(b => {
    const base = {
      "Dia-mes": fecha,
      "Prov_Serv": selectedPS,
      "Sector SC": b.sc,
      "Parte": b.parte,
      "KG": parseDecimal(b.kg) > 0 ? parseDecimal(b.kg) : null,
      "Cajones": parseInt(b.cajones) || 0,
      "Sector SP": b.sp,
      "Proceso": b.proceso,
      "Faltante": false
    };
    // AJ Adhesivos (carga_por_unidades): la cantidad va en Unidades, igual que el flujo viejo
    if (Number(b.unidades) > 0) base["Unidades"] = Number(b.unidades);
    return base;
  });
  const { error } = await sb.from("Entregas PS").insert(rows);
  if (error){ console.error(error); alert("Error al guardar: " + (error.message || "")); return false; }
  clearEntregaBuf();
  showSuccess(genNumericCode(4));
  return true;
}

async function seleccionarPS(ps) {
  selectedPS = ps;
  fetchedItems = [];
  hideSuccess();

  psGrid.querySelectorAll(".ps-pill").forEach(btn => {
    btn.classList.toggle("active", btn.textContent.trim() === ps);
  });

  setStatus("Buscando partes...", "");

  try {
    itemsBasePSEnt = await getItemsPorPS(ps);

    // 2026-07-15: TODOS los PS usan el formato "1 boton por item + buscador" (antes solo Pedernera).
    // El paso de familias y la tabla vieja (renderFamiliasEnt/renderTable) quedan sin usar en Entregas.
    setStatus(itemsBasePSEnt.length ? "" : "No hay partes para ese proveedor.", itemsBasePSEnt.length ? "" : "bad");
    renderGruposCodigoEnt();
  } catch (e) {
    console.error(e);
    setStatus("Error consultando partes.", "bad");
    setTableMsg("Error consultando partes.", "bad");
  }
}

/***********************
 * TABLE DATA
 ***********************/
function getItemsFromTable() {
  const flags = getPSFlags(selectedPS);
  return fetchedItems.map((item, i) => {
    if (flags.sinCajones) {
      // Modo directo: leer del input directo (kg o uni)
      const inputDir = resultBody.querySelector(`input[data-role^="directo-"][data-idx="${i}"]`);
      const raw = String(inputDir?.value || "").trim().replace(",", ".");
      const n = parseFloat(raw) || 0;
      return {
        ps: item.ps,
        proceso: item.proceso,
        parte: item.parte,
        sc: item.sc,
        sp: item.sp,
        cajones: "0",
        kg: flags.cargaPorUnidades ? "" : (n > 0 ? String(n) : ""),
        unidades: flags.cargaPorUnidades ? n : 0,
        _modoDirecto: true
      };
    }
    // Modo normal: si hay tandas, usar suma; sino input directo
    const t = tandasByIdx[i];
    if (Array.isArray(t) && t.length > 0){
      const sumCaj = t.reduce((s, x) => s + (Number(x.caj) || 0), 0);
      const sumKg = t.reduce((s, x) => s + (parseDecimalEPS(x.kg) || 0), 0);
      return {
        ps: item.ps,
        proceso: item.proceso,
        parte: item.parte,
        sc: item.sc,
        sp: item.sp,
        cajones: String(sumCaj),
        kg: sumKg > 0 ? String(sumKg) : "",
        unidades: 0
      };
    }
    const cajInput = resultBody.querySelector(`input[data-role="cajones"][data-idx="${i}"]`);
    const kgInput = resultBody.querySelector(`input[data-role="kg-neto"][data-idx="${i}"]`);
    const cajones = String(parseInt(cajInput?.value, 10) || 0);
    const kgNeto = parseFloat(String(kgInput?.value || "0").replace(",", ".")) || 0;
    return {
      ps: item.ps,
      proceso: item.proceso,
      parte: item.parte,
      sc: item.sc,
      sp: item.sp,
      cajones,
      kg: kgNeto > 0 ? String(kgNeto) : "",
      unidades: 0
    };
  });
}

// Abre popup tandas para una fila (solo PSs con cajones)
function abrirTandasFilaEntPS(i){
  const item = fetchedItems[i];
  if (!item) return;
  let initial = tandasByIdx[i] || [];
  // Preload tanda 1 desde valores escritos a mano si no hay tandas
  if (initial.length === 0){
    const cajInput = resultBody.querySelector(`input[data-role="cajones"][data-idx="${i}"]`);
    const kgInput = resultBody.querySelector(`input[data-role="kg-neto"][data-idx="${i}"]`);
    const caj = parseInt(cajInput?.value, 10) || 0;
    const kg = parseDecimalEPS(kgInput?.value);
    if (caj > 0 || kg > 0) initial = [{ caj, kg, uni: 0 }];
  }
  window.tandasPopup.open({
    titulo: `Tandas — ${item.parte}`,
    initial,
    pedirCaj: true,
    pedirKg: true,
    pedirUni: false,
    onConfirm: (tandas, totales) => {
      if (tandas.length === 0 && totales.caj === 0 && totales.kg === 0){
        delete tandasByIdx[i];
      } else {
        tandasByIdx[i] = tandas;
      }
      renderTable(fetchedItems);
      updateEnviarState();
    }
  });
}

// Popup confirmación EntregaPS
function mostrarConfirmacionEntregaPS(items){
  return new Promise(resolve => {
    let overlay = document.getElementById("confirmEntregaPSOverlay");
    if (!overlay){
      overlay = document.createElement("div");
      overlay.id = "confirmEntregaPSOverlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2000;padding:16px";
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:14px;width:min(700px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden">
          <div style="background:#111;color:#fff;padding:14px 18px;font-weight:800;font-size:17px">Confirmar Entrega</div>
          <div id="confirmEntregaPSBody" style="padding:14px 18px;overflow-y:auto;flex:1"></div>
          <div style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e5e7eb">
            <button id="confirmEntregaPSCancel" type="button" style="background:#fff;color:#111;border:2px solid #d0d7de;border-radius:10px;padding:10px 20px;font-weight:800;cursor:pointer;font-size:15px">Cancelar</button>
            <button id="confirmEntregaPSOk" type="button" style="background:#111;color:#fff;border:0;border-radius:10px;padding:10px 24px;font-weight:800;cursor:pointer;font-size:15px">✓ Confirmar Entrega</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    const flags = getPSFlags(selectedPS);
    const isUni = flags.cargaPorUnidades;
    const isSinCaj = flags.sinCajones;
    const labelCaj = isSinCaj ? (isUni ? "Unidades" : "—") : "Cajones Entregados";
    const labelKg = isSinCaj ? (isUni ? "—" : "Kg Neto") : "Kg Neto";
    const body = document.getElementById("confirmEntregaPSBody");
    const rows = items.map(it => {
      const caj = Number(it.cajones) || 0;
      const kg = parseDecimalEPS(it.kg);
      const uni = Number(it.unidades) || 0;
      const cajCell = isSinCaj ? (isUni ? `<b>${uni}</b>` : `—`) : `<b>${caj}</b>`;
      const kgCell = isSinCaj ? (isUni ? `—` : `<b>${kg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`) : `<b>${kg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`;
      return `<tr>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.parte)}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.sp || it.sc || "")}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${cajCell}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${kgCell}</td>
      </tr>`;
    }).join("");
    body.innerHTML = `
      <div style="font-weight:700;margin-bottom:10px;color:#555;font-size:15px;text-align:center">${items.length} artículo${items.length>1?'s':''} de <b style="color:#111">${escapeHtml(selectedPS)}</b></div>
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
    document.getElementById("confirmEntregaPSOk").onclick = () => { cleanup(); resolve(true); };
    document.getElementById("confirmEntregaPSCancel").onclick = () => { cleanup(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay){ cleanup(); resolve(false); } };
  });
}

function filterItemsToSend(items) {
  return items.filter(it => {
    if (it._modoDirecto) {
      return (parseFloat(it.kg) > 0) || (Number(it.unidades) > 0);
    }
    const n = Number(it.cajones);
    return it.cajones !== "" && Number.isInteger(n) && n > 0;
  });
}

/***********************
 * EVENTS
 ***********************/
btnVolver.addEventListener("click", () => {
  if (isSubmitting) return;
  if (typeof backActionEnt === "function") backActionEnt();
  else resetAll();
});

// Botón Limpiar: vacía todo lo cargado (inputs + tandas) del PS actual
const btnLimpiar = document.getElementById("btnLimpiar");
if (btnLimpiar){
  btnLimpiar.addEventListener("click", () => {
    if (!selectedPS){ alert("Seleccioná un proveedor primero."); return; }
    const items = getItemsFromTable();
    const filtered = filterItemsToSend(items);
    const hayTandas = Object.keys(tandasByIdx).length > 0;
    if (!filtered.length && !hayTandas){ alert("No hay nada cargado para limpiar."); return; }
    if (!confirm("¿Vaciar todo lo cargado para " + selectedPS + "? (cajones, kg, tandas)")) return;
    // Limpiar tandas
    Object.keys(tandasByIdx).forEach(k => delete tandasByIdx[k]);
    // Re-render para vaciar inputs
    renderTable(fetchedItems);
    updateEnviarState();
  });
}

okBtn.addEventListener("click", () => {
  resetAll();
});

iframe.addEventListener("load", () => {
  if (!isSubmitting) return;

  isSubmitting = false;
  btnEnviarCambios.disabled = false;

  updateEnviarState();

  setStatus("Enviado a Sheet.", "ok");
  setTableMsg("Enviado a Sheet.", "ok");

  if (lastSendCode) {
    showSuccess(lastSendCode);
  }
});

btnEnviarCambios.addEventListener("click", async () => {
  if (isSubmitting) return;

  const rawItems = getItemsFromTable();
  const items = filterItemsToSend(rawItems);

  if (!selectedPS) {
    setTableMsg("Seleccioná un proveedor.", "bad");
    return;
  }

  if (!items.length) {
    setTableMsg("Completá al menos un cajón (> 0).", "bad");
    return;
  }

  const ok = await mostrarConfirmacionEntregaPS(items);
  if (!ok) return;

  lastSendCode = genNumericCode(4);

  try {
    isSubmitting = true;
    btnEnviarCambios.disabled = true;

    setStatus("Enviando...", "");

    const rows = items.map(it => {
      const base = {
        "Dia-mes": arDateISO(),
        "Prov_Serv": selectedPS,
        "Sector SC": it.sc,
        "Parte": it.parte,
        "KG": it.kg ? parseFloat(it.kg) : null,
        "Cajones": parseInt(it.cajones) || 0,
        "Sector SP": it.sp,
        "Proceso": it.proceso,
        "Faltante": false
      };
      if (Number(it.unidades) > 0) base["Unidades"] = Number(it.unidades);
      return base;
    });

    const { error } = await sb
      .from("Entregas PS")
      .insert(rows);

    if (error) throw error;

    setStatus("Guardado correctamente", "ok");
    showSuccess(lastSendCode);

  } catch (e) {
    console.error(e);
    setStatus("Error al guardar", "bad");
  } finally {
    isSubmitting = false;
    btnEnviarCambios.disabled = false;
    updateEnviarState();
  }
});

/***********************
 * INIT
 ***********************/
async function init() {
  try {
    setStatus("Cargando proveedores...", "");
    await cargarPSFlags();
    availablePS = await getPSDisponibles();

    renderPSButtons(availablePS);
    psGridWrap.classList.remove("hidden");

    // Precarga datos de stock (Online SP / Online PS) en background
    precargarDatosStock().catch(e => console.warn("Preload stock data fallo:", e));

    if (availablePS.length) {
      setStatus("Seleccioná un proveedor para continuar.", "bad");
    } else {
      setStatus("No se encontraron proveedores.", "bad");
    }

    // Auto-seleccionar PS si viene ?ps=X en la URL
    const params = new URLSearchParams(window.location.search);
    const psParam = params.get("ps");
    if (psParam && availablePS.includes(psParam)) {
      await seleccionarPS(psParam);
    }
  } catch (e) {
    console.error(e);
    setStatus("No se pudieron cargar los proveedores.", "bad");
  }
}

showSelectionView();
init();
