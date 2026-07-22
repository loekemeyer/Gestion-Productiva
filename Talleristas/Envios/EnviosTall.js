/*************************************************
 * CONFIGURACIÓN SUPABASE
 *************************************************/
const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
window.__sbClient__ = supabaseClient; // expuesto para cajones-popup.js

function formatNumKgEt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/*************************************************
 * ELEMENTOS DEL DOM
 *************************************************/
const talleristasGrid = document.getElementById("talleristasGrid");
const resultEl = document.getElementById("result");
const btnVolver = document.getElementById("btnVolver");
const txtFiltroArticulo = document.getElementById("txtFiltroArticulo");
const filtroArticuloWrap = document.getElementById("filtroArticuloWrap");
const TABLA_DESTINO = "Envios a Talleristas";
const filasModificadas = new Map();
const BUFFER_KEY = "enviosTall_pendientes";

/* Fases */
const fase1 = document.getElementById("fase1");
// fase2 eliminado del HTML — dummy para no romper mostrarFase()
const fase2 = { classList: { toggle: () => {}, add: () => {}, remove: () => {} } };
const fase3 = document.getElementById("fase3");
// btnSiguiente y btnVolverFase1 eliminados — Fase 1 y 2 unificadas
// Mantenemos const dummy para no romper referencias en código legacy
const btnSiguiente = document.getElementById("btnEnviar"); // alias al Enviar unificado
const btnVolverFase1 = { addEventListener: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } };
const btnEnviar = document.getElementById("btnEnviar");
const btnImprimir = document.getElementById("btnImprimir");
// fase2TableBody eliminado — Fase 1 y 2 unificadas. Dummy para no romper legacy.
const fase2TableBody = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
const fase3TableBody = document.getElementById("fase3TableBody");

let currentPhase = 1; // 1, 2 o 3
let ultimoEnvioPhase2 = []; // Items de Fase 2 (con Caj y Kg)

/* Toast Deshacer */
const toastDeshacer = document.getElementById("toastDeshacer");
const btnDeshacerEnvio = document.getElementById("btnDeshacerEnvio");
const btnCerrarToast = document.getElementById("btnCerrarToast");
const toastProgress = document.getElementById("toastProgress");
let ultimoEnvioIds = []; // IDs del último envio para poder deshacer
let ultimoEnvioPayload = []; // Payload del último envio para revertir stocks

function getBuffer(){
  try { return JSON.parse(localStorage.getItem(BUFFER_KEY) || "[]"); }
  catch { return []; }
}

function saveBuffer(arr){
  localStorage.setItem(BUFFER_KEY, JSON.stringify(arr));
  actualizarBtnSiguiente();
}

function addToBuffer(item){
  const buf = getBuffer();
  const key = `${item.tallerista}__${item.sector}__${item.descripcion}`;
  const idx = buf.findIndex(b => `${b.tallerista}__${b.sector}__${b.descripcion}` === key);
  if (idx >= 0) buf[idx] = item;
  else buf.push(item);
  saveBuffer(buf);
}

function removeFromBuffer(index){
  const buf = getBuffer();
  buf.splice(index, 1);
  saveBuffer(buf);
}

function clearBuffer(){
  localStorage.removeItem(BUFFER_KEY);
  actualizarBtnSiguiente();
}

function actualizarBtnSiguiente(){
  const buf = getBuffer();
  const tieneItems = buf.some(b =>
    b.tallerista === talleristaActivo &&
    (Number(b.cajones) > 0 || Number(b.unidades) > 0)
  );
  btnSiguiente.disabled = !tieneItems;
  btnSiguiente.classList.toggle("disabled", !tieneItems);
  btnSiguiente.classList.remove("hidden");
}
/*************************************************
 * CACHES EN MEMORIA
 *************************************************/
let consumosCache = null;
let sectoresCache = null;
let articulosCajasCache = null;
let cajasCache = null;

let talleristaActivo = "";
let listaTalleristas = [];
let filasFiltradas = [];

// Sectores crudos (SC) que recibe Martin — clasifican como "Sector Crudo".
// Se carga al inicio desde SC Kg.crudo_martin = TRUE. Fallback hardcoded preservado.
let SECTORES_CRUDO_MARTIN = new Set(["KF2", "LF16", "KF8"]);

async function cargarSectoresCrudoMartin(){
  try {
    const { data, error } = await supabaseClient.from("SC Kg").select("SC").eq("crudo_martin", true);
    if (error) { console.warn("[EnviosTall] No se pudo cargar SECTORES_CRUDO_MARTIN, uso fallback:", error.message); return; }
    if (data && data.length) SECTORES_CRUDO_MARTIN = new Set(data.map(r => String(r.SC).trim()));
  } catch (e) { console.warn("[EnviosTall] cargarSectoresCrudoMartin fallo, uso fallback:", e); }
}

// Orden de grupos en la tabla, espejo de ControlTall.
const GRUPOS_ORDEN = ["Sector Procesado", "Sector Crudo", "Partes Plásticas", "Garaje", "Remaches", "Cartones", "Cajas", "Importados"];

