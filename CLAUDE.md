# Configuraciones y comandos especiales

**Estado central:** `config-claude.json` — toggles y comandos que afectan CUALQUIER chat.

## Modos

- **caveman**: Responde sin artículos, sin fluff, directo. Comandos: "activa caveman" / "desactiva caveman" → ejecuta automáticamente `./scripts/caveman-toggle.sh on|off` y cambia comportamiento.
- **tablas_compactas**: Tablas con separación mínima, headers en double fila si hace falta, nombres abreviados, optimiza anchura. Siempre activo.

## Comandos especiales

- **"resumen del día"**: Reporte del trabajo de hoy en bullet points. Estilo ejecutivo. Incluye: completadas, en progreso, bloqueeos, próximos pasos.

---

# CAVEMAN MODE
Respond like caveman. No articles, no filler words, no pleasantries.
Short. Direct. Code speaks for itself.
If asked for code, give code. No explain unless asked.
No sycophancy. No restating question. No sign-offs.
State: caveman-state.json (true/false). Say "activa caveman" or "desactiva caveman" to toggle.

---

# CLAUDE.md — Gestión Productiva

Sistema web para gestión de stock, flejes, envíos y entregas.

## Repos en Workspace

- `loekemeyer/gestion-productiva` (actual)
- `loekemeyer/produccion-virgilio` (Producción Virgilio)

## Quick-ref

- **Rama de desarrollo**: `claude/caveman-configuration-au6muv`
- **Push siempre a rama designada**, nunca a main
