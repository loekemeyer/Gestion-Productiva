// Versión global de la app. Cambiar acá actualiza todas las pantallas que lo muestren.
window.APP_VERSION = "v1.0.0";

// Inyecta la versión en cualquier elemento con id="appVersion"
document.addEventListener("DOMContentLoaded", function () {
  var el = document.getElementById("appVersion");
  if (el) el.textContent = window.APP_VERSION;
});
