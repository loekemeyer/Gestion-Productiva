"use strict";

/****************************************************************
 * Control Envíos y Entregas — vista pivote partes × fechas
 * Origen: Prov. Servicios | Talleristas
 * Tipo:   Envíos | Entregas
 * Fecha:  mes específico (columnas = día) | rango (columnas = DD/MM)
 * Celda:  KG. Excepción: Tall + Entregas = Unidades.
 ****************************************************************/

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== Estado de selección =====
let selOrigen = "";   // 'ps' | 'tall' | 'insumos'
let selTipo = "";     // 'envios' | 'entregas'
let selMedida = "default"; // 'default' (Kg/Unidades) | 'cajas'
let selRubro = "";    // solo cuando selOrigen='insumos': Flejes/Cajas/Plasticos/Cartones/Remaches/Bombillas
let nombresToken = 0; // evita carreras al recargar lista de nombres

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

// ===== Helpers =====
function setStatus(t){ statusEl.textContent = t || ""; }

function escapeHtml(s){
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeText(v){
  return String(v || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
}

function parseDecimal(value){
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let s = String(value).trim();
  if (!s || s === "-" || s === "—") return 0;
  s = s.replace(/[^\d,.-]/g, "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys){
  for (const k of keys){
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
}

function formatKg(n){
  return Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}
function formatUni(n){
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

// Parser de fecha flexible. Devuelve {y,m,d} (y puede ser null si no viene año).
// Acepta ISO "YYYY-MM-DD", "DD/MM/YYYY" y "DD/MM".
function parseFecha(value){
  const s = String(value || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return { y: null, m: +m[2], d: +m[1] };
  return null;
}

const pad2 = n => String(n).padStart(2, "0");

// Carga paginada de una tabla completa.
async function cargarTabla(tabla, cols = "*"){
  const out = [];
  const PAGE = 1000;
  let from = 0;
  while (true){
    const { data, error } = await sb.from(tabla).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ===== Configuración por (origen, tipo) =====
// Devuelve cómo extraer parte / sector / fecha / valor de cada fila.
function getConfig(origen, tipo){
  if (origen === "ps" && tipo === "envios"){
    return {
      tabla: "Envios a PS", unidad: "KG",
      parteKeys: ["Parte", "Descripcion", "descripcion", "Descripción"],
      sectorKeys: ["Sector SP", "Sector", "Sector SC", "sector"],
      fechaKeys: ["Dia-mes", "dia-mes", "Fecha", "fecha"],
      valorKeys: ["KG", "Kg", "kg"],
      cajasKeys: ["Cajones", "cajones", "Cajas", "cajas"],
      nombreKeys: ["Prov_Serv", "prov_serv", "Prov Serv"]
    };
  }
  if (origen === "ps" && tipo === "entregas"){
    return {
      tabla: "Entregas PS", unidad: "KG",
      parteKeys: ["Parte", "Descripcion", "descripcion", "Descripción"],
      sectorKeys: ["Sector SP", "Sector SC", "Sector", "sector"],
      fechaKeys: ["Dia-mes", "dia-mes", "Fecha", "fecha"],
      valorKeys: ["KG", "Kg", "kg"],
      cajasKeys: ["Cajones", "cajones", "Cajas", "cajas"],
      nombreKeys: ["Prov_Serv", "prov_serv", "Prov Serv"]
    };
  }
  if (origen === "tall" && tipo === "envios"){
    return {
      tabla: "Envios a Talleristas", unidad: "KG",
      parteKeys: ["Descripcion", "descripcion", "Descripción", "DESCRIPCION"],
      sectorKeys: ["Sector", "sector", "SECTOR"],
      fechaKeys: ["Dia-mes", "dia-mes", "Fecha", "fecha"],
      valorKeys: ["KG", "Kg", "kg"],
      cajasKeys: ["Cajones", "cajones", "Cajas", "cajas"],
      nombreKeys: ["Tallerista", "tallerista", "TALLERISTA"]
    };
  }
  // Prov. Insumos → recepciones de insumos (cualquier tipo)
  if (origen === "insumos"){
    return {
      tabla: "Recepcion_Insumos", unidad: "Uni",
      parteKeys: ["descripcion", "Descripcion", "Descripción"],
      sectorKeys: ["codigo", "Codigo", "Código"],
      fechaKeys: ["fecha", "Fecha"],
      valorKeys: ["cantidad", "Cantidad"],
      cajasKeys: ["cantidad", "Cantidad"],
      nombreKeys: ["proveedor", "Proveedor"]
    };
  }
  // tall + entregas → caso especial (mapeo por Cod, valor en unidades)
  return {
    tabla: "Entregas_Tall_Todas", unidad: "Uni",
    especialTall: true,
    fechaKeys: ["Fecha", "fecha", "Dia-mes"],
    valorKeys: ["Unidades", "unidades", "Uni"],
    nombreKeys: ["Nombre_Tall", "nombre_tall", "NOMBRE_TALL"]
  };
}

// Mapa Cod → {desc, sector, uniXcaja} para Tall + Entregas (desde Partes x Tallerista).
async function cargarMapaPartesTall(){
  const rows = await cargarTabla("Partes x Tallerista",
    '"tallerista","cod_art","descripcion_parte","sector_proce","uni_x_cja"');
  const porTallCod = new Map(); // tallNorm__cod → {desc,sector,uniXcaja}
  const porCod = new Map();     // cod → {desc,sector,uniXcaja} (fallback)
  rows.forEach(r => {
    const tall = normalizeText(pick(r, ["tallerista", "Tallerista"]));
    const cod = String(pick(r, ["cod_art", "Cod_Art"]) || "").trim();
    if (!cod) return;
    const info = {
      desc: String(pick(r, ["descripcion_parte", "Descripcion_parte"]) || "").trim(),
      sector: String(pick(r, ["sector_proce", "Sector_Proce"]) || "").trim(),
      uniXcaja: parseDecimal(pick(r, ["uni_x_cja", "Uni_x_cja"]))
    };
    if (tall) {
      const k = `${tall}__${cod}`;
      if (!porTallCod.has(k)) porTallCod.set(k, info);
    }
    if (!porCod.has(cod)) porCod.set(cod, info);
  });
  return { porTallCod, porCod };
}

// Carga la lista de Prov. Servicios o Talleristas según origen y puebla el <select>.
async function cargarNombres(origen){
  const token = ++nombresToken;
  const sel = document.getElementById("selNombre");
  const step = document.getElementById("stepNombre");
  const label = document.getElementById("labelNombre");
  label.textContent = origen === "ps" ? "Proveedor de Servicios"
                    : origen === "insumos" ? "Proveedor de Insumos"
                    : "Tallerista";
  step.classList.remove("hidden");
  sel.innerHTML = `<option value="__todos__">Cargando...</option>`;

  let nombres = [];
  try {
    if (origen === "ps"){
      const [a, b] = await Promise.all([
        cargarTabla("Envios a PS", '"Prov_Serv"'),
        cargarTabla("Entregas PS", '"Prov_Serv"')
      ]);
      nombres = [...a, ...b].map(r => String(r.Prov_Serv || "").trim());
    } else if (origen === "insumos"){
      // Lista fija de proveedores por rubro (espejo de StockFlejes/recepcion.html)
      // No filtra por Recepcion_Insumos para mostrar TODOS los proveedores posibles
      // del rubro, no solo los que ya tienen recepciones registradas.
      nombres = selRubro ? (PROVEEDORES_INSUMOS[selRubro] || []) : [];
    } else {
      const [a, b] = await Promise.all([
        cargarTabla("Envios a Talleristas", '"Tallerista"'),
        cargarTabla("Entregas_Tall_Todas", '"Nombre_Tall"')
      ]);
      nombres = [
        ...a.map(r => String(r.Tallerista || "").trim()),
        ...b.map(r => String(r.Nombre_Tall || "").trim())
      ];
    }
  } catch(e){
    console.error(e);
    if (token === nombresToken) sel.innerHTML = `<option value="__todos__">Todos</option>`;
    return;
  }
  if (token !== nombresToken) return; // el origen cambió mientras cargaba

  // únicos por texto normalizado, preservando la primera aparición (casing original)
  const vistos = new Map();
  nombres.filter(Boolean).forEach(n => {
    const k = normalizeText(n);
    if (!vistos.has(k)) vistos.set(k, n);
  });
  const ordenados = [...vistos.values()].sort((a, b) => a.localeCompare(b, "es"));
  sel.innerHTML = `<option value="__todos__">Todos</option>` +
    ordenados.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
}

// ===== Lectura de filtro de fecha desde la UI =====
function leerFiltroFecha(){
  const modo = document.querySelector('input[name="modoFecha"]:checked').value;
  if (modo === "mes"){
    const v = document.getElementById("inMes").value; // "YYYY-MM"
    if (!v) return { error: "Elegí un mes." };
    const [y, m] = v.split("-").map(Number);
    return { modo, y, m };
  }
  const d = document.getElementById("inDesde").value; // "YYYY-MM-DD"
  const h = document.getElementById("inHasta").value;
  if (!d || !h) return { error: "Completá Desde y Hasta." };
  const pd = parseFecha(d), ph = parseFecha(h);
  if (!pd || !ph) return { error: "Fechas inválidas." };
  let desde = pd, hasta = ph;
  if (claveFecha(pd) > claveFecha(ph)) { desde = ph; hasta = pd; }
  return { modo, desde, hasta };
}

function claveFecha(p){
  return (p.y || 0) * 10000 + p.m * 100 + p.d;
}

// ¿La fila (parseada) entra en el filtro? Devuelve { ok, colKey, colLabel, orden }.
function evaluarFecha(p, filtro){
  if (!p) return { ok: false };
  if (filtro.modo === "mes"){
    if (p.m !== filtro.m) return { ok: false };
    if (p.y && p.y !== filtro.y) return { ok: false };
    return { ok: true, colKey: pad2(p.d), colLabel: pad2(p.d), orden: p.d };
  }
  // rango: si la fila no trae año, asumir el año del "desde"
  const y = p.y || filtro.desde.y || new Date().getFullYear();
  const k = y * 10000 + p.m * 100 + p.d;
  if (k < claveFecha(filtro.desde) || k > claveFecha(filtro.hasta)) return { ok: false };
  return { ok: true, colKey: `${y}-${pad2(p.m)}-${pad2(p.d)}`, colLabel: `${pad2(p.d)}/${pad2(p.m)}`, orden: k };
}

// ===== Generar reporte =====
async function generar(){
  if (!selOrigen || !selTipo){ setStatus("Elegí Origen y Tipo."); return; }
  const filtro = leerFiltroFecha();
  if (filtro.error){ setStatus(filtro.error); return; }

  const cfg = getConfig(selOrigen, selTipo);
  const usarCajas = (selMedida === "cajas");
  if (usarCajas) cfg.unidad = "Cajas";
  const selNombreVal = document.getElementById("selNombre").value;
  const filtroNombre = (selNombreVal && selNombreVal !== "__todos__") ? normalizeText(selNombreVal) : null;
  resultEl.innerHTML = "";
  setStatus("Cargando datos...");

  let filas;
  try {
    filas = await cargarTabla(cfg.tabla, "*");
  } catch(e){
    console.error(e); setStatus("Error: " + e.message); return;
  }

  let mapaTall = null;
  if (cfg.especialTall){
    try { mapaTall = await cargarMapaPartesTall(); }
    catch(e){ console.error(e); setStatus("Error mapeando partes: " + e.message); return; }
  }

  // Pivote: partKey → { sector, descripcion, cells: Map<colKey, valor>, total }
  const partes = new Map();
  const columnas = new Map(); // colKey → { label, orden }

  filas.forEach(r => {
    if (filtroNombre){
      const nombreFila = normalizeText(pick(r, cfg.nombreKeys));
      if (nombreFila !== filtroNombre) return;
    }
    // Insumos: filtrar por rubro si esta seleccionado
    if (selOrigen === "insumos" && selRubro){
      const rubroFila = String(pick(r, ["rubro", "Rubro"]) || "").trim();
      if (rubroFila !== selRubro) return;
    }

    const fechaRaw = pick(r, cfg.fechaKeys);
    const ev = evaluarFecha(parseFecha(fechaRaw), filtro);
    if (!ev.ok) return;

    let descripcion, sector, valor;

    if (cfg.especialTall){
      const tall = normalizeText(pick(r, ["Nombre_Tall", "nombre_tall"]));
      const cod = String(pick(r, ["Cod", "cod", "Cod_Art"]) || "").trim();
      const info = mapaTall.porTallCod.get(`${tall}__${cod}`) || mapaTall.porCod.get(cod) || null;
      descripcion = (info && info.desc) || (cod ? `Cod ${cod}` : "(sin código)");
      sector = (info && info.sector) || "";
      if (usarCajas){
        valor = parseDecimal(pick(r, ["Cajas", "cajas", "Cajones", "cajones"]));
      } else {
        let uni = parseDecimal(pick(r, cfg.valorKeys));
        if (uni === 0){
          const cajas = parseDecimal(pick(r, ["Cajas", "cajas"]));
          const uxc = info ? info.uniXcaja : 0;
          if (cajas > 0 && uxc > 0) uni = cajas * uxc;
        }
        valor = uni;
      }
    } else {
      descripcion = String(pick(r, cfg.parteKeys) || "").trim();
      sector = String(pick(r, cfg.sectorKeys) || "").trim();
      valor = parseDecimal(pick(r, usarCajas ? cfg.cajasKeys : cfg.valorKeys));
    }

    if (!valor) return;
    if (!descripcion && !sector) return;

    if (!columnas.has(ev.colKey)) columnas.set(ev.colKey, { label: ev.colLabel, orden: ev.orden });

    const partKey = `${sector}|||${normalizeText(descripcion)}`;
    if (!partes.has(partKey)) partes.set(partKey, { sector, descripcion, cells: new Map(), total: 0 });
    const p = partes.get(partKey);
    p.cells.set(ev.colKey, (p.cells.get(ev.colKey) || 0) + valor);
    p.total += valor;
  });

  renderPivote(cfg, filtro, partes, columnas);
}

function renderPivote(cfg, filtro, partes, columnas){
  if (!partes.size){
    setStatus("Sin datos para esos filtros.");
    resultEl.innerHTML = "";
    return;
  }

  const cols = [...columnas.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => a.orden - b.orden);

  const filas = [...partes.values()]
    .sort((a, b) => {
      const s = String(a.sector).localeCompare(String(b.sector), "es", { numeric: true });
      return s !== 0 ? s : String(a.descripcion).localeCompare(String(b.descripcion), "es");
    });

  const fmt = (cfg.unidad === "Uni" || cfg.unidad === "Cajas") ? formatUni : formatKg;

  const selNombreVal = document.getElementById("selNombre").value;
  const nombreLabel = (selNombreVal && selNombreVal !== "__todos__") ? selNombreVal : "Todos";
  const origenLabel = selOrigen === "ps" ? "Prov. Servicios"
                    : selOrigen === "insumos" ? "Prov. Insumos"
                    : "Talleristas";
  const tipoLabel = selTipo === "envios" ? "Envíos" : "Entregas";
  const fechaLabel = filtro.modo === "mes"
    ? `Mes ${pad2(filtro.m)}/${filtro.y}`
    : `${pad2(filtro.desde.d)}/${pad2(filtro.desde.m)}/${filtro.desde.y} → ${pad2(filtro.hasta.d)}/${pad2(filtro.hasta.m)}/${filtro.hasta.y}`;
  const headCols = cols.map(c => `<th class="col-fecha">${escapeHtml(c.label)}</th>`).join("");

  const bodyRows = filas.map(p => {
    const cells = cols.map(c => {
      const v = p.cells.get(c.key);
      return `<td class="num">${v ? escapeHtml(fmt(v)) : ""}</td>`;
    }).join("");
    // data-desc + data-sector en lowercase para filtrar sin sensible a mayúsculas
    return `<tr data-desc="${escapeHtml(String(p.descripcion).toLowerCase())}" data-sector="${escapeHtml(String(p.sector).toLowerCase())}">
        <td class="desc" title="${escapeHtml(p.descripcion)}">${escapeHtml(p.descripcion)}</td>
        <td class="sector">${p.sector ? escapeHtml(p.sector) : '<span class="zero">-</span>'}</td>
        ${cells}
        <td class="num total">${escapeHtml(fmt(p.total))}</td>
      </tr>`;
  }).join("");

  setStatus(`${filas.length} partes · ${cols.length} fechas · unidad: ${cfg.unidad}`);

  resultEl.innerHTML = `
    <div class="report-tools no-print">
      <input type="text" id="filtroDesc" class="filtro-input" placeholder="Filtrar por descripción..." autocomplete="off">
      <input type="text" id="filtroSector" class="filtro-input" placeholder="Filtrar por sector..." autocomplete="off">
      <span id="filtroCount" class="filtro-count"></span>
      <button type="button" id="btnImprimir" class="btn-imprimir">🖨 Imprimir</button>
    </div>
    <div id="printArea">
      <div class="report-head">
        ${origenLabel} — ${tipoLabel} · ${escapeHtml(nombreLabel)} · ${escapeHtml(fechaLabel)} · valores en <b>${cfg.unidad}</b>
      </div>
      <div class="table-scroll">
        <table class="pivote">
          <thead>
            <tr>
              <th class="desc">Descripción</th>
              <th class="sector">Sector</th>
              ${headCols}
              <th class="col-total">Total</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;

  const tituloImpresion = `${origenLabel} — ${tipoLabel} · ${nombreLabel} · ${fechaLabel} · ${cfg.unidad}`;
  const btn = document.getElementById("btnImprimir");
  if (btn) btn.addEventListener("click", () => imprimir(tituloImpresion));

  // Filtros desc + sector — esconden filas que no matcheen
  const fDesc = document.getElementById("filtroDesc");
  const fSec  = document.getElementById("filtroSector");
  const cnt   = document.getElementById("filtroCount");
  const totalFilas = filas.length;
  function aplicarFiltro(){
    const qD = String(fDesc.value || "").trim().toLowerCase();
    const qS = String(fSec.value || "").trim().toLowerCase();
    const trs = resultEl.querySelectorAll("tbody tr");
    let visibles = 0;
    trs.forEach(tr => {
      const d = tr.dataset.desc || "";
      const s = tr.dataset.sector || "";
      const ok = (!qD || d.includes(qD)) && (!qS || s.includes(qS));
      tr.style.display = ok ? "" : "none";
      if (ok) visibles++;
    });
    cnt.textContent = (qD || qS) ? `${visibles} / ${totalFilas} partes` : "";
  }
  fDesc.addEventListener("input", aplicarFiltro);
  fSec.addEventListener("input", aplicarFiltro);
}

// Imprime el #printArea en ventana aparte.
function imprimir(titulo){
  const cont = document.getElementById("printArea");
  if (!cont) return;
  const win = window.open("", "_blank", "width=1100,height=750");
  if (!win){ alert("El navegador bloqueó la ventana de impresión. Permití pop-ups."); return; }
  win.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>${escapeHtml(titulo)}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:Arial,sans-serif;padding:16px;color:#111}
      .report-head{font-weight:700;font-size:14px;margin-bottom:10px}
      /* width:auto + table-layout:auto → columnas se ajustan al contenido (sin espacio extra distribuido) */
      table{width:auto;border-collapse:collapse;table-layout:auto;border:2.5px solid #111}
      th,td{border:1px solid #111;padding:4px 6px;font-size:13px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
      /* Headers con borde grueso en todos sus lados (border-collapse hace que el más grueso gane) */
      thead th{font-size:14px;font-weight:800;border:2.5px solid #111}
      /* td.desc, th.desc — sin override de alineación: heredan text-align:center del base */
      td.total,.total{font-weight:800}
      tfoot td{font-weight:800;background:#f3f3f3}
      tr{page-break-inside:avoid}
      thead{display:table-header-group}
      @page{margin:12mm;size:landscape}
    </style></head><body>${cont.innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  win.onload = () => win.print();
  setTimeout(() => { try { win.print(); } catch(e){} }, 300);
}

// ===== Wiring UI =====
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

// Rubros + Proveedores (espejo de StockFlejes/recepcion.html — mantener sincronizado)
const RUBROS_INSUMOS = ["Flejes","Cajas","Plasticos","Cartones","Remaches","Bombillas"];
const PROVEEDORES_INSUMOS = {
  Flejes:    ["Basconia","Aperam","Hermac","Brawin","Altrak","Szapiro","EstaMetal","JL Metales","Alami"],
  Cajas:     ["Corrugadora"],
  Plasticos: ["Pat Bet Plast","Rodar","Telleria","Maspoli","Pintos","Martin Faccolo","JL Matriceria","Capuchon Mariposa","Base Afila","M. Pelador","Terrero","Mangos Abrelata","Regatones","Bujes Abrelatas","Mango Ergon.","Mangos NM","Packaging y Serv","Sesega","Barbeja"],
  Cartones:  ["Grafica Pol"],
  Remaches:  ["Bella Vista","Dilmax","Electronica Mandelli","Imel"],
  Bombillas: ["Por definir"]
};

function renderRubros(){
  const grp = document.getElementById("grpRubro");
  grp.innerHTML = RUBROS_INSUMOS.map(r =>
    `<button type="button" class="opt" data-val="${escapeHtml(r)}">${escapeHtml(r === "Plasticos" ? "Plásticos" : r)}</button>`
  ).join("");
  grp.querySelectorAll(".opt").forEach(b => {
    b.addEventListener("click", () => {
      grp.querySelectorAll(".opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      selRubro = b.dataset.val;
      cargarNombres("insumos");
    });
  });
}
renderRubros();

wireGrupo("grpOrigen", v => {
  selOrigen = v;
  const stepRubro = document.getElementById("stepRubro");
  const stepNombre = document.getElementById("stepNombre");
  // Insumos solo tiene recepciones → forzar tipo=entregas + Envios disabled
  const grpTipo = document.getElementById("grpTipo");
  const optEnvios = grpTipo.querySelector('.opt[data-val="envios"]');
  const optEntregas = grpTipo.querySelector('.opt[data-val="entregas"]');
  if (v === "insumos"){
    selTipo = "entregas";
    optEnvios.classList.add("opt-disabled");
    optEnvios.classList.remove("active");
    optEnvios.disabled = true;
    optEntregas.classList.add("active");
    optEntregas.disabled = false;
    optEntregas.classList.remove("opt-disabled");
    // Mostrar selector rubro, ocultar nombre hasta elegir rubro
    stepRubro.classList.remove("hidden");
    stepNombre.classList.add("hidden");
    // Reset rubro al cambiar a insumos
    selRubro = "";
    document.querySelectorAll("#grpRubro .opt").forEach(x => x.classList.remove("active"));
  } else {
    optEnvios.classList.remove("opt-disabled");
    optEnvios.disabled = false;
    optEntregas.classList.remove("opt-disabled");
    optEntregas.disabled = false;
    stepRubro.classList.add("hidden");
    selRubro = "";
    cargarNombres(v);
  }
});
wireGrupo("grpTipo", v => { selTipo = v; });
wireGrupo("grpMedida", v => { selMedida = v; });

document.querySelectorAll('input[name="modoFecha"]').forEach(r => {
  r.addEventListener("change", () => {
    const modo = document.querySelector('input[name="modoFecha"]:checked').value;
    document.getElementById("boxMes").classList.toggle("hidden", modo !== "mes");
    document.getElementById("boxRango").classList.toggle("hidden", modo !== "rango");
  });
});

document.getElementById("btnGenerar").addEventListener("click", generar);

// Default mes = actual
(function initMes(){
  const hoy = new Date();
  document.getElementById("inMes").value = `${hoy.getFullYear()}-${pad2(hoy.getMonth() + 1)}`;
})();
