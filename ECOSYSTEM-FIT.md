# Paperclip × La Colmena / Oficina de Jhonson — Reporte de Decisión de Incorporación

> Lead architect call. Decisivo, no descriptivo. Fecha: 2026-06-30.
> Insumo: análisis fase 1 (7 subsistemas de Paperclip) + cruce fase 2 contra los 8 componentes del ecosistema.

---

## 1. Veredicto en 1 párrafo

**Paperclip se ADOPTA como control-plane del ecosistema (la "capa-empresa"), con Hermes debajo como runtime vía el adapter `hermes_gateway` — NO se reemplaza Hermes, NO se reemplaza Latido como producto, y NO se migra genesis.** La decisión no es uniforme: es *adopción quirúrgica*. Paperclip es la implementación de producción, MIT, testeada (~100 migraciones, cientos de tests) de exactamente lo que el ecosistema marca como "lo difícil" y hoy hace a mano con cron-regex y races: checkout atómico (FOR UPDATE + execution locks), cola de wakeups con coalescing, budget hard-stop con pausa+cancel, governance/approvals durables, activity_log como audit trail, secret redaction. Donde el ecosistema está construyendo a mano un clon greenfield privado de esto (**cda-os**), seguir construyéndolo a mano es el peor uso de esfuerzo posible: cero diferenciación, máxima superficie de bug, ya existe la versión madura — ahí **se adopta y se deprecia el build propio**. Donde el ecosistema ya tiene un activo comercial desplegado y superior en su nicho (**Latido** con su odómetro real desde transcripts + ROI suscripción-vs-API; **dreams** con progress/stagnation/gate-HITL; **team-setup** con su árbol de decisión y model-routing; los 9 pilares anti-alucinación del harness), **se cherry-pickea el patrón** (esquema cost_events, getInvocationBlock, formato agentcompanies/v1, catalog.json+sha256) **sin tragarse el repo**. Y la opción "Paperclip-company-per-PyME como vehículo de producto multi-tenant" **NO es la evolución de genesis** (genesis es deliberadamente single-tenant instalado-en-cliente) sino el blueprint de una **línea SaaS futura distinta** — se archiva como tal, no se ejecuta hoy. En una frase: **Paperclip arriba como CEO de infraestructura, Hermes abajo como ejecutor, los productos propios (Latido/dreams/genesis) se quedan y le roban el motor a Paperclip donde Paperclip es mejor.**

---

## 2. Mapa de encaje

| Componente ecosistema | Qué hace Paperclip | Decisión | Valor |
|---|---|---|---|
| **Hermes (runtime, 11 profiles)** | Lo contrata como `agent` vía adapter `hermes_gateway` (built-in en fork HenkDz). Heartbeat de Paperclip reemplaza system-cron-tick + 17 tick-lines | **Complementar** — Paperclip arriba, Hermes abajo | 5/5 |
| **cda-os (SO multiagente CORE, privado)** | ES cda-os, pero maduro/MIT/testeado: org chart, ticketing atómico, governance, budget engine, portability | **Adoptar control-plane + deprecar build propio** | 5/5 |
| **command-center / LATIDO (cockpit + Consumo IA)** | Tiene Costs.tsx + cost_events/budget_policies/budget_incidents con hard-stop atómico que LATIDO no tiene | **Cherry-pick el MOTOR de budget; NO reemplazar el producto** | 3/5 |
| **Trabajo NVIDIA-free / Consumo IA VPS** | Separa `biller`/`provider`/`billingType` (metered vs subscription_included) + windowSpend 5h/24h/7d + quota-windows | **Cherry-pick esquema; portar getInvocationBlock como gate del gateway Hermes** | 4/5 |
| **dreams-system (north-stars→milestones)** | Goals estructurales-estáticos; SIN progress_pct, sin stagnation, sin gate-HITL de cierre | **Complementar** — dream→goal + lógica como plugin; NO migrar en primer corte | 3/5 |
| **genesis / colmena-kit (PyMEs, single-tenant)** | company-per-tenant + secret-scrubbing + bundle markdown/yaml portable | **Cherry-pick el patrón de portabilidad/scrubbing; NO migrar runtime** | 3/5 |
| **skills-ecosistema (sync PC↔VPS)** | catalog.json + sha256-por-archivo + contentHash + audit de drift | **Cherry-pick esquema hash/audit como capa sobre el repo** | 4/5 |
| **team-setup (armado de equipos)** | teams-catalog formato `agentcompanies/v1` (TEAM.md + AGENTS.md + requiredSkills) | **Cherry-pick formato como destino de salida; NO colapsar la skill** | 4/5 |
| **Harness SDD/LTR + 9 pilares + R0-R12 (mitad-A: infra)** | Ticketing/audit/approvals/locks/rollback/estado durable production-grade | **Adoptar control-plane** (la mitad-A) | 4/5 |
| **Harness — pilares de disciplina (mitad-B: anti-alucinación/caveman/pre-fetch)** | NO tiene equivalente; activity_log audita mutaciones, no calidad semántica | **NO adoptar — viaja en el prompt/skill del runtime, sobrevive intacta** | — |
| **jhonson_audit.py (auditoría de output 15min)** | activity_log audita mutaciones, NO calidad de output | **NO reemplazar — reconstruir como eval/promptfoo o plugin** | — |

