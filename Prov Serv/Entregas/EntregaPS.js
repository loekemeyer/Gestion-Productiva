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

async function getPSDisponibles() {
  const [{ data, error }, { data: flagsData }] = await Promise.all([
    sb.from(SUPABASE_TABLE).select(COL_PS),
    sb.from("Tall_ProvAT_PS").select("nombre, especializacion")
  ]);
  if (error) throw error;
  procesoPorPSMapEnt = new Map();
  (flagsData || []).forEach(r => {
    const ps = String(r.nombre || "").trim();
    if (!ps) return;
    procesoPorPSMapEnt.set(ps, (r.especializacion && String(r.especializacion).trim()) || "Sin asignar");
  });
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
    uniques.push({
      ps: psVal,
      proceso,
      parte,
      sc,
      sp
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
  procesoSelEnt = null;
  renderProcesosEnt();
}

function renderProcesosEnt() {
  psGrid.innerHTML = "";
  const procs = [...psPorProcesoMapEnt.keys()].sort((a,b) => {
    if (a === "Sin asignar") return 1;
    if (b === "Sin asignar") return -1;
    return a.localeCompare(b, "es");
  });
  procs.forEach(proc => {
    const cnt = psPorProcesoMapEnt.get(proc).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-pill proceso-pill";
    btn.innerHTML = `${escapeHtml(proc)}<br><span style="font-size:11px;opacity:.75">${cnt} prov.</span>`;
    btn.addEventListener("click", () => {
      procesoSelEnt = proc;
      renderPSDelProcesoEnt(proc);
    });
    psGrid.appendChild(btn);
  });
}

function renderPSDelProcesoEnt(proc) {
  psGrid.innerHTML = "";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;margin-bottom:10px";
  bar.innerHTML = `<button type="button" class="ps-pill" style="background:#fff;color:#111;border:2px solid #d0d7de" id="psBackToProcEnt">← Procesos</button>
    <div style="font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px">${escapeHtml(proc)}</div>`;
  psGrid.appendChild(bar);
  document.getElementById("psBackToProcEnt").addEventListener("click", () => renderProcesosEnt());
  const list = psPorProcesoMapEnt.get(proc) || [];
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

function showSelectionView() {
  psGridWrap.classList.remove("hidden");
  detailWrap.classList.add("hidden");
  selectedBar.classList.add("hidden");
  btnEnviarCambios.classList.add("hidden");
}

function showDetailView() {
  psGridWrap.classList.add("hidden");
  detailWrap.classList.remove("hidden");
  selectedBar.classList.remove("hidden");
  btnEnviarCambios.classList.remove("hidden");
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

  psGrid.querySelectorAll(".ps-pill").forEach(btn => {
    btn.classList.remove("active");
  });
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
    fetchedItems = await getItemsPorPS(ps);

    selectedBadge.textContent = ps;
    tableTitle.textContent = ps;

    renderTable(fetchedItems);
    showDetailView();

    if (fetchedItems.length) {
      setStatus("Proveedor cargado correctamente.", "ok");
      setTableMsg("Completá solo cajones enteros mayores a 0.");
    } else {
      setStatus("No hay partes para ese proveedor.", "bad");
      setTableMsg("No hay partes para ese proveedor.", "bad");
    }

    updateEnviarState();
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
  resetAll();
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