// Clasifica un item en uno de los grupos. Mismo criterio que ControlTall.clasificarParte:
// usa rubro de Despiece (rubroBySector / rubroByPart en sectoresCache) como fuente de verdad
// para Remaches y Plásticos, con fallbacks por patron de sector / descripción.
function clasificarItem(item){
  const desc = String(item.descripcion || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const sec = String(item.sector || "").trim().toUpperCase();

  if (desc.startsWith("caja n") || sec === "CAJA") return "Cajas";
  if (desc.startsWith("carton") || desc.startsWith("cartón")) return "Cartones";

  // Rubro primario (fuente: Despiece x Articulo)
  const rubroBySector = sectoresCache && sectoresCache.rubroBySector;
  const rubroByPart   = sectoresCache && sectoresCache.rubroByPart;
  const rubro = (rubroBySector && rubroBySector.get(item.sector)) || (rubroByPart && rubroByPart.get(desc)) || "";
  if (rubro === "Importados") return "Importados";
  if (rubro === "Remaches") return "Remaches";
  if (rubro === "Plásticos" || rubro === "Plasticos") return "Partes Plásticas";

  if (sec.startsWith("GRJ") || sec.startsWith("CP")) return "Garaje";
  if (sec.startsWith("P")) return "Partes Plásticas";
  // Fallback remaches: V seguido de digito (V1, V3C, V14, etc.) y otros sectores conocidos
  if (/^V\d+[A-Z]?$/.test(sec)) return "Remaches";
  if (["W4","W6","W8","S/S","SR","BOM7","BOM8"].includes(sec)) return "Remaches";
  if (SECTORES_CRUDO_MARTIN.has(sec)) return "Sector Crudo";
  if (/p\/\s*cromar/i.test(desc)) return "Sector Crudo";
  return "Sector Procesado";
}

/*************************************************
 * HELPERS VISUALES
 *************************************************/


function escapeHtml(s){
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDecimal(n){
  return Number(n || 0).toLocaleString("es-AR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function parseInputNumber(value){
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace(",", ".");
  const n = Number(normalized);

  return Number.isFinite(n) ? n : null;
}

/*************************************************
 * HELPERS DE DATOS
 *************************************************/
function pick(obj, keys){
  for (const k of keys){
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)){
      return obj[k];
    }
  }
  return undefined;
}

function normalizeText(value){
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeCode(value){
  if (value === null || value === undefined) return "";

  let raw = String(value).trim();
  if (!raw) return "";
  // Códigos alfanuméricos (A10, C1, PC2A, etc.): devolver tal cual
  if (/[a-zA-Z]/.test(raw)) return raw;

  raw = raw.replace(",", ".");

  const num = Number(raw);
  if (Number.isFinite(num)){
    return String(Math.trunc(num)).padStart(3, "0");
  }

  raw = raw.replace(/\s+/g, "");
  raw = raw.replace(/[.,]0+$/, "");

  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  return digits.padStart(3, "0");
}

function splitCodes(value){
  return String(value || "")
    .split(",")
    .map(x => normalizeCode(x))
    .filter(Boolean);
}

function parseConsumo(value){
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number"){
    return Number.isFinite(value) ? value : 0;
  }

  let s = String(value).trim();
  if (!s || s === "-" || s === "—") return 0;

  s = s.replace(/[^\d,.-]/g, "");

  if (s.includes(",")){
    s = s.replace(/,/g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDecimal(value){
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number"){
    return Number.isFinite(value) ? value : 0;
  }

  let s = String(value).trim();
  if (!s || s === "-" || s === "—") return 0;

  s = s.replace(/[^\d,.-]/g, "");

  if (s.includes(",") && !s.includes(".")){
    s = s.replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function elegirConsumo(ch, lk){
  const a = Number(ch || 0);
  const b = Number(lk || 0);

  if (a > 0 && b === 0) return a;
  if (b > 0 && a === 0) return b;
  if (a > 0 && b > 0) return Math.max(a, b);
  return 0;
}

/*************************************************
 * RENDER DE BOTONES DE TALLERISTAS
 *************************************************/
function renderTalleristas(lista){
  talleristasGrid.innerHTML = "";

  lista.forEach(nombre => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tallerista-btn";
    btn.textContent = nombre;

    if (nombre === talleristaActivo){
      btn.classList.add("active");
    }

    btn.addEventListener("click", () => seleccionarTallerista(nombre));
    talleristasGrid.appendChild(btn);
  });
}

function seleccionarTallerista(nombre){
  talleristaActivo = nombre;
  // Ocultar grilla de talleristas (no mostramos pill seleccionado)
  const grid = document.getElementById("talleristasGrid");
  if (grid) grid.classList.add("hidden");
  // Cambiar título: "Envios a <Tallerista>"
  const h1 = document.querySelector(".header-top h1");
  if (h1) h1.textContent = `Envios a ${nombre}`;
  btnVolver.classList.remove("hidden");
  const enviarBar = document.getElementById("enviarBar");
  if (enviarBar) enviarBar.classList.remove("hidden");
  const btnEnv = document.getElementById("btnEnviar");
  if (btnEnv) btnEnv.classList.remove("hidden");
  if (txtFiltroArticulo) { txtFiltroArticulo.value = ""; }
  if (filtroArticuloWrap) { filtroArticuloWrap.classList.remove("hidden"); }
  buscar(nombre);
}

async function volverALista(){
  talleristaActivo = "";
  resultEl.innerHTML = "";
  btnVolver.classList.add("hidden");
  const enviarBar = document.getElementById("enviarBar");
  if (enviarBar) enviarBar.classList.add("hidden");
  const btnEnv = document.getElementById("btnEnviar");
  if (btnEnv) btnEnv.classList.add("hidden");
  // Restaurar título
  const h1 = document.querySelector(".header-top h1");
  if (h1) h1.textContent = "Envios por Tallerista";
  // Mostrar grilla de talleristas de nuevo
  const grid = document.getElementById("talleristasGrid");
  if (grid) grid.classList.remove("hidden");
  btnSiguiente.disabled = true; btnSiguiente.classList.add("disabled");
  if (txtFiltroArticulo) { txtFiltroArticulo.value = ""; }
  if (filtroArticuloWrap) { filtroArticuloWrap.classList.add("hidden"); }
  // Asegurar que se vea fase1 (puede venir de fase2 o fase3)
  const fase1 = document.getElementById("fase1");
  const fase2 = document.getElementById("fase2");
  const fase3 = document.getElementById("fase3");
  if (fase1) fase1.classList.remove("hidden");
  if (fase2) fase2.classList.add("hidden");
  if (fase3) fase3.classList.add("hidden");
  renderTalleristas(listaTalleristas);
}

if (btnVolver) {
  btnVolver.addEventListener("click", volverALista);
} else {
  document.addEventListener("click", (e) => {
    if (e.target.id === "btnVolver" || e.target.closest("#btnVolver")) {
      volverALista();
    }
  });
}

/*************************************************
 * CARGA LISTA DE TALLERISTAS
 *************************************************/
async function cargarTalleristas(){
  resultEl.innerHTML = "";

  const { data, error } = await supabaseClient
    .from("v_piezas_por_tallerista_resumen")
    .select("*")
    .limit(5000);

  if (error){
    console.error("Error al cargar talleristas:", error);
    return;
  }

  listaTalleristas = [...new Set(
    (data || [])
      .map(r => String(pick(r, ["Tallerista", "tallerista", "TALLERISTA"]) || "").trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "es"));

  renderTalleristas(listaTalleristas);
}

/*************************************************
 * CARGA CONSUMOS DESDE E. MADRE CH / LK
 *************************************************/
async function cargarConsumos(){
  if (consumosCache) return consumosCache;

  const [respCH, respLK] = await Promise.all([
    supabaseClient.from("E. Madre CH").select("*").limit(10000),
    supabaseClient.from("E. Madre LK").select("*").limit(10000)
  ]);

  if (respCH.error){
    console.error(respCH.error);
    throw new Error("Error al leer E. Madre CH");
  }

  if (respLK.error){
    console.error(respLK.error);
    throw new Error("Error al leer E. Madre LK");
  }

  const mapCH = new Map();
  const mapLK = new Map();
  const finalMap = new Map();

  function cargarEnMapa(rows, mapDestino){
    (rows || []).forEach(r => {
      const codRaw =
        r.Cod ??
        r.cod ??
        r.COD ??
        r.codigo ??
        r["Cod"] ??
        r["COD"];

      const consumoRaw =
        r["E. Madre"] ??
        r["E_Madre"] ??
        r["e_madre"] ??
        r["e madre"] ??
        r["E_MADRE"] ??
        r.consumo;

      const cod = normalizeCode(codRaw);
      const consumo = parseConsumo(consumoRaw);

      if (!cod) return;
      mapDestino.set(cod, consumo);
    });
  }

  cargarEnMapa(respCH.data, mapCH);
  cargarEnMapa(respLK.data, mapLK);

  const todosLosCodigos = new Set([
    ...mapCH.keys(),
    ...mapLK.keys()
  ]);

  todosLosCodigos.forEach(cod => {
    finalMap.set(cod, elegirConsumo(mapCH.get(cod), mapLK.get(cod)));
  });

  consumosCache = finalMap;
  return finalMap;
}

/*************************************************
 * CARGA DATOS DE DESPIECE
 *************************************************/
async function cargarSectores(){
  if (sectoresCache) return sectoresCache;

  const { data, error } = await supabaseClient
    .from("Despiece x Articulo")
    .select("*")
    .limit(20000);

  if (error){
    console.error(error);
    throw new Error("Error al leer Despiece x Articulo");
  }

  const mapByCodeAndPart = new Map();
  const mapByPart = new Map();

  const kgXCajonByCodeAndPart = new Map();
  const kgXCajonByPart = new Map();

  const kgXUniByCodeAndPart = new Map();
  const kgXUniByPart = new Map();

  const partesXUniByCodeAndPart = new Map();
  const partesXUniByPart = new Map();

  // Rubro por sector y por parte (para clasificar igual que ControlTall — fuente de
  // verdad: Despiece x Articulo). Cuenta frecuencias y se queda con el mayoritario.
  const rubroCountsBySector = new Map();
  const rubroCountsByPart = new Map();

  (data || []).forEach(r => {
    const cod = normalizeCode(pick(r, ["COD", "Cod", "cod"]));
    const parte = normalizeText(pick(r, ["Descripcion de partes", "Descripción de partes", "descripcion de partes"]));
    const sector = String(pick(r, ["Sector Proce", "sector proce", "Sector_Proce"]) || "").trim();
    const rubro = String(pick(r, ["Rubro", "rubro", "RUBRO"]) || "").trim();

    const kgXCajon = parseDecimal(pick(r, ["Kg x Caj", "KG x Caj", "kg x caj", "Kg x caja", "kg x caja"]));
    const kgXUni = parseDecimal(pick(r, ["KGxUni", "KGxUNI", "KgxUni", "KgXUni", "kgxuni", "KG x Uni", "Kg x Uni", "kg x uni"]));
    const partesXUni = parseDecimal(pick(r, ["Partes x uni", "Partes x Uni", "partes x uni", "PartesXUni"]));

    if (!parte) return;

    if (!mapByPart.has(parte)) mapByPart.set(parte, new Set());
    if (sector) mapByPart.get(parte).add(sector);

    if (sector && rubro) {
      if (!rubroCountsBySector.has(sector)) rubroCountsBySector.set(sector, {});
      const counts = rubroCountsBySector.get(sector);
      counts[rubro] = (counts[rubro] || 0) + 1;
    }
    if (rubro) {
      if (!rubroCountsByPart.has(parte)) rubroCountsByPart.set(parte, {});
      const counts = rubroCountsByPart.get(parte);
      counts[rubro] = (counts[rubro] || 0) + 1;
    }

    if (cod && sector){
      const key = `${cod}__${parte}`;
      if (!mapByCodeAndPart.has(key)) mapByCodeAndPart.set(key, sector);
    }

    if (cod){
      const key = `${cod}__${parte}`;

      if (!kgXCajonByCodeAndPart.has(key)) kgXCajonByCodeAndPart.set(key, kgXCajon);
      if (!kgXUniByCodeAndPart.has(key)) kgXUniByCodeAndPart.set(key, kgXUni);
      if (!partesXUniByCodeAndPart.has(key)) partesXUniByCodeAndPart.set(key, partesXUni);
    }

    if (!kgXCajonByPart.has(parte)) kgXCajonByPart.set(parte, kgXCajon);
    if (!kgXUniByPart.has(parte)) kgXUniByPart.set(parte, kgXUni);
    if (!partesXUniByPart.has(parte)) partesXUniByPart.set(parte, partesXUni);
  });

  // Mapa sector → Set de CODs numéricos (para fallback de consumo)
  const codsPorSector = new Map();
  (data || []).forEach(r => {
    const cod = normalizeCode(pick(r, ["COD", "Cod", "cod"]));
    const sector = String(pick(r, ["Sector Proce", "sector proce", "Sector_Proce"]) || "").trim();
    if (!cod || !sector || !/^\d+$/.test(cod)) return;
    if (!codsPorSector.has(sector)) codsPorSector.set(sector, new Set());
    codsPorSector.get(sector).add(cod);
  });

  // Rubro mayoritario por sector y por parte (mismo criterio que ControlTall)
  function rubroMayoritario(counts){
    let mejor = "";
    let mejorCount = 0;
    for (const [rubro, n] of Object.entries(counts || {})) {
      if (n > mejorCount) { mejor = rubro; mejorCount = n; }
      else if (n === mejorCount && rubro === "Otros") { mejor = rubro; }
    }
    return mejor;
  }
  const rubroBySector = new Map();
  for (const [sector, counts] of rubroCountsBySector) {
    const r = rubroMayoritario(counts);
    if (r) rubroBySector.set(sector, r);
  }
  const rubroByPart = new Map();
  for (const [parte, counts] of rubroCountsByPart) {
    const r = rubroMayoritario(counts);
    if (r) rubroByPart.set(parte, r);
  }

  sectoresCache = {
    mapByCodeAndPart,
    mapByPart,
    kgXCajonByCodeAndPart,
    kgXCajonByPart,
    kgXUniByCodeAndPart,
    kgXUniByPart,
    partesXUniByCodeAndPart,
    partesXUniByPart,
    codsPorSector,
    rubroBySector,
    rubroByPart
  };

  return sectoresCache;
}

/*************************************************
 * HELPERS DE CÁLCULO
 *************************************************/
function obtenerSectorProce(descripcion, codigos, sectoresData){
  const parteNorm = normalizeText(descripcion);
  if (!parteNorm) return "";

  const { mapByCodeAndPart, mapByPart } = sectoresData;
  const sectoresEncontrados = new Set();

  for (const cod of codigos){
    const key = `${cod}__${parteNorm}`;
    const sector = mapByCodeAndPart.get(key);
    if (sector) sectoresEncontrados.add(sector);
  }

  if (sectoresEncontrados.size){
    return [...sectoresEncontrados].join(" / ");
  }

  if (mapByPart.has(parteNorm)){
    return [...mapByPart.get(parteNorm)].join(" / ");
  }

  return "";
}

function obtenerKgXCajon(descripcion, codigos, sectoresData){
  const parteNorm = normalizeText(descripcion);
  if (!parteNorm) return 0;

  const { kgXCajonByCodeAndPart, kgXCajonByPart } = sectoresData;

  for (const cod of codigos){
    const key = `${cod}__${parteNorm}`;
    if (kgXCajonByCodeAndPart.has(key)) return Number(kgXCajonByCodeAndPart.get(key) || 0);
  }

  return Number(kgXCajonByPart.get(parteNorm) || 0);
}

function obtenerKgXUni(descripcion, codigos, sectoresData){
  const parteNorm = normalizeText(descripcion);
  if (!parteNorm) return 0;

  const { kgXUniByCodeAndPart, kgXUniByPart } = sectoresData;

  for (const cod of codigos){
    const key = `${cod}__${parteNorm}`;
    if (kgXUniByCodeAndPart.has(key)) return Number(kgXUniByCodeAndPart.get(key) || 0);
  }

  return Number(kgXUniByPart.get(parteNorm) || 0);
}

function obtenerPartesXUni(descripcion, codigos, sectoresData){
  const parteNorm = normalizeText(descripcion);
  if (!parteNorm) return 0;

  const { partesXUniByCodeAndPart, partesXUniByPart } = sectoresData;

  for (const cod of codigos){
    const key = `${cod}__${parteNorm}`;
    if (partesXUniByCodeAndPart.has(key)) return Number(partesXUniByCodeAndPart.get(key) || 0);
  }

  return Number(partesXUniByPart.get(parteNorm) || 0);
}

/*************************************************
 * CARGA CAJAS
 *************************************************/
async function cargarArticulosCajas(){
  if (articulosCajasCache) return articulosCajasCache;
  const { data, error } = await supabaseClient.from("Articulos_Cajas").select("*").limit(5000);
  if (error){ console.error(error); articulosCajasCache = []; return []; }
  articulosCajasCache = data || [];
  return articulosCajasCache;
}

async function cargarCajas(){
  if (cajasCache) return cajasCache;
  const { data, error } = await supabaseClient.from("Cajas").select("*").limit(500);
  if (error){ console.error(error); cajasCache = []; return []; }
  cajasCache = data || [];
  return cajasCache;
}

function obtenerCajasPorTallerista(filasTallerista, articulosCajas, cajasData){
  const codsDelTallerista = new Set();
  filasTallerista.forEach(r => {
    const codsRaw = String(pick(r, ["cod_articulos", "Cod_articulos", "COD_ARTICULOS"]) || "");
    splitCodes(codsRaw).forEach(c => codsDelTallerista.add(c));
  });

  const nCajasSet = new Set();
  (articulosCajas || []).forEach(ac => {
    const cod = normalizeCode(String(ac.Cod_Art || ""));
    if (codsDelTallerista.has(cod)){
      const nCaja = Number(ac.N_Caja || 0);
      if (nCaja > 0) nCajasSet.add(nCaja);
    }
  });

  const result = [];
  (cajasData || []).forEach(c => {
    const nCaja = Number(c.N_Caja || 0);
    if (!nCajasSet.has(nCaja)) return;
    const maxUni = Number(c.Max_Uni_Virg || 0);
    const stockVirg = Number(c.Stock_Virg || 0);
    if (maxUni <= 0) return;
    result.push({
      sector: String(c.Sector || ""),
      descripcion: `Caja N ${nCaja}`,
      cajonesEnviar: Math.max(0, maxUni - stockVirg),
      esCarton: true
    });
  });

  return result.sort((a, b) => {
    const na = parseInt(a.descripcion.replace(/\D/g, "") || "0");
    const nb = parseInt(b.descripcion.replace(/\D/g, "") || "0");
    return na - nb;
  });
}

/*************************************************
 * CARGA ENVIOS Y ENTREGAS (misma lógica que ControlTall)
 *************************************************/
// Helper: paginar para evitar cap 1000 de Supabase + safety net
async function fetchAllPaginated(table, selectCols = "*"){
  const out = [];
  const PAGE = 1000;
  const MAX_PAGES = 100;
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++){
    const { data, error } = await supabaseClient.from(table).select(selectCols).range(from, from + PAGE - 1);
    if (error){ console.error(error); return out; }
    if (!data || !data.length) return out;
    out.push(...data);
    if (data.length < PAGE) return out;
    from += PAGE;
    if (page === MAX_PAGES - 1) console.warn(`[fetchAllPaginated] ${table}: MAX_PAGES alcanzado, filas: ${out.length}`);
  }
  return out;
}

async function cargarEnviosParaCalculo(){
  return await fetchAllPaginated("Envios a Talleristas");
}

async function cargarEntregasParaCalculo(){
  const [entregas, partes] = await Promise.all([
    fetchAllPaginated("Entregas_Tall_Todas"),
    fetchAllPaginated("Partes x Tallerista")
  ]);
  return { entregas, partes };
}

function obtenerEnviosUni(nombreTall, descripcion, enviosData, kgXUni){
  const tallNorm = normalizeText(nombreTall);
  const descNorm = normalizeText(descripcion);
  let totalUni = 0;

  (enviosData || []).forEach(r => {
    const t = normalizeText(pick(r, ["Tallerista", "tallerista"]));
    const d = normalizeText(pick(r, ["Descripcion", "descripcion"]));
    if (t !== tallNorm || d !== descNorm) return;

    const kg = parseDecimal(pick(r, ["KG", "Kg", "kg"]));
    const uni = parseDecimal(pick(r, ["Unidades", "unidades"]));

    if (uni > 0){
      totalUni += uni;
    } else if (kg > 0 && kgXUni > 0){
      totalUni += kg / kgXUni;
    }
  });

  return totalUni;
}

function obtenerEntregasUni(nombreTall, codigos, entregasData){
  if (!entregasData || !entregasData.entregas) return 0;

  const tallNorm = normalizeText(nombreTall);
  const codSet = new Set(codigos.map(c => normalizeCode(c)));
  let total = 0;

  // Mapear cod del tallerista desde Partes x Tallerista
  const codByDescAndTall = new Map();
  (entregasData.partes || []).forEach(p => {
    const t = normalizeText(pick(p, ["tallerista", "Tallerista"]));
    const cod = normalizeCode(pick(p, ["cod", "Cod"]));
    if (t === tallNorm && cod) codByDescAndTall.set(cod, true);
  });

  (entregasData.entregas || []).forEach(r => {
    const cod = normalizeCode(pick(r, ["Cod_Art", "Cod Art", "cod_art", "Cod"]));
    const uni = parseDecimal(pick(r, ["Unidades", "unidades", "Uni"]));
    if (codSet.has(cod) && uni > 0) total += uni;
  });

  return total;
}

function calcularCajones(consumoTotal, kgXUni, partesXUni, kgXCajon){
  const consumo = Number(consumoTotal || 0);
  const uni = Number(kgXUni || 0);
  const partes = Number(partesXUni || 0);
  const caj = Number(kgXCajon || 0);

  if (caj <= 0 || consumo <= 0 || uni <= 0 || partes <= 0) return 0;

  return (consumo * uni * partes) / caj;
}

/*************************************************
 * LÓGICA FALTANTE
 *************************************************/
function actualizarFaltanteRow(row, esInicial = false){
  const esperado = Number(row.dataset.cajonesEsperados || 0);
  const box = row.querySelector(".faltante-box");
  const esCarton = row.dataset.esCarton === "1";
  if (!box) return;

  // Para cartones la lógica sigue con input-uni; para resto, lee dataset.cajones (popup-driven)
  const cargadoCaj = esCarton
    ? parseInputNumber(row.querySelector('input[name^="uni_"]')?.value)
    : Number(row.dataset.cajones || 0);

  const sinCarga = (cargadoCaj === null || cargadoCaj === 0);

  if (!esInicial && sinCarga && esperado <= 0.4){
    box.classList.add("active");
    box.textContent = "F";
    return;
  }

  if (cargadoCaj === null){
    box.classList.remove("active");
    box.textContent = "";
    return;
  }

  if (cargadoCaj < esperado){
    box.classList.add("active");
    box.textContent = "F";
  } else {
    box.classList.remove("active");
    box.textContent = "";
  }
}

function activarLogicaFaltante(){
  resultEl.querySelectorAll("tbody tr").forEach(row => {
    const inputCaj = row.querySelector('.input-cajones');
    const box = row.querySelector(".faltante-box");

    if (inputCaj){
      inputCaj.addEventListener("input", () => {
        inputCaj.value = inputCaj.value.replace(/\D/g, "");
      });
      inputCaj.addEventListener("change", () => {
        const totalCaj = parseInt(inputCaj.value, 10) || 0;
        row.dataset.cajones = totalCaj;
        actualizarFaltanteRow(row, true);
        registrarCambioFila(row, {}, totalCaj, 0);
      });
    }

    const inputUni = row.querySelector(".input-uni");
    if (inputUni){
      inputUni.addEventListener("input", () => {
        inputUni.value = inputUni.value.replace(/[^\d]/g, "");
        registrarCambioFila(row);
      });
      inputUni.addEventListener("change", () => registrarCambioFila(row));
    }

    // Input Kg Neto (unificado Fase 1) — solo para no-cartones
    const inputKg = row.querySelector(".input-kg");
    if (inputKg){
      inputKg.addEventListener("input", () => {
        inputKg.value = inputKg.value.replace(/[^0-9,.\-]/g, "");
      });
      inputKg.addEventListener("change", () => {
        registrarKgFilaTall(row, inputKg.value);
      });
    }

    // Botón Tandas (T)
    const tandaBtn = row.querySelector('[data-action="tandas"]');
    if (tandaBtn){
      tandaBtn.addEventListener("click", () => {
        const idx = Number(tandaBtn.dataset.filaIdx);
        abrirTandasFilaTall(idx);
      });
    }

    if (box){
      box.addEventListener("click", () => {
        box.classList.toggle("active");
        box.textContent = box.classList.contains("active") ? "F" : "";
        registrarCambioFila(row);
      });
    }

    actualizarFaltanteRow(row,true);
  });
}

/*************************************************
 * CARGAR CARTONES POR TALLERISTA
 *************************************************/
async function cargarCartonesPorTallerista(tallerista){
  const [resPxt, resLK, resCH] = await Promise.all([
    supabaseClient
      .from("Partes x Tallerista")
      .select("cod, descripcion_parte, stock_online")
      .eq("tallerista", tallerista)
      .like("descripcion_parte", "Cartón%")
      .limit(500),
    supabaseClient.from("E. Madre LK").select('"Cod","E. Madre"'),
    supabaseClient.from("E. Madre CH").select('"Cod","E. Madre"')
  ]);

  if (resPxt.error){
    console.error("Error cargando cartones:", resPxt.error);
    return [];
  }

  // Construir mapa de consumos (max entre LK y CH)
  const consumoMap = new Map();
  (resLK.data || []).forEach(r => {
    const cod = String(r["Cod"] || "").trim().toUpperCase();
    const val = Number(r["E. Madre"] || 0);
    if (cod && val > 0) consumoMap.set(cod, val);
  });
  (resCH.data || []).forEach(r => {
    const cod = String(r["Cod"] || "").trim().toUpperCase();
    const val = Number(r["E. Madre"] || 0);
    if (cod && val > 0){
      const prev = consumoMap.get(cod) || 0;
      consumoMap.set(cod, Math.max(prev, val));
    }
  });

  // Calcular máximo dinámicamente: consumo / 1000
  return (resPxt.data || []).map(c => {
    const cod = String(c.cod || "").trim();
    const desc = String(c.descripcion_parte || "").trim();
    const consumo = consumoMap.get(cod.toUpperCase()) || 0;

    // Nombre para mostrar: si es solo "Cartón", agregar código para distinguirlos
    const descDisplay = (desc.toLowerCase() === "cartón" || desc.toLowerCase() === "carton") && cod
      ? `${desc} ${cod}`
      : desc;

    return {
      cod,
      descripcion_parte: desc,
      descripcion_display: descDisplay,
      stock_online: Number(c.stock_online || 0),
      maximo: consumo > 0 ? consumo / 1000 : 0
    };
  });
}

/*************************************************
 * BÚSQUEDA PRINCIPAL
 *************************************************/
async function buscar(nombreParam){
  const nombre = String(nombreParam || "").trim();
  if (!nombre) return;

  filasModificadas.clear();
  btnSiguiente.disabled = true; btnSiguiente.classList.add("disabled");
  btnSiguiente.disabled = false;
  btnSiguiente.textContent = "Enviar cambios";

  resultEl.innerHTML = "";

  const { data, error } = await supabaseClient
    .from("v_piezas_por_tallerista_resumen")
    .select("*")
    .limit(5000);

  if (error){
    console.error("Error al buscar:", error);
    return;
  }

  const filasTallerista = (data || []).filter(r => {
    const t = String(pick(r, ["Tallerista", "tallerista", "TALLERISTA"]) || "").trim();
    return t === nombre;
  });

  if (!filasTallerista.length){
    resultEl.innerHTML = `
      <div class="articulo">
        <div class="articulo-header">${escapeHtml(nombre)}</div>
        <div class="empty-state">No hay artículos con cajones a enviar mayores a 0.</div>
      </div>
    `;
    return;
  }

  let consumoMap, sectoresData, cartones, articulosCajas, cajasData, enviosData, entregasData;

  try{
    [consumoMap, sectoresData, cartones, articulosCajas, cajasData, enviosData, entregasData] = await Promise.all([
      cargarConsumos(),
      cargarSectores(),
      cargarCartonesPorTallerista(nombre),
      cargarArticulosCajas(),
      cargarCajas(),
      cargarEnviosParaCalculo(),
      cargarEntregasParaCalculo()
    ]);
  }catch (err){
    console.error(err);
    return;
  }

  filasFiltradas = [];

  filasTallerista.forEach(r => {
    const descripcion = String(pick(r, ["pieza", "Pieza", "PIEZA"]) || "").trim();
    // Saltar cartones de la vista — se cargan aparte via cargarCartonesPorTallerista
    if (normalizeText(descripcion).startsWith("carton")) return;
    const codsRaw = String(pick(r, ["cod_articulos", "Cod_articulos", "COD_ARTICULOS"]) || "");
    const codigos = splitCodes(codsRaw);

    if (!descripcion || !codigos.length) return;

    const sectorProce = obtenerSectorProce(descripcion, codigos, sectoresData);

    const kgXCajon = obtenerKgXCajon(descripcion, codigos, sectoresData);
    const kgXUni = obtenerKgXUni(descripcion, codigos, sectoresData);
    const partesXUni = obtenerPartesXUni(descripcion, codigos, sectoresData);

    let consumoTotal = 0;
    codigos.forEach(cod => {
      consumoTotal += Number(consumoMap.get(cod) || 0);
    });
    // Fallback: si consumo es 0, buscar via artículos que usan ese sector
    if (consumoTotal === 0 && sectorProce && sectoresData.codsPorSector) {
      const codsDelSector = sectoresData.codsPorSector.get(sectorProce);
      if (codsDelSector) {
        codsDelSector.forEach(cod => {
          consumoTotal += Number(consumoMap.get(cod) || 0);
        });
      }
    }

    const esCarton = normalizeText(descripcion).startsWith("carton");
    const maxCajones = esCarton
      ? (consumoTotal > 0 ? consumoTotal / 1000 : 0)
      : calcularCajones(consumoTotal, kgXUni, partesXUni, kgXCajon);

    // Misma fórmula que ControlTall
    const stockInicialKg = parseDecimal(
      pick(r, ["Stock Inicial", "stock_inicial", "stock inicial", "Stock_Inicial"])
    );

    const totalEnviosUni = obtenerEnviosUni(nombre, descripcion, enviosData, kgXUni);
    const totalEntregasUni = obtenerEntregasUni(nombre, codigos, entregasData);

    const onlineUni = kgXUni > 0
      ? (stockInicialKg / kgXUni) + totalEnviosUni - totalEntregasUni
      : 0;
    const onlineKg = onlineUni * kgXUni;
    const onlineCaj = kgXCajon > 0 ? (onlineKg / kgXCajon) : 0;

    const cajonesEnviar = Math.max(0, maxCajones - onlineCaj);

    filasFiltradas.push({
      tallerista: nombre,
      sector: sectorProce,
      descripcion,
      cajonesEnviar,
      codigos,
      esCarton: false
    });
  });

  // Agregar cartones
  cartones.forEach(c => {
    const desc = String(c.descripcion_parte || "").trim();
    const descDisplay = String(c.descripcion_display || desc).trim();
    const stock = Number(c.stock_online || 0);
    const maximo = Number(c.maximo || 0);

    if (desc) {
      const cajonesEnviar = Math.max(0, maximo - stock);
      filasFiltradas.push({
        tallerista: nombre,
        sector: "Sin sector",
        descripcion: desc,
        descripcionDisplay: descDisplay,
        cajonesEnviar,
        esCarton: true
      });
    }
  });

  // Agregar cajas (se envían en unidades como cartones)
  const cajasItems = obtenerCajasPorTallerista(filasTallerista, articulosCajas, cajasData);
  cajasItems.forEach(c => {
    filasFiltradas.push({
      tallerista: nombre,
      sector: c.sector,
      descripcion: c.descripcion,
      cajonesEnviar: c.cajonesEnviar,
      esCarton: true
    });
  });

  // Talleristas que arman GRJ: no se les envía GRJ, lo entregan ellos
  const TALL_NO_ENVIAR_GRJ = [];

  // Filtrar GRJ de talleristas que arman (no se les envía GRJ)
  const talleristaNombre = String(filasFiltradas[0]?.tallerista || "").trim();
  const ocultarGaraje = TALL_NO_ENVIAR_GRJ.includes(talleristaNombre);
  if (ocultarGaraje) {
    for (let i = filasFiltradas.length - 1; i >= 0; i--) {
      if (clasificarItem(filasFiltradas[i]) === "Garaje") filasFiltradas.splice(i, 1);
    }
  }

  // Orden idéntico a ControlTall: por grupo (GRUPOS_ORDEN), después por sector con
  // numeric:true (A8 < A10 < B4 ...) y finalmente por descripción.
  filasFiltradas.sort((a, b) => {
    const ga = GRUPOS_ORDEN.indexOf(clasificarItem(a));
    const gb = GRUPOS_ORDEN.indexOf(clasificarItem(b));
    if (ga !== gb) return ga - gb;
    const sa = String(a.sector || "").trim();
    const sb = String(b.sector || "").trim();
    if (sa && sb) return sa.localeCompare(sb, "es", { numeric: true, sensitivity: "base" });
    if (!sa && !sb) {
      return String(a.descripcion || "").localeCompare(String(b.descripcion || ""), "es", { numeric: true, sensitivity: "base" });
    }
    return sa ? -1 : 1; // los que tienen sector primero
  });

  renderizarFilasFase1(txtFiltroArticulo ? txtFiltroArticulo.value : "");
}

function renderizarFilasFase1(filtro){
  const nombre = talleristaActivo;
  const q = normalizeText(filtro || "");
  const lista = !q ? filasFiltradas : filasFiltradas.filter(item =>
    normalizeText(item.descripcion).includes(q) ||
    normalizeText(item.sector || "").includes(q) ||
    (item.codigos || []).some(c => c.includes(q))
  );

  if (!filasFiltradas.length){
    resultEl.innerHTML = `
      <div class="articulo">
        <div class="articulo-header">${escapeHtml(nombre)}</div>
        <div class="empty-state">No hay artículos con cajones a enviar mayores a 0.</div>
      </div>
    `;
    return;
  }

  let rows = "";
  let grupoActual = "";

  lista.forEach(item => {
    const index = filasFiltradas.indexOf(item);
    const grupo = clasificarItem(item);
    if (grupo !== grupoActual){
      grupoActual = grupo;
      rows += `<tr class="grupo-header"><td colspan="8">${escapeHtml(grupo)}</td></tr>`;
    }
    const bufKey = `${item.tallerista}__${item.sector || ""}__${item.descripcion}`;
    const bufItem = getBuffer().find(b => `${b.tallerista}__${b.sector || ""}__${b.descripcion}` === bufKey);
    const bufCajVal = bufItem ? Number(bufItem.cajones) : 0;
    const bufUniVal = bufItem ? (bufItem.unidades || "") : "";
    const bufKgVal = bufItem ? (bufItem.kg || "") : "";
    const bufPesoCaj = bufItem ? Number(bufItem.pesoCajones || 0) : 0;

    // Tandas (solo no-cartones)
    const tandasArr = (bufItem && Array.isArray(bufItem.tandas)) ? bufItem.tandas : [];
    const hayTandas = !item.esCarton && tandasArr.length > 0;
    const totCajTandas = tandasArr.reduce((s, t) => s + (Number(t.caj) || 0), 0);
    const totKgTandas = tandasArr.reduce((s, t) => s + (parseDecimal(t.kg) || 0), 0);

    // Cajones: solo no-cartones
    let cajCell;
    if (item.esCarton) {
      cajCell = `<td class="right"><span class="zero">—</span></td>`;
    } else {
      const cajVal = hayTandas ? totCajTandas : (bufCajVal || '');
      const cajCls = hayTandas ? 'cell-input input-cajones input-with-tandas' : 'cell-input input-cajones';
      const ro = hayTandas ? 'readonly' : '';
      cajCell = `<td class="right"><input type="text" inputmode="numeric" class="${cajCls}" data-fila-idx-trigger="${index}" placeholder="0" value="${cajVal}" autocomplete="off" style="width:60px;text-align:center" ${ro}></td>`;
    }

    // Kg Neto: solo no-cartones (los cartones no se pesan)
    let kgCell;
    if (item.esCarton) {
      kgCell = `<td class="right"><span class="zero">—</span></td>`;
    } else {
      const kgVal = hayTandas ? (totKgTandas > 0 ? String(totKgTandas) : '') : bufKgVal;
      const kgCls = hayTandas ? 'cell-input input-kg input-with-tandas' : 'cell-input input-kg';
      const ro = hayTandas ? 'readonly' : '';
      kgCell = `<td class="right"><input type="text" inputmode="decimal" class="${kgCls}" data-fila-idx-kg="${index}" placeholder="0,0" value="${kgVal}" autocomplete="off" style="width:80px;text-align:center" ${ro}></td>`;
    }

    // Tandas (T): solo no-cartones
    const tandaCell = item.esCarton
      ? `<td class="center"><span class="zero">—</span></td>`
      : `<td class="center"><button type="button" class="tanda-trigger ${hayTandas ? 'has-tandas' : ''}" data-action="tandas" data-fila-idx="${index}" title="Cargar por tandas">${hayTandas ? tandasArr.length : '+'}</button></td>`;

    // Uni: solo cartones/cajas (no se pesan, se cuentan unidades)
    const uniCell = item.esCarton
      ? `<td class="right"><input type="text" inputmode="numeric" class="cell-input cell-input-small input-uni" placeholder="0" name="uni_${index}" value="${bufUniVal}" autocomplete="off"></td>`
      : `<td class="right"><span class="zero">—</span></td>`;

    rows += `
      <tr
        data-fila-idx="${index}"
        data-cajones-esperados="${Number(item.cajonesEnviar)}"
        data-es-carton="${item.esCarton ? "1" : "0"}"
        data-cajones="${bufCajVal}"
        data-peso-cajones="${bufPesoCaj}"
      >
        <td>${item.sector ? escapeHtml(item.sector) : '<span class="zero">Sin sector</span>'}</td>
        <td class="descripcion-cell">${escapeHtml(item.descripcionDisplay || item.descripcion)}</td>
        <td class="right"><b>${escapeHtml(formatDecimal(item.cajonesEnviar))}</b></td>
        <td class="center">
          <div class="faltante-box" data-index="${index}"></div>
        </td>
        ${cajCell}
        ${kgCell}
        ${tandaCell}
        ${uniCell}
      </tr>
    `;
  });

  resultEl.innerHTML = `
    <div class="articulo">
      <div class="articulo-header">${escapeHtml(nombre)}</div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th><span class="th-wrap">Sec</span></th>
              <th><span class="th-wrap">Descripción</span></th>
              <th class="right"><span class="th-wrap">Cjn<br>a Env.</span></th>
              <th class="center"><span class="th-wrap">Falt</span></th>
              <th class="right"><span class="th-wrap">Caj</span></th>
              <th class="right"><span class="th-wrap">KG<br>Neto</span></th>
              <th class="center" title="Tandas"><span class="th-wrap">T</span></th>
              <th class="right"><span class="th-wrap">Uni</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="8" class="zero" style="text-align:center;padding:16px">Sin resultados para "${escapeHtml(filtro)}"</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  activarLogicaFaltante();
}

/*******************************************************
 * BOTON ENVIAR
 *******************************************************/
function obtenerClaveFila(row){
  const idx = Number(row.dataset.filaIdx);
  const item = filasFiltradas[idx];
  if (!item) return "";
  return `${item.tallerista}__${item.sector || ""}__${item.descripcion}`;
}

function getDiaMesHoy(){
  const hoy = new Date();
  const dia = String(hoy.getDate()).padStart(2, "0");
  const mes = String(hoy.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}`;
}

const fechaEnvioInput = document.getElementById("fechaEnvio");

// Inicializar al día de hoy (formato ISO para el input date)
(function(){
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, "0");
  const d = String(hoy.getDate()).padStart(2, "0");
  if (fechaEnvioInput) fechaEnvioInput.value = `${y}-${m}-${d}`;
})();

function getFechaDiaMes(){
  const val = fechaEnvioInput ? fechaEnvioInput.value : "";
  if (val) {
    const [, mes, dia] = val.split("-");
    return `${dia}/${mes}`;
  }
  return getDiaMesHoy();
}

/*************************************************
 * TOAST DESHACER
 *************************************************/
function mostrarToastDeshacer(ids, payload){
  ultimoEnvioIds = ids;
  ultimoEnvioPayload = payload;

  toastDeshacer.classList.remove("hidden");
  toastProgress.style.animation = "none";
  setTimeout(() => { toastProgress.style.animation = ""; }, 10);

  // Limpiar timer anterior si existe
  if (window.timerToastDeshacer) clearTimeout(window.timerToastDeshacer);

  // Toast permanente: se cierra manualmente o cuando se deshacer
}

async function deshacerEnvio(){
  if (!ultimoEnvioIds || !ultimoEnvioIds.length){
    alert("No hay envios para deshacer");
    return;
  }

  if (!confirm("¿Deshacer el último envio?")) return;

  // Desactivar botón durante la operación
  btnDeshacerEnvio.disabled = true;
  const textOriginal = btnDeshacerEnvio.textContent;
  btnDeshacerEnvio.textContent = "Deshaciendo...";

  try {
    // 1. Eliminar registros de Envios a Talleristas
    const { error: errorDelete } = await supabaseClient
      .from(TABLA_DESTINO)
      .delete()
      .in("id", ultimoEnvioIds);

    if (errorDelete){
      throw new Error("Error al eliminar: " + errorDelete.message);
    }

    // 2. Revertir descuentos de SP Kg
    for (const item of ultimoEnvioPayload){
      if (!item.Sector) continue;

      // Obtener stock actual
      const { data: spData, error: errorSP } = await supabaseClient
        .from("SP Kg")
        .select("\"Stock Inicial\"")
        .eq("Sp", item.Sector)
        .single();

      if (!errorSP && spData){
        const stockActual = Number(spData["Stock Inicial"] || 0);
        const stockNuevo = stockActual + Number(item.KG || 0);

        await supabaseClient
          .from("SP Kg")
          .update({ "Stock Inicial": stockNuevo })
          .eq("Sp", item.Sector);
      }
    }

    // 3. Cerrar toast y recargar
    toastDeshacer.classList.add("hidden");
    if (window.timerToastDeshacer) clearTimeout(window.timerToastDeshacer);

    // Limpiar datos
    ultimoEnvioIds = [];
    ultimoEnvioPayload = [];

    // Recargar la página
    if (talleristaActivo) buscar(talleristaActivo);

    alert("Envio deshecho correctamente");

  }catch(err){
    console.error(err);
    alert("Error: " + (err.message || "no se pudo deshacer"));
  }finally{
    btnDeshacerEnvio.disabled = false;
    btnDeshacerEnvio.textContent = textOriginal;
  }
}

// Event listeners para toast
btnDeshacerEnvio.addEventListener("click", deshacerEnvio);
btnCerrarToast.addEventListener("click", () => {
  toastDeshacer.classList.add("hidden");
  ultimoEnvioIds = [];
  ultimoEnvioPayload = [];
});

/*************************************************
 * NAVEGACION ENTRE FASES
 *************************************************/
function mostrarFase(n){
  currentPhase = n;
  fase1.classList.toggle("hidden", n !== 1);
  fase2.classList.toggle("hidden", n !== 2);
  fase3.classList.toggle("hidden", n !== 3);
}

// btnSiguiente.addEventListener → eliminado. Fase 1 y 2 unificadas: btnEnviar va directo.
// btnVolverFase1.addEventListener → eliminado (no hay Fase 2).

function renderizarFase2(){
  const buf = getBuffer();
  const itemsConCaj = buf
    .map((b, bufIdx) => ({ ...b, _bufIdx: bufIdx }))
    .filter(b =>
      b.tallerista === talleristaActivo &&
      (Number(b.cajones) > 0 || Number(b.unidades) > 0)
    );

  fase2TableBody.innerHTML = itemsConCaj.map((item) => {
    const esCarton = !!item.esCarton;
    const bufIdx = item._bufIdx;
    const kgVal = item.kg ? parseDecimal(item.kg) : 0;
    const cajCell = esCarton
      ? `<td class="right"><span class="zero">—</span></td>`
      : `<td class="right"><b>${item.cajones}</b></td>`;
    const cantCell = esCarton
      ? `<td class="right" style="font-weight:700;color:#111;">${Number(item.unidades)} <small style="color:#666;font-weight:400;">uni</small></td>`
      : `<td class="right"><input type="text" inputmode="decimal" class="cell-input input-kg-fase2" data-buf-idx="${bufIdx}" placeholder="0,0" value="${kgVal ? formatNumKgEt(kgVal) : ''}" autocomplete="off"></td>`;
    return `
    <tr data-buf-idx="${bufIdx}" data-es-carton="${esCarton ? '1' : '0'}">
      <td>${escapeHtml(item.tallerista)}</td>
      <td>${escapeHtml(item.sector || "")}</td>
      <td class="descripcion-cell">${escapeHtml(item.descripcionDisplay || item.descripcion)}</td>
      ${cajCell}
      ${cantCell}
      <td class="center"><button type="button" class="btn-quitar-fase2" data-buf-idx="${bufIdx}">✕</button></td>
    </tr>`;
  }).join("");

  // Event listeners para inputs de Kg en Fase 2
  fase2TableBody.querySelectorAll(".input-kg-fase2").forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^0-9,.\-]/g, "");
      validarFase2Completa();
    });
    input.addEventListener("change", () => {
      const idx = Number(input.dataset.bufIdx);
      const buf = getBuffer();
      if (buf[idx]) {
        buf[idx].kg = String(parseDecimal(input.value));
      }
      localStorage.setItem(BUFFER_KEY, JSON.stringify(buf));
      validarFase2Completa();
    });
  });

  // Event listeners para botones quitar
  fase2TableBody.querySelectorAll(".btn-quitar-fase2").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.bufIdx);
      const buf = getBuffer();
      buf.splice(idx, 1);
      localStorage.setItem(BUFFER_KEY, JSON.stringify(buf));
      renderizarFase2();
    });
  });

  ultimoEnvioPhase2 = itemsConCaj;
  validarFase2Completa();
}