---

## 3. Dónde incorporarlo — LOCAL (PC de Federico)

**Qué corre acá:** una instancia Paperclip **local-trusted** como banco de pruebas y cockpit de desarrollo — NUNCA producción.

- **Cómo:** `npx paperclipai onboard --yes` (sin `--bind`) → fuerza `local_trusted` / `loopback` (127.0.0.1), sin login, fricción cero. Usa la **Postgres embebida** (embedded-postgres@18, dataDir bajo `PAPERCLIP_HOME`, puerto 54329) — acá sí conviene la embebida, es desechable. Arranca en `localhost:3100` (UI servida estática por el server). Startup 30–60s; **ojo: vite build cuelga en NTFS**, usar el `dist/` pre-buildeado del paquete npm, no buildear en la PC.
- **Para qué:**
  1. **Validar el adapter `hermes_gateway`** apuntando al Hermes del VPS por Tailscale antes de tocar prod. Conectar 1 profile (kira) como `agent` y disparar un heartbeat manual.
  2. **Diseñar/probar plugins** (Dreams-as-dashboardWidget, LATIDO-as-plugin) con `@paperclipai/plugin-sdk` + `/dev-server` (hot-reload SSE) sin riesgo.
  3. **Prototipar el formato `agentcompanies/v1`** como destino de salida de `team-setup`: emitir un team package y validarlo con `build:manifest` + `validate-catalog`.
  4. **Probar el esquema cost_events/budget_policies** con datos sintéticos para decidir qué robar para LATIDO.
- **Lo que NO hace local:** no es fuente de verdad de nada. Es sandbox. Su Postgres embebida se tira y se rehace.

---

## 4. Dónde incorporarlo — VPS

**El VPS (Ubuntu sin GPU, ya con Hermes API-server + Supabase + Traefik/nginx + Tailscale) es el encaje casi ideal de la receta de despliegue de Paperclip.**

