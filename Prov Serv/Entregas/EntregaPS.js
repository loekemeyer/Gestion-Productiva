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
window.__sbClient__ = sb; // expuesto para cajones-popup.js

function formatNumKgEnt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

// Selecciones de cajones por idx — persistencia en memoria de esta vista
const cajonesSelByIdx = {};
const pesoCajByIdx = {};

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
async function getPSDisponibles() {
  const { data, error } = await sb
    .from(SUPABASE_TABLE)
    .select(COL_PS);

  if (error) throw error;
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

function renderTable(items) {
  resultBody.innerHTML = "";

  if (!items.length) {
    resultBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;color:#b42318;font-weight:700;">
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
    let cajCell, brutoCell, netoCell;
    if (isSinCaj) {
      // Charcas (kg) / AJ (uni): NO cajones, input directo
      const placeholder = isUni ? '0' : '0,0';
      const imode = isUni ? 'numeric' : 'decimal';
      const label = isUni ? 'uni' : 'kg';
      cajCell = `<td><span class="zero">—</span></td>`;
      brutoCell = `<td><input class="input-kg" type="text" inputmode="${imode}" placeholder="${placeholder}" data-role="directo-${label}" data-idx="${i}"/></td>`;
      netoCell = `<td><span class="zero">—</span></td>`;
    } else {
      // Resto: popup cajones + kg bruto/neto
      cajCell = `<td><button type="button" class="cajpop-trigger" data-caj-trigger data-idx="${i}">📦 Cargar</button></td>`;
      brutoCell = `<td><input class="input-kg" type="text" inputmode="decimal" placeholder="0,0" data-role="kg-bruto" data-idx="${i}"/></td>`;
      netoCell = `<td><span class="kg-neto-cell" data-role="kg-neto" data-idx="${i}">—</span></td>`;
    }
    return `
      <tr data-idx="${i}" data-cajones="0" data-peso-cajones="0">
        <td>${escapeHtml(item.parte)}</td>
        <td>${escapeHtml(item.proceso)}</td>
        <td>${escapeHtml(item.sc)}</td>
        <td>${escapeHtml(item.sp)}</td>
        ${cajCell}
        ${brutoCell}
        ${netoCell}
      </tr>
    `;
  }).join("");

  resultBody.innerHTML = rows;

  // Trigger del popup
  resultBody.querySelectorAll('[data-caj-trigger]').forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.idx);
      const item = fetchedItems[i];
      cajonesPopup.open({
        titulo: `Cajones — ${item.parte}`,
        initial: cajonesSelByIdx[i] || {},
        onConfirm: (sel, totalCaj, pesoTotal) => {
          cajonesSelByIdx[i] = sel;
          pesoCajByIdx[i] = pesoTotal;
          const row = btn.closest("tr");
          row.dataset.cajones = totalCaj;
          row.dataset.pesoCajones = pesoTotal;
          if (totalCaj > 0) {
            btn.classList.add("has-sel");
            btn.innerHTML = `${totalCaj} caj<span class="sub">${pesoTotal.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span>`;
          } else {
            btn.classList.remove("has-sel");
            btn.innerHTML = '📦 Cargar';
          }
          // Recalcular neto si ya hay bruto
          recalcKgNetoRow(i);
          updateEnviarState();
        }
      });
    });
  });

  // Kg Bruto → permite coma y decimal, recalcula neto
  resultBody.querySelectorAll('input[data-role="kg-bruto"]').forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value
        .replace(/[^0-9,]/g, "")
        .replace(/(,.*),/g, '$1');
      const i = Number(input.dataset.idx);
      recalcKgNetoRow(i);
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

function recalcKgNetoRow(i) {
  const brutoInput = resultBody.querySelector(`input[data-role="kg-bruto"][data-idx="${i}"]`);
  const netoSpan = resultBody.querySelector(`[data-role="kg-neto"][data-idx="${i}"]`);
  if (!brutoInput || !netoSpan) return;
  const bruto = parseFloat(String(brutoInput.value || "0").replace(",", ".")) || 0;
  const pesoCaj = Number(pesoCajByIdx[i] || 0);
  const neto = Math.max(0, bruto - pesoCaj);
  netoSpan.textContent = neto ? formatNumKgEnt(neto) : '—';
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
    const row = resultBody.querySelector(`tr[data-idx="${i}"]`);
    const cajones = String(row?.dataset.cajones || "0").trim();
    const pesoCaj = Number(row?.dataset.pesoCajones || 0);
    const brutoInput = resultBody.querySelector(`input[data-role="kg-bruto"][data-idx="${i}"]`);
    const bruto = parseFloat(String(brutoInput?.value || "0").replace(",", ".")) || 0;
    const kgNeto = Math.max(0, bruto - pesoCaj);
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

  const ok = confirm("¿Confirmar envío?");
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
  } catch (e) {
    console.error(e);
    setStatus("No se pudieron cargar los proveedores.", "bad");
  }
}

showSelectionView();
init();
