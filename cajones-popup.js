/*
  cajones-popup.js — utility compartida para seleccionar cajones (tipo + cantidad).
  Uso:
    cajonesPopup.open({
      initial: { 1: 0, 3: 2, ... },           // selección inicial (opcional)
      titulo: "Cajones del envío",            // opcional
      onConfirm: (sel, totalCaj, pesoTotal) => { ... }
    });

  Devuelve via callback:
    sel         — objeto { numero: cantidad }
    totalCaj    — suma de cantidades
    pesoTotal   — suma de (cantidad × peso_kg) en kg

  Lee de Supabase peso_cajones (cachea en memoria + localStorage 24hs).
*/
(function() {
  'use strict';

  const CACHE_KEY = 'cajpop_pesos_v1';
  const CACHE_TTL_MS = 24 * 3600 * 1000;
  let pesosCache = null;
  let overlayEl = null;
  let currentCallback = null;
  let currentSel = {};

  // Lee pesos desde Supabase (asume window.supabase + URL/KEY en sessionStorage).
  // Cada página debe haber creado su cliente — usamos el primero que encontremos.
  async function cargarPesos(supabaseClient) {
    if (pesosCache) return pesosCache;
    // Intentar cache localStorage
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.ts && (Date.now() - obj.ts) < CACHE_TTL_MS && obj.data) {
          pesosCache = obj.data;
          return pesosCache;
        }
      }
    } catch (e) { /* ignore */ }
    // Fetch fresh
    const { data, error } = await supabaseClient.from('peso_cajones').select('numero, peso_kg').order('numero');
    if (error) throw error;
    pesosCache = (data || []).map(r => ({
      numero: Number(r.numero),
      peso: Number(r.peso_kg) || 0
    }));
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: pesosCache }));
    } catch (e) { /* ignore */ }
    return pesosCache;
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'cajpop-overlay hidden';
    overlayEl.innerHTML = `
      <div class="cajpop-box">
        <div class="cajpop-head">
          <h3 id="cajpop-titulo">Cajones</h3>
          <button class="cajpop-close" type="button" aria-label="Cerrar">✕</button>
        </div>
        <div class="cajpop-body">
          <table class="cajpop-table">
            <thead>
              <tr><th>N° Cajón</th><th>Peso (kg)</th><th>Cantidad</th></tr>
            </thead>
            <tbody id="cajpop-tbody"></tbody>
          </table>
        </div>
        <div class="cajpop-foot">
          <div class="cajpop-totals">
            <span>Total cajones: <b id="cajpop-totcaj">0</b></span>
            <span>Peso total: <b id="cajpop-totpeso">0,00</b> kg</span>
          </div>
          <div class="cajpop-actions">
            <button class="cajpop-btn cajpop-cancel" type="button">Cancelar</button>
            <button class="cajpop-btn cajpop-ok" type="button">Confirmar</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlayEl);
    overlayEl.querySelector('.cajpop-close').onclick = cerrar;
    overlayEl.querySelector('.cajpop-cancel').onclick = cerrar;
    overlayEl.querySelector('.cajpop-ok').onclick = confirmar;
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) cerrar();
    });
    return overlayEl;
  }

  function renderRows() {
    const tbody = document.getElementById('cajpop-tbody');
    tbody.innerHTML = pesosCache.map(c => {
      const qty = Number(currentSel[c.numero] || 0);
      const val = qty > 0 ? qty : '';
      return `
        <tr data-num="${c.numero}">
          <td><b>${c.numero}</b></td>
          <td>${c.peso.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
          <td><input type="number" min="0" step="1" class="cajpop-qty" value="${val}" placeholder="0" data-num="${c.numero}"></td>
        </tr>
      `;
    }).join('');
    tbody.querySelectorAll('.cajpop-qty').forEach(input => {
      input.addEventListener('input', () => {
        const num = Number(input.dataset.num);
        const val = Math.max(0, Math.floor(Number(input.value) || 0));
        currentSel[num] = val;
        actualizarTotales();
      });
    });
    actualizarTotales();
  }

  function calcularTotales() {
    let totCaj = 0, totPeso = 0;
    pesosCache.forEach(c => {
      const q = Number(currentSel[c.numero] || 0);
      if (q > 0) {
        totCaj += q;
        totPeso += q * c.peso;
      }
    });
    return { totCaj, totPeso };
  }

  function actualizarTotales() {
    const { totCaj, totPeso } = calcularTotales();
    document.getElementById('cajpop-totcaj').textContent = totCaj;
    document.getElementById('cajpop-totpeso').textContent = totPeso.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function cerrar() {
    if (overlayEl) overlayEl.classList.add('hidden');
    currentCallback = null;
    currentSel = {};
  }

  function confirmar() {
    const { totCaj, totPeso } = calcularTotales();
    // Limpiar selecciones con qty=0
    const limpio = {};
    Object.keys(currentSel).forEach(k => { if (currentSel[k] > 0) limpio[k] = currentSel[k]; });
    if (typeof currentCallback === 'function') {
      currentCallback(limpio, totCaj, totPeso);
    }
    cerrar();
  }

  async function open(opts) {
    opts = opts || {};
    // Cliente Supabase: lo busca en window
    const sb = opts.supabase || window.__sbClient__ || (function() {
      // intento de descubrir un cliente existente
      const k = Object.keys(window).find(k => window[k] && typeof window[k].from === 'function' && typeof window[k].rpc === 'function');
      return k ? window[k] : null;
    })();
    if (!sb) {
      alert('No hay cliente Supabase disponible para el popup de cajones');
      return;
    }
    try {
      await cargarPesos(sb);
    } catch (e) {
      alert('Error cargando pesos de cajones: ' + (e.message || e));
      return;
    }
    ensureOverlay();
    currentCallback = opts.onConfirm || null;
    currentSel = Object.assign({}, opts.initial || {});
    document.getElementById('cajpop-titulo').textContent = opts.titulo || 'Cajones';
    renderRows();
    overlayEl.classList.remove('hidden');
  }

  // Format helper expuesto por conveniencia
  function formatBtnLabel(totalCaj, pesoTotal) {
    if (!totalCaj) return '📦 0 caj';
    return `📦 ${totalCaj} caj (${pesoTotal.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} kg)`;
  }

  window.cajonesPopup = { open, formatBtnLabel };
})();