function validarFase2Completa(){
  const inputs = fase2TableBody.querySelectorAll(".input-kg-fase2");
  const todosLlenos = Array.from(inputs).every(input => {
    const val = input.value.trim();
    return val && parseDecimal(val) > 0;
  });
  btnEnviar.disabled = !todosLlenos;
  btnEnviar.classList.toggle("disabled", !todosLlenos);
}

btnEnviar.addEventListener("click", async () => {
  // Sync de inputs Fase 1 unificada (cajones, kg, uni) por si user presionó Enviar sin blur.
  // Skip filas con inputs READONLY (tienen tandas — el valor mostrado es derivado).
  resultEl.querySelectorAll("tbody tr").forEach(row => {
    const inputCaj = row.querySelector(".input-cajones");
    if (inputCaj && !inputCaj.readOnly){
      const totalCaj = parseInt(inputCaj.value, 10) || 0;
      if (totalCaj > 0) {
        row.dataset.cajones = totalCaj;
        registrarCambioFila(row, {}, totalCaj, 0);
      }
    }
    const inputKg = row.querySelector(".input-kg");
    if (inputKg && !inputKg.readOnly) registrarKgFilaTall(row, inputKg.value);
    const inputUni = row.querySelector(".input-uni");
    if (inputUni) registrarCambioFila(row);
  });

  const buf = getBuffer();
  const itemsConCaj = buf.filter(b =>
    b.tallerista === talleristaActivo &&
    (Number(b.cajones) > 0 || Number(b.unidades) > 0)
  );

  // Validar que todos los NO-cartones con cajones>0 tengan Kg
  const faltanKg = itemsConCaj.filter(b => !b.esCarton && Number(b.cajones) > 0 && !(parseDecimal(b.kg) > 0));
  if (faltanKg.length){
    alert("Falta cargar Kg neto para: " + faltanKg.map(b => b.descripcion).join(", "));
    return;
  }

  // Confirmación visual antes de insertar
  const confirmado = await mostrarConfirmacionEnvioTall(itemsConCaj);
  if (!confirmado) return;

  btnEnviar.disabled = true;
  const textOriginal = btnEnviar.textContent;
  btnEnviar.textContent = "Enviando...";

  try {
    // Construir payload igual que antes
    const payload = [];
    let talleristasVistos = new Set();

    itemsConCaj.forEach(item => {
      if (!talleristasVistos.has(item.tallerista)){
        talleristasVistos.add(item.tallerista);
      }
      const esCarton = !!item.esCarton;
      payload.push({
        "Tallerista": item.tallerista,
        "Sector": item.sector || "",
        "Descripcion": item.descripcion,
        "Cajones": esCarton ? 0 : Number(item.cajones),
        "KG": esCarton ? 0 : parseDecimal(item.kg),
        "Unidades": esCarton ? Number(item.unidades) : 0,
        "Dia-mes": getFechaDiaMes(),
        "Faltante": !!item.faltante
      });
    });

    // Insertar en BD
    const { data: insertados, error } = await supabaseClient
      .from(TABLA_DESTINO)
      .insert(payload)
      .select("id");

    if (error) throw new Error(error.message);

    const ids = insertados.map(r => r.id);

    // Descontar SP Kg (agrupado por sector, en paralelo)
    const kgPorSector = new Map();
    payload.forEach(item => {
      const sec = String(item.Sector || "").trim();
      if (!sec || sec === "Sin sector" || !item.KG || item.KG <= 0) return;
      kgPorSector.set(sec, (kgPorSector.get(sec) || 0) + Number(item.KG));
    });

    if (kgPorSector.size > 0) {
      await Promise.all([...kgPorSector.entries()].map(async ([sector, kgTotal]) => {
        const { data: spData } = await supabaseClient
          .from("SP Kg")
          .select("\"Stock Inicial\"")
          .eq("Sp", sector)
          .maybeSingle();

        if (spData) {
          const stockActual = Number(spData["Stock Inicial"] || 0);
          const stockNuevo = stockActual - kgTotal;
          await supabaseClient
            .from("SP Kg")
            .update({ "Stock Inicial": stockNuevo })
            .eq("Sp", sector);
        }
      }));
    }

    // Limpiar solo los items del tallerista activo; conservar otros talleristas pendientes
    const bufRestante = getBuffer().filter(b => b.tallerista !== talleristaActivo);
    localStorage.setItem(BUFFER_KEY, JSON.stringify(bufRestante));
    actualizarBtnSiguiente();

    mostrarFase(3);
    renderizarFase3(itemsConCaj);
    mostrarToastDeshacer(ids, payload);

  }catch(err){
    console.error(err);
    alert("Error: " + (err.message || "no se pudo enviar"));
  }finally{
    btnEnviar.disabled = false;
    btnEnviar.textContent = textOriginal;
  }
});

