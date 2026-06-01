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
const fase2 = document.getElementById("fase2");
const fase3 = document.getElementById("fase3");
const btnSiguiente = document.getElementById("btnSiguiente");
const btnVolverFase1 = document.getElementById("btnVolverFase1");
const btnEnviar = document.getElementById("btnEnviar");
const btnImprimir = document.getElementById("btnImprimir");
const fase2TableBody = document.getElementById("fase2TableBody");
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
  renderTalleristas([nombre]);
  btnVolver.classList.remove("hidden");
  if (txtFiltroArticulo) { txtFiltroArticulo.value = ""; }
  if (filtroArticuloWrap) { filtroArticuloWrap.classList.remove("hidden"); }
  buscar(nombre);
}

async function volverALista(){
  talleristaActivo = "";
  resultEl.innerHTML = "";
  btnVolver.classList.add("hidden");
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
async function cargarEnviosParaCalculo(){
  const { data, error } = await supabaseClient
    .from("Envios a Talleristas")
    .select("*")
    .limit(20000);
  if (error){ console.error(error); return []; }
  return data || [];
}

async function cargarEntregasParaCalculo(){
  const [respEnt, respPartes] = await Promise.all([
    supabaseClient.from("Entregas Tallerista Virgilio").select("*").limit(20000),
    supabaseClient.from("Partes x Tallerista").select("*").limit(20000)
  ]);
  if (respEnt.error){ console.error(respEnt.error); return { entregas: [], partes: [] }; }
  if (respPartes.error){ console.error(respPartes.error); return { entregas: [], partes: [] }; }
  return { entregas: respEnt.data || [], partes: respPartes.data || [] };
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
    const trigger = row.querySelector('[data-caj-trigger]');
    const box = row.querySelector(".faltante-box");

    if (trigger){
      trigger.addEventListener("click", () => {
        const idx = Number(row.dataset.filaIdx);
        const item = filasFiltradas[idx];
        if (!item) return;
        const bufKey = `${item.tallerista}__${item.sector || ""}__${item.descripcion}`;
        const bufItem = getBuffer().find(b => `${b.tallerista}__${b.sector || ""}__${b.descripcion}` === bufKey);
        const initial = (bufItem && bufItem.cajonesSel) || {};
        cajonesPopup.open({
          titulo: `Cajones — ${item.descripcionDisplay || item.descripcion}`,
          initial: initial,
          onConfirm: (sel, totalCaj, pesoTotal) => {
            // Persistir en row + buffer
            row.dataset.cajones = totalCaj;
            row.dataset.pesoCajones = pesoTotal;
            if (totalCaj > 0){
              trigger.classList.add("has-sel");
              trigger.innerHTML = `${totalCaj} caj<span class="sub">${pesoTotal.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span>`;
            } else {
              trigger.classList.remove("has-sel");
              trigger.innerHTML = '📦 Cargar';
            }
            actualizarFaltanteRow(row, true);
            registrarCambioFila(row, sel, totalCaj, pesoTotal);
          }
        });
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
      rows += `<tr class="grupo-header"><td colspan="6">${escapeHtml(grupo)}</td></tr>`;
    }
    const bufKey = `${item.tallerista}__${item.sector || ""}__${item.descripcion}`;
    const bufItem = getBuffer().find(b => `${b.tallerista}__${b.sector || ""}__${b.descripcion}` === bufKey);
    const bufCajVal = bufItem ? Number(bufItem.cajones) : 0;
    const bufUniVal = bufItem ? (bufItem.unidades || "") : "";
    const bufPesoCaj = bufItem ? Number(bufItem.pesoCajones || 0) : 0;

    const triggerCls = bufCajVal > 0 ? 'cajpop-trigger has-sel' : 'cajpop-trigger';
    const triggerLabel = bufCajVal > 0
      ? `${bufCajVal} caj<span class="sub">${bufPesoCaj.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span>`
      : '📦 Cargar';

    const cajCell = item.esCarton
      ? `<td class="right"><span class="zero">—</span></td>`
      : `<td class="right"><button type="button" class="${triggerCls}" data-caj-trigger data-fila-idx-trigger="${index}">${triggerLabel}</button></td>`;

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
              <th class="right"><span class="th-wrap">Uni</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="zero" style="text-align:center;padding:16px">Sin resultados para "${escapeHtml(filtro)}"</td></tr>`}
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

btnSiguiente.addEventListener("click", () => {
  const buf = getBuffer();
  if (!buf.length){
    alert("Selecciona al menos un artículo con cajones para enviar");
    return;
  }
  renderizarFase2();
  mostrarFase(2);
});

btnVolverFase1.addEventListener("click", () => {
  mostrarFase(1);
});

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
    const pesoCaj = Number(item.pesoCajones) || 0;
    const kgNetoStored = item.kg ? parseDecimal(item.kg) : 0;
    const kgBruto = Number(item.kgBruto) || (kgNetoStored ? kgNetoStored + pesoCaj : 0);
    const kgNeto = Math.max(0, kgBruto - pesoCaj);
    const cajCell = esCarton
      ? `<td class="right"><span class="zero">—</span></td>`
      : `<td class="right"><b>${item.cajones}</b><br><span class="kg-caj-sub">${pesoCaj.toLocaleString('es-AR',{maximumFractionDigits:2})} kg</span></td>`;
    const cantCell = esCarton
      ? `<td class="right" style="font-weight:700;color:#111;">${Number(item.unidades)} <small style="color:#666;font-weight:400;">uni</small></td>`
      : `<td class="right"><input type="text" inputmode="decimal" class="cell-input input-kg-fase2" data-buf-idx="${bufIdx}" placeholder="0,0" value="${kgBruto ? formatNumKgEt(kgBruto) : ''}" autocomplete="off"></td>`;
    const netoCell = esCarton
      ? `<td class="right"><span class="zero">—</span></td>`
      : `<td class="right kg-neto-cell" data-buf-idx="${bufIdx}"><b>${kgNeto ? formatNumKgEt(kgNeto) : '—'}</b></td>`;
    return `
    <tr data-buf-idx="${bufIdx}" data-es-carton="${esCarton ? '1' : '0'}">
      <td>${escapeHtml(item.tallerista)}</td>
      <td>${escapeHtml(item.sector || "")}</td>
      <td class="descripcion-cell">${escapeHtml(item.descripcionDisplay || item.descripcion)}</td>
      ${cajCell}
      ${cantCell}
      ${netoCell}
      <td class="center"><button type="button" class="btn-quitar-fase2" data-buf-idx="${bufIdx}">✕</button></td>
    </tr>`;
  }).join("");

  // Event listeners para inputs de Kg Bruto en Fase 2 (calcula Neto + persiste neto en buffer.kg)
  fase2TableBody.querySelectorAll(".input-kg-fase2").forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^0-9,.\-]/g, "");
      const idx = Number(input.dataset.bufIdx);
      const buf = getBuffer();
      if (buf[idx]) {
        const bruto = parseDecimal(input.value);
        const pesoCaj = Number(buf[idx].pesoCajones) || 0;
        const neto = Math.max(0, bruto - pesoCaj);
        const cell = fase2TableBody.querySelector(`.kg-neto-cell[data-buf-idx="${idx}"] b`);
        if (cell) cell.textContent = neto ? formatNumKgEt(neto) : '—';
      }
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
  // Sincronizar valores de los inputs al buffer antes de validar (por si el user presionó Enviar sin blur)
  const bufSync = getBuffer();
  fase2TableBody.querySelectorAll(".input-kg-fase2").forEach(input => {
    const idx = Number(input.dataset.bufIdx);
    if (bufSync[idx]) bufSync[idx].kg = input.value.trim();
  });
  localStorage.setItem(BUFFER_KEY, JSON.stringify(bufSync));

  const buf = getBuffer();
  const itemsConCaj = buf.filter(b =>
    b.tallerista === talleristaActivo &&
    (Number(b.cajones) > 0 || Number(b.unidades) > 0)
  );

  // Validar que todos los NO-cartones tengan Kg
  const faltanKg = itemsConCaj.filter(b => !b.esCarton && !(parseDecimal(b.kg) > 0));
  if (faltanKg.length){
    alert("Por favor ingresa Kg para todos los artículos");
    return;
  }

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
      kg: "",
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