- **Self-host recomendado (receta concreta):**
  - `bind=loopback` (127.0.0.1) **detrás del Traefik/nginx que ya corre** — NO exponer Paperclip directo.
  - `PAPERCLIP_PUBLIC_URL=https://paperclip.oficinadejhonson.com` (deriva auth base URL + callbacks + hostname allowlist).
  - `authenticated` + `private` (Better Auth, `BETTER_AUTH_SECRET` obligatorio); primer admin vía "Claim this instance" desde el browser tras login.
  - **`DATABASE_URL` apuntando a la Postgres de Supabase** — apagar embedded-postgres en prod (`database.mode=postgres`). Validar antes: migraciones Drizzle aplicándose limpio sobre Supabase (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`) y que el RLS de Supabase no choque con el filtrado por `companyId` de Paperclip.
  - Arrancar como **Podman Quadlet rootless** (`systemctl --user`) o `docker-compose.yml` **sin** el servicio `db` (usás Supabase).
  - **Tailnet:** el bind tailnet de Paperclip (`tailscale ip -4`) es opcional acá — como va detrás de Traefik con loopback, no hace falta; pero el adapter `hermes_gateway` SÍ usa la red Tailscale PC↔VPS para que la instancia local hable con el Hermes del VPS en los pilotos.

- **¿Hermes como adapter?** **Sí, vía `hermes_gateway` (no `hermes_local`).** El VPS ya corre Hermes como API server (`API_SERVER_ENABLED`); el gateway hace `POST /v1/runs` + stream SSE estructurado — mucho más robusto que el parseo de stdout por regex de `hermes_local`. Cada uno de los 11 profiles = un `agent` Paperclip con `adapterType=hermes_gateway`, `reportsTo` modelando el org chart (jhonson/bakugo arriba). **Riesgo #1 a cerrar antes:** apagar el `system-cron-tick` + las 17 tick-lines de Hermes para evitar **scheduling split-brain** (doble disparo → doble gasto). Hermes queda en modo puro-API sin auto-fire; Paperclip es el único scheduler.

- **¿Reemplaza command-center / LATIDO?** **NO.** Latido es producto desplegado y vendible (MIT, tiers Stripe, SDK, GTM por CDA) y su odómetro desde transcripts + ROI es mejor que el de Paperclip en ese nicho. Paperclip y LATIDO **coexisten**: Paperclip aporta el **enforcement** (hard-stop que LATIDO no tiene), LATIDO sigue siendo el cockpit de cara al cliente. Camino limpio: montar la vista financiera de Paperclip como dato/plugin y dejar que LATIDO consuma `budgets/overview` + `costs/by-*`, o robar el esquema a Supabase. **No se mata el producto por una feature.**

---

## 5. El golpe estratégico

**El mayor valor NO es un solo producto — es eliminar el build greenfield más caro y menos diferenciado del ecosistema (cda-os) y reemplazarlo por un control-plane maduro, dejando a los productos propios robarle el motor donde Paperclip gana.**

Tres golpes, en orden de impacto:

1. **Deprecar cda-os antes de que consuma más esfuerzo.** Es el único lugar del cruce donde "adoptar" no es opinable. Re-implementar a mano org chart + ticketing atómico + heartbeat durable + governance + budget engine = meses para llegar a un *subset* de lo que Paperclip da gratis hoy, y arriesgando reinventar **mal** el checkout atómico (la parte difícil). El sunk cost es bajo (cda-os está poco instanciado). Esto libera el mayor bloque de esfuerzo de ingeniería del ecosistema.

2. **Cerrar el agujero de runaway-cost en tiempo real, justo cuando entra CODEX metered.** El incidente documentado (OpenRouter HTTP 402 tumbó TODA la flota Hermes en silencio) es exactamente la clase de falla que el `getInvocationBlock` + hard-stop + governance de Paperclip convierte de *caída silenciosa de 10 perfiles* en *incidente enforzado y visible con approval*. Robar el esquema `cost_events`(biller/provider/billingType) + portar el gate al gateway de Hermes es el cherry-pick de mayor ROI.

3. **El blueprint multi-tenant para una eventual línea SaaS-central de PyMEs** (NO genesis, que es single-tenant a propósito). Si en el futuro Oficina de Jhonson lanza "PyMEs hosteadas en mi nube", Paperclip-company-per-PyME + company-portability + secret-scrubbing es el vehículo correcto de esa **nueva línea**. Se archiva como activo estratégico, no se ejecuta hoy. Y CODEX/OpenClaw/Hermes como adapters intercambiables dan la flexibilidad de runtime que ese producto necesitaría.

---

## 6. Plan ordenado por fases

> Estilo migración Hermes: gradual, reversible, gates humanos. Vehículo: skill `/migrar-harness` (esta vez **Hermes-scheduling → Paperclip-scheduling**, NO Hermes→otro-runtime). Trackear como `/dream`.

**FASE 0 — Setup local (sandbox, sin riesgo). Gate: humano valida que arranca.**
- Instancia Paperclip local-trusted en la PC (Postgres embebida, `dist/` pre-buildeado, no buildear en NTFS).
- Conectar 1 profile Hermes del VPS (kira) vía `hermes_gateway` por Tailscale.
- Disparar un heartbeat manual y verificar que captura usage/cost/sesión.

**FASE 1 — Piloto VPS con 1–2 profiles en PARALELO. Gate: 2–4 semanas corriendo sin pisar prod.**
- Montar Paperclip en VPS (bind=loopback + authenticated/private + `DATABASE_URL`→Supabase + detrás de Traefik). Validar migraciones Drizzle sobre Supabase ANTES.
- Conectar kira (+ opcionalmente bond) como `agent` con `hermes_gateway`. **Hermes sigue con su scheduling nativo para el resto de profiles** — Paperclip solo orquesta los pilotos.
- **NO TOCAR:** los otros 9 profiles, sus crons/tick-lines, LATIDO, dreams, genesis, el routing free NVIDIA/OpenRouter.
- Correr en paralelo a cda-os/LATIDO. Comparar audit trail y captura de costo.

**FASE 2 — Cherry-picks de bajo riesgo (independientes de la decisión grande). Gate: cada uno valida solo.**
- Robar esquema `cost_events`+`budget_policies`+`budget_incidents` a Supabase como backend de la vista "Consumo IA" de LATIDO.
- Portar `getInvocationBlock` como gate del gateway de modelos de Hermes (`llm_local.py` + config por perfil) — cierra el agujero runaway-cost.
- Adoptar `catalog.json`+sha256+audit-de-drift como capa sobre skills-ecosistema (cierra el gap PC↔VPS).
- Hacer que `team-setup` **emita** `agentcompanies/v1` como salida adicional (sin colapsar el árbol de decisión).

**FASE 3 — Migrar el scheduling de Hermes → Paperclip (el corte real). Gate: humano por profile.**
- Profile por profile: mover su cron/tick-line a `routines` + `heartbeat` de Paperclip; **apagar su tick nativo** (matar split-brain). Empezar por internos (kira/bakugo), terminar por los de cara a negocio.
- Re-expresar Reviewer-único-gate como `approval`/child-issue; spec EARS como `issue-document`.
- **Re-inyectar la mitad-B explícitamente:** los 9 pilares anti-alucinación/anchors/pre-fetch como catalog skills + evals (promptfoo bundle). Si no, se pierde la joya del harness.
- Reconstruir `jhonson_audit.py` (auditoría de output) como eval/plugin — Paperclip NO lo tiene.

**FASE 4 — Deprecar cda-os + consolidar. Gate: control-plane estable 2–4 semanas.**
- Una vez Paperclip orquesta todos los profiles con gobernanza/budget/audit, **deprecar el build de cda-os**: pasa de "build" a "instancia configurada de Paperclip + nuestra doctrina inyectada como skills/governance".
- Montar Dreams como plugin (dashboardWidget + cron job + gate de cierre sobre approvals) **solo si** el control-plane ya está consolidado. Dreams es lo último — es donde La Colmena es más rica que Paperclip.

**FASE 5 — (Opcional, futuro) Línea SaaS-central PyMEs.** Evaluar Paperclip-company-per-PyME como vehículo de un producto NUEVO, distinto de genesis. Solo si hay demanda real.

**Qué NO tocar de prod durante todo el plan:** el runtime Hermes y sus 8 providers + routing free (NVIDIA NIM/OpenRouter:free/qwen-CODEX); Latido como producto; genesis single-tenant y el cliente craneo-lrossi en vuelo; Supabase como fuente de verdad de LATIDO/dreams; los SOUL.md y la integración Discord de Hermes.

---

## 7. Riesgos y trade-offs honestos

1. **Fricción de datos Supabase vs Postgres+Drizzle (riesgo permanente).** El ecosistema es Supabase-first con RLS por tabla (R2); Paperclip aísla por **columna `companyId`, NO por RLS**. Apuntar `DATABASE_URL` a la Postgres de Supabase es factible pero hay que validar migraciones Drizzle + aceptar que el aislamiento depende de que el código filtre siempre. Riesgo de drift entre LATIDO (Supabase) y el cockpit Paperclip. Choca con "si no está en Supabase, no pasó".
2. **Lock-in al FORK.** El adapter Hermes vive en `HenkDz/paperclip` (rama `feat/externalize-hermes-adapter`), no en upstream Paperclip Labs. El soporte de adapters externos/plugin (que evitaría forkear, PR #2218) **no está terminado** — hay que ir por el camino built-in, que ata al fork. Mantener un fork de un control-plane de ~150 services es caro si upstream avanza. MIT mitiga (se puede forkear), pero el costo de mantenimiento es real.
3. **Segunda migración en ~6 semanas.** El ecosistema migró OpenClaw→Hermes hace 11 días; Hermes recién se asentó (Fugu ni activo). Riesgo de fatiga/destabilización. Mitigación: piloto con 1 profile, nunca big-bang.
4. **Telemetría / madurez.** OpenTelemetry es opt-in (no on-by-default — bien). Pero los 7 ejes que importan a futuro (Memory, MAXIMIZER, Deep Planning, Self-Org, Org-Learning, CEO Chat, Cloud agents) están **TODOS en ⚪ roadmap, cero código** — solo Memory y CEO Chat tienen diseño escrito. El README dice "directional, not promised". **No comprar que "ya viene".**
5. **Enforcement de budget incompleto.** Solo por `billed_cents` (no por tokens), ventanas `calendar_month_utc`/`lifetime` (no rolling-30d), cap diario en OTRO sistema (heartbeat policy ≠ budget_policies = dos sistemas de límite paralelos), y **confía en el self-report del agente** (no audita contra el proveedor real). El cherry-pick no cura esto — hay que cruzar con quota-windows.
6. **Esfuerzo de extender el motor.** `heartbeat.ts` es un monolito de 12.5k líneas — curva alta. Parseo de stdout de Hermes por regex (frágil) → preferir `hermes_gateway`/SSE. Invariante no-remote-git (auditar que ningún flujo empuje a git entre latidos — bajo riesgo porque la doctrina ya manda estado a Supabase).
7. **Configs de Hermes no en git.** Hoy viven en disco (`/opt/hermes-eval`, backups manuales). Hay que decidir fuente de verdad de la config por profile y reconciliar con company-portability (markdown+yaml versionable).

---

## 8. Qué NO adoptar (dónde el build propio gana)

- **NO reemplazar Hermes por un runtime nativo de Paperclip** (claude_local/codex_local). Se perderían los 8 providers + el routing free (NVIDIA NIM/OpenRouter:free) que el ecosistema acaba de consolidar como pilar de costo-cero. Paperclip ARRIBA, Hermes ABAJO — disciplina innegociable.
- **NO reemplazar Latido como producto.** Su odómetro real desde transcripts de Claude Code, el ROI suscripción-vs-API, y el cálculo free-vs-metered son mejores que Paperclip en ese nicho, y Latido es un activo comercial desplegado (MIT, tiers, SDK, GTM). Robar el motor de budget, no matar el producto.
- **NO migrar genesis a Paperclip.** genesis es single-tenant instalado-en-cliente a propósito (`GENESIS_HOME=/opt/genesis-<id>`, corre en infra del cliente con sus credenciales). Paperclip-company-per-PyME es un PIVOTE de negocio (SaaS-central), no la evolución de genesis. Rompería el pitch y el diferenciador cero-fricción (.pyz vía GLM sin Node/Postgres) justo para el cliente que NO tiene toolchain (Dos Hache). Solo robar el patrón de portabilidad/scrubbing.
- **NO migrar las skills propias "a Paperclip" como destino primario.** Varias traen scripts ejecutables (graphify .py, dame, lint-skills.js, montar-web) y la regla de seguridad de Paperclip **prohíbe importar skills con `scripts_executables` de fuentes externas** — solo first-party bundled. Robar el formato y el esquema hash/audit, no la maquinaria del Skills Store.
- **NO colapsar `team-setup` a un TEAM.md estático.** Perdería el árbol de decisión (2A–2I), las preguntas FASE 0, la regla de costos de modelos y el scaffolding del arnés local. Que EMITA `agentcompanies/v1`, no que se reemplace.
- **NO migrar dreams en el primer corte.** Es donde La Colmena es MÁS rica que Paperclip (progress_pct, stagnation, gate-HITL de cierre que prohíbe auto-promoción al 100%). Paperclip no tiene equivalente. Mantenerlo en Supabase; montarlo como plugin solo cuando el control-plane esté consolidado.
- **NO descartar los pilares de disciplina del harness (mitad-B).** Anti-alucinación, caveman, pre-fetch, anchors NO son automáticos en Paperclip; `activity_log` audita mutaciones, no calidad semántica del output. Sobreviven en el prompt/skill del runtime — pero hay que re-inyectarlos explícitamente como skills+evals o se pierde el diferencial. `jhonson_audit.py` (auditoría de output 15min) y el self-improving loop (error recurrente→regla) NO tienen equivalente: reconstruir como eval/plugin.