function renderizarFase3(items){
  fase3TableBody.innerHTML = items.map(item => {
    const esCarton = !!item.esCarton;
    const cajTd = esCarton
      ? `<td class="right"><span class="zero">—</span></td>`
      : `<td class="right"><b>${item.cajones}</b></td>`;
    const cantTd = esCarton
      ? `<td class="right"><b>${Number(item.unidades)}</b> <small style="color:#666">uni</small></td>`
      : `<td class="right"><b>${parseDecimal(item.kg).toLocaleString("es-AR",{minimumFractionDigits:1,maximumFractionDigits:1})}</b></td>`;
    return `
    <tr>
      <td>${escapeHtml(item.tallerista)}</td>
      <td>${escapeHtml(item.sector || "")}</td>
      <td class="descripcion-cell">${escapeHtml(item.descripcionDisplay || item.descripcion)}</td>
      ${cajTd}
      ${cantTd}
    </tr>`;
  }).join("");
}

btnImprimir.addEventListener("click", () => {
  // Tomar datos directamente del buffer del último envío (ultimoEnvioPhase2)
  const items = ultimoEnvioPhase2;
  if (!items || !items.length) return;

  const tallerista = items[0].tallerista || "";
  const hoy = new Date();
  const fechaStr = hoy.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const horaStr = hoy.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  // Agrupar por clasificación (usa clasificarItem y GRUPOS_ORDEN module-level
  // para mantener mismo orden y categorías que ControlTall y la tabla principal).
  const porGrupo = {};
  GRUPOS_ORDEN.forEach(g => { porGrupo[g] = []; });
  items.forEach(item => { porGrupo[clasificarItem(item)].push(item); });

  let filas = "";
  let totalCaj = 0;
  let totalKg = 0;
  GRUPOS_ORDEN.forEach(grupo => {
    const lista = porGrupo[grupo];
    if (!lista.length) return;
    filas += `<tr class="grupo-row"><td colspan="4">${grupo}</td></tr>`;
    lista.forEach(item => {
      const caj = Number(item.cajones || 0);
      const kg = parseDecimal(item.kg);
      totalCaj += caj;
      totalKg += kg;
      filas += `
        <tr>
          <td class="td-sec">${escapeHtml(item.sector || "—")}</td>
          <td class="td-desc">${escapeHtml(item.descripcion)}</td>
          <td class="td-num">${caj}</td>
          <td class="td-num">${kg.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
        </tr>`;
    });
  });

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Envío — ${escapeHtml(tallerista)} — ${fechaStr}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #111; background: #fff; padding: 18px 22px; }

  /* ENCABEZADO */
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
  .header-left { display: flex; flex-direction: column; gap: 2px; }
  .empresa { font-size: 13px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; }
  .subtitulo { font-size: 11px; color: #555; }
  .header-right { text-align: right; }
  .tallerista-nombre { font-size: 20px; font-weight: 900; letter-spacing: -0.5px; }
  .fecha-hora { font-size: 10px; color: #666; margin-top: 2px; }

  /* TABLA */
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  thead tr th { background: #111; color: #fff; padding: 6px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  th.right, td.td-num { text-align: right; }
  th.left, td.td-sec, td.td-desc { text-align: left; }

  tbody tr { border-bottom: 1px solid #e0e0e0; }
  tbody tr:last-child { border-bottom: none; }
  tbody td { padding: 5px 8px; vertical-align: middle; }

  .td-sec { font-weight: 700; font-size: 10px; white-space: nowrap; color: #333; width: 56px; }
  .td-desc { }
  .td-num { font-variant-numeric: tabular-nums; white-space: nowrap; width: 46px; }

  /* FILAS DE GRUPO */
  .grupo-row td { background: #f0f0f0; font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px; color: #444; border-top: 1px solid #ccc; }

  /* TOTALES */
  .total-row td { border-top: 2px solid #111; font-weight: 800; font-size: 11px; padding: 6px 8px; background: #f8f8f8; }

  /* FIRMA */
  .firma { margin-top: 28px; display: flex; justify-content: space-between; }
  .firma-box { border-top: 1px solid #999; width: 180px; text-align: center; padding-top: 4px; font-size: 9px; color: #555; }

  @media print {
    body { padding: 10px 14px; }
    @page { margin: 10mm 12mm; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <span class="empresa">Gestión Productiva</span>
    <span class="subtitulo">Envío de materiales</span>
  </div>
  <div class="header-right">
    <div class="tallerista-nombre">${escapeHtml(tallerista)}</div>
    <div class="fecha-hora">${fechaStr} — ${horaStr}</div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th class="left">Sec</th>
      <th class="left">Descripción</th>
      <th class="right">Caj</th>
      <th class="right">Kg</th>
    </tr>
  </thead>
  <tbody>
    ${filas}
    <tr class="total-row">
      <td colspan="2">TOTAL</td>
      <td class="td-num">${totalCaj}</td>
      <td class="td-num">${totalKg.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
    </tr>
  </tbody>
</table>

<div class="firma">
  <div class="firma-box">Entrega</div>
  <div class="firma-box">Recibe</div>
</div>

</body>
</html>`;

  const ventana = window.open("", "_blank");
  ventana.document.write(html);
  ventana.document.close();
  setTimeout(() => ventana.print(), 300);
});

function registrarCambioFila(row, selPopup, totalCajPopup, pesoTotalPopup){
  const idx = Number(row.dataset.filaIdx);
  const item = filasFiltradas[idx];
  if (!item) return;

  const tallerista = item.tallerista || "";
  const sector = item.sector || "";
  const descripcion = item.descripcion || "";
  const descripcionDisplay = item.descripcionDisplay || descripcion;
  const esCarton = item.esCarton;

  const inputUni = row.querySelector('input[name^="uni_"]');
  const faltanteBox = row.querySelector(".faltante-box");

  // Cajones: popup (no-cartones) o input vacío (cartones — siempre 0 cajones)
  const cajEnviar = esCarton ? 0 : (totalCajPopup !== undefined ? totalCajPopup : Number(row.dataset.cajones || 0));
  const pesoCajones = totalCajPopup !== undefined ? pesoTotalPopup : Number(row.dataset.pesoCajones || 0);
  const cajonesSel = selPopup !== undefined ? selPopup : null;

  const uniEnviar = parseInputNumber(inputUni?.value);
  const faltante = !!faltanteBox?.classList.contains("active");

  const hayCambios =
    (cajEnviar !== null && cajEnviar !== 0) ||
    (uniEnviar !== null && uniEnviar !== 0) ||
    faltante === true;

  if (hayCambios){
    const buf = getBuffer();
    const key = `${tallerista}__${sector}__${descripcion}`;
    const bufIdx = buf.findIndex(b => `${b.tallerista}__${b.sector}__${b.descripcion}` === key);
    // Preservar cajonesSel/pesoCajones del buffer si el cambio vino del F/uni (no del popup)
    const prevSel = (bufIdx >= 0 && cajonesSel === null) ? (buf[bufIdx].cajonesSel || null) : cajonesSel;
    const prevPeso = (bufIdx >= 0 && totalCajPopup === undefined) ? Number(buf[bufIdx].pesoCajones || 0) : pesoCajones;
    const prevKg = (bufIdx >= 0) ? (buf[bufIdx].kg || "") : "";
    const prevTandas = (bufIdx >= 0 && Array.isArray(buf[bufIdx].tandas)) ? buf[bufIdx].tandas : [];
    addToBuffer({
      tallerista,
      sector,
      descripcion,
      descripcionDisplay,
      cajones: cajEnviar ?? 0,
      unidades: uniEnviar ?? 0,
      faltante,
      esCarton,
      cajonesSel: prevSel,
      pesoCajones: prevPeso,
      kg: prevKg,
      tandas: prevTandas,
      timestamp: Date.now()
    });
  } else {
    const buf = getBuffer();
    const key = `${tallerista}__${sector}__${descripcion}`;
    const bufIdx = buf.findIndex(b => `${b.tallerista}__${b.sector}__${b.descripcion}` === key);
    if (bufIdx >= 0){
      buf.splice(bufIdx, 1);
      saveBuffer(buf);
    }
  }
}

// Popup confirmación EnviosTall
function mostrarConfirmacionEnvioTall(items){
  return new Promise(resolve => {
    let overlay = document.getElementById("confirmEnvioTallOverlay");
    if (!overlay){
      overlay = document.createElement("div");
      overlay.id = "confirmEnvioTallOverlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2000;padding:16px";
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:14px;width:min(700px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden">
          <div style="background:#111;color:#fff;padding:14px 18px;font-weight:800;font-size:17px">Confirmar Envío</div>
          <div id="confirmEnvioTallBody" style="padding:14px 18px;overflow-y:auto;flex:1"></div>
          <div style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e5e7eb">
            <button id="confirmEnvioTallCancel" type="button" style="background:#fff;color:#111;border:2px solid #d0d7de;border-radius:10px;padding:10px 20px;font-weight:800;cursor:pointer;font-size:15px">Cancelar</button>
            <button id="confirmEnvioTallOk" type="button" style="background:#111;color:#fff;border:0;border-radius:10px;padding:10px 24px;font-weight:800;cursor:pointer;font-size:15px">✓ Confirmar Envío</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    const body = document.getElementById("confirmEnvioTallBody");
    const rows = items.map(it => {
      const caj = Number(it.cajones) || 0;
      const kg = parseDecimal(it.kg);
      const uni = Number(it.unidades) || 0;
      const cajCell = it.esCarton ? "—" : `<b>${caj}</b>`;
      const kgCell = it.esCarton ? "—" : `<b>${kg.toLocaleString('es-AR',{maximumFractionDigits:2})}</b>`;
      const uniCell = it.esCarton ? `<b>${uni}</b>` : "—";
      return `<tr>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.descripcionDisplay || it.descripcion)}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${escapeHtml(it.sector || "—")}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${cajCell}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${kgCell}</td>
        <td style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap">${uniCell}</td>
      </tr>`;
    }).join("");
    body.innerHTML = `
      <div style="font-weight:700;margin-bottom:10px;color:#555;font-size:15px;text-align:center">${items.length} artículo${items.length>1?'s':''} a <b style="color:#111">${escapeHtml(talleristaActivo)}</b></div>
      <div style="display:flex;justify-content:center">
        <table style="width:auto;border-collapse:collapse;font-size:16px;table-layout:auto">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Descripción</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Sector</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Cajones Enviados</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Kg Neto</th>
            <th style="padding:8px 14px;border:1px solid #d0d7de;text-align:center;white-space:nowrap;font-size:15px">Uni</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    overlay.style.display = "flex";
    const cleanup = () => { overlay.style.display = "none"; };
    document.getElementById("confirmEnvioTallOk").onclick = () => { cleanup(); resolve(true); };
    document.getElementById("confirmEnvioTallCancel").onclick = () => { cleanup(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay){ cleanup(); resolve(false); } };
  });
}

// Botón Limpiar — vacía todo lo cargado del tallerista actual
const btnLimpiarTall = document.getElementById("btnLimpiar");
if (btnLimpiarTall){
  btnLimpiarTall.addEventListener("click", () => {
    if (!talleristaActivo){ alert("Seleccioná un tallerista primero."); return; }
    const buf = getBuffer();
    const tieneAlgo = buf.some(b => b.tallerista === talleristaActivo && (
      Number(b.cajones) > 0 || Number(b.unidades) > 0 || parseDecimal(b.kg) > 0 ||
      (Array.isArray(b.tandas) && b.tandas.length > 0)
    ));
    if (!tieneAlgo){ alert("No hay nada cargado para limpiar."); return; }
    if (!confirm("¿Vaciar todo lo cargado para " + talleristaActivo + "? (cajones, kg, uni, tandas)")) return;
    const restante = buf.filter(b => b.tallerista !== talleristaActivo);
    localStorage.setItem(BUFFER_KEY, JSON.stringify(restante));
    actualizarBtnSiguiente();
    renderizarFilasFase1(txtFiltroArticulo ? txtFiltroArticulo.value : "");
  });
}

// Abre popup tandas para una fila tallerista (solo no-cartones)
function abrirTandasFilaTall(idx){
  const item = filasFiltradas[idx];
  if (!item || item.esCarton) return;
  const tallerista = item.tallerista || "";
  const sector = item.sector || "";
  const descripcion = item.descripcion || "";
  const descripcionDisplay = item.descripcionDisplay || descripcion;
  const buf = getBuffer();
  const key = `${tallerista}__${sector}__${descripcion}`;
  const bufIdx = buf.findIndex(b => `${b.tallerista}__${b.sector || ""}__${b.descripcion}` === key);
  let tandasIni = (bufIdx >= 0 && Array.isArray(buf[bufIdx].tandas)) ? buf[bufIdx].tandas : [];
  // Preload tanda 1 desde valores escritos a mano
  if (tandasIni.length === 0 && bufIdx >= 0){
    const caj = Number(buf[bufIdx].cajones) || 0;
    const kg = parseDecimal(buf[bufIdx].kg);
    if (caj > 0 || kg > 0) tandasIni = [{ caj, kg, uni: 0 }];
  }
  window.tandasPopup.open({
    titulo: `Tandas — ${descripcionDisplay}`,
    initial: tandasIni,
    pedirCaj: true,
    pedirKg: true,
    pedirUni: false,
    onConfirm: (tandas, totales) => {
      const buf2 = getBuffer();
      const bufIdx2 = buf2.findIndex(b => `${b.tallerista}__${b.sector || ""}__${b.descripcion}` === key);
      if (tandas.length === 0 && totales.caj === 0 && totales.kg === 0){
        if (bufIdx2 >= 0){
          buf2[bufIdx2].tandas = [];
          buf2[bufIdx2].cajones = 0;
          buf2[bufIdx2].kg = "";
          if (!Number(buf2[bufIdx2].unidades || 0)) buf2.splice(bufIdx2, 1);
          saveBuffer(buf2);
        }
      } else {
        const newItem = bufIdx2 >= 0 ? buf2[bufIdx2] : {
          tallerista, sector, descripcion, descripcionDisplay,
          unidades: 0, faltante: false, esCarton: false,
          cajonesSel: null, pesoCajones: 0
        };
        newItem.tandas = tandas;
        newItem.cajones = totales.caj;
        newItem.kg = totales.kg > 0 ? String(totales.kg) : "";
        if (bufIdx2 >= 0) buf2[bufIdx2] = newItem;
        else buf2.push(newItem);
        saveBuffer(buf2);
      }
      renderizarFilasFase1(txtFiltroArticulo ? txtFiltroArticulo.value : "");
    }
  });
}

// Persistir Kg Neto en el buffer (Fase 1 unificada — no-cartones)
function registrarKgFilaTall(row, rawValue){
  const idx = Number(row.dataset.filaIdx);
  const item = filasFiltradas[idx];
  if (!item) return;
  const tallerista = item.tallerista || "";
  const sector = item.sector || "";
  const descripcion = item.descripcion || "";
  const descripcionDisplay = item.descripcionDisplay || descripcion;
  const esCarton = item.esCarton;
  const num = parseDecimal(rawValue);
  const buf = getBuffer();
  const key = `${tallerista}__${sector}__${descripcion}`;
  const bufIdx = buf.findIndex(b => `${b.tallerista}__${b.sector}__${b.descripcion}` === key);
  if (bufIdx >= 0){
    buf[bufIdx].kg = num > 0 ? String(num) : "";
    saveBuffer(buf);
  } else if (num > 0){
    // No habia entrada (cajones aun no cargados), igual guardar kg
    addToBuffer({
      tallerista,
      sector,
      descripcion,
      descripcionDisplay,
      cajones: 0,
      unidades: 0,
      faltante: false,
      esCarton,
      cajonesSel: null,
      pesoCajones: 0,
      kg: String(num),
      timestamp: Date.now()
    });
  }
}

async function enviarCambios(volverLuego = false){
  if (!filasModificadas.size) return true;

  btnSiguiente.disabled = true;
  btnSiguiente.textContent = "Enviando...";

  const payload = Array.from(filasModificadas.values());
  console.log("Payload a insertar:", payload);

  const { data, error } = await supabaseClient
    .from(TABLA_DESTINO)
    .insert(payload)
    .select();

  if (error){
    console.error("Error al guardar cambios:", error);
    alert(
      "No se pudieron guardar los cambios.\n\n" +
      "Mensaje: " + (error.message || "") + "\n" +
      "Detalle: " + (error.details || "") + "\n" +
      "Hint: " + (error.hint || "")
    );
    btnSiguiente.disabled = false;
    btnSiguiente.textContent = "Enviar";
    return false;
  }

  console.log("Insert ok:", data);

  // Descontar SP Kg al enviar (agrupado por sector, en paralelo)
  const kgPorSector2 = new Map();
  payload.forEach(item => {
    const sec = String(item.Sector || "").trim();
    if (!sec || sec === "Sin sector" || !item.KG || item.KG <= 0) return;
    kgPorSector2.set(sec, (kgPorSector2.get(sec) || 0) + Number(item.KG));
  });

  if (kgPorSector2.size > 0) {
    await Promise.all([...kgPorSector2.entries()].map(async ([sector, kgTotal]) => {
      const { data: spData } = await supabaseClient
        .from("SP Kg")
        .select("\"Stock Inicial\"")
        .eq("Sp", sector)
        .maybeSingle();

      if (spData) {
        const stockActual = Number(spData["Stock Inicial"] || 0);
        const stockNuevo = Math.max(0, stockActual - kgTotal);
        await supabaseClient
          .from("SP Kg")
          .update({ "Stock Inicial": stockNuevo })
          .eq("Sp", sector);
      }
    }));
  }

  imprimirResumen(payload);

  // Mostrar toast deshacer con los ids insertados
  const ids = (data || []).map(r => r.id);
  mostrarToastDeshacer(ids, payload);

  // Limpiar cachés para que la próxima búsqueda recargue datos frescos
  consumosCache = null;
  sectoresCache = null;

  filasModificadas.clear();
  btnSiguiente.disabled = true; btnSiguiente.classList.add("disabled");
  btnSiguiente.disabled = false;
  btnSiguiente.textContent = "Enviar";

  if (volverLuego){
    talleristaActivo = "";
    resultEl.innerHTML = "";
    btnVolver.classList.add("hidden");
    renderTalleristas(listaTalleristas);
  } else if (talleristaActivo){
    buscar(talleristaActivo);
  }

  return true;
}

/*************************************************
 * IMPRESIÓN DE RESUMEN
 *************************************************/
function imprimirResumen(payload){
  if (!payload || !payload.length) return;

  const tallerista = payload[0]["Tallerista"] || "";
  const fecha = payload[0]["Dia-mes"] || getDiaMesHoy();

  // Separar items con datos de los faltantes-solo
  const itemsConDatos = [];
  const itemsFaltantes = [];
  payload.forEach(p => {
    const kg = Number(p["KG"] || 0);
    const caj = Number(p["Cajones"] || 0);
    const uni = Number(p["Unidades"] || 0);
    const falt = !!p["Faltante"];
    if (kg > 0 || caj > 0 || uni > 0) itemsConDatos.push(p);
    else if (falt) itemsFaltantes.push(p);
  });

  // Adapter: payload usa keys "Descripcion"/"Sector"; clasificarItem espera "descripcion"/"sector"
  const clasificarPrint = p => clasificarItem({ descripcion: p["Descripcion"] || "", sector: p["Sector"] || "" });
  let filas = "";
  GRUPOS_ORDEN.forEach(grupo => {
    const items = itemsConDatos.filter(p => clasificarPrint(p) === grupo);
    if (!items.length) return;
    filas += `<tr><td colspan="5" style="background:#222;color:#fff;font-weight:800;padding:6px 10px;text-transform:uppercase">${escapeHtml(grupo)}</td></tr>`;
    items.forEach(p => {
      const desc = escapeHtml(p["Descripcion"] || "");
      const kg = Number(p["KG"] || 0);
      const caj = Number(p["Cajones"] || 0);
      const uni = Number(p["Unidades"] || 0);
      const sec = escapeHtml(p["Sector"] || "");
      filas += `<tr><td>${sec}</td><td>${desc}</td><td>${kg ? kg.toLocaleString("es-AR",{maximumFractionDigits:1}) : ""}</td><td>${caj || ""}</td><td>${uni || ""}</td></tr>`;
    });
  });

  let faltHtml = "";
  if (itemsFaltantes.length){
    const nombres = itemsFaltantes.map(p => escapeHtml(p["Descripcion"] || "")).join(", ");
    faltHtml = `<div class="falt">Faltantes: ${nombres}</div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Envío - ${escapeHtml(tallerista)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;padding:16px 20px;font-size:18px}
.hdr{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #000;padding-bottom:8px;margin-bottom:12px}
.hdr b{font-size:24px}
.hdr span{font-size:18px;color:#333}
table{border-collapse:collapse;width:auto}
th,td{border:1.5px solid #333;padding:8px 12px;font-size:18px;white-space:nowrap}
th{background:#ddd;font-weight:700;text-align:center}
td:nth-child(1){text-align:left}
td:nth-child(2){text-align:left}
td:nth-child(n+3){text-align:right}
.falt{margin-top:10px;font-size:16px;color:#333;font-style:italic}
@media print{body{padding:10px}@page{margin:8mm}}
</style>
</head>
<body>
<div class="hdr"><b>${escapeHtml(tallerista)}</b><span>${escapeHtml(fecha)}</span></div>
<table>
<thead><tr><th>Sec</th><th>Descripción</th><th>Kg</th><th>Caj</th><th>Uni</th></tr></thead>
<tbody>${filas}</tbody>
</table>
${faltHtml}
</body>
</html>`;

  const printWin = window.open("", "_blank");
  if (!printWin){
    alert("No se pudo abrir la ventana de impresión. Habilitá los popups.");
    return;
  }
  printWin.document.write(html);
  printWin.document.close();
  printWin.onload = function(){
    printWin.print();
    printWin.onafterprint = function(){ printWin.close(); };
  };
}

btnSiguiente.addEventListener("click", enviarCambios);

if (txtFiltroArticulo){
  txtFiltroArticulo.addEventListener("input", () => {
    if (talleristaActivo && talleristaActivo !== "__TODOS__") {
      renderizarFilasFase1(txtFiltroArticulo.value);
    }
  });
}

/*************************************************
 * INICIO
 *************************************************/
cargarSectoresCrudoMartin().catch(() => {});
cargarTalleristas();
mostrarFase(1);
