# Tools bajo demanda (`lazyTools`)

## Problema

Cada llamada al modelo manda todas las tools del bot. En producción se midieron 68 tools y 48.7 KB (~12k tokens) incluso para "hola", con 29–39k tokens de input por mensaje trivial.

## Inventario (offline)

`pnpm dlx tsx scripts/tool-inventory.ts [--lazy] [--json]` desde `templates/bot` (Node 24, sin red). Importa los módulos reales: tools propias, incluidas las dinámicas, que se evalúan como un usuario normal de su chat; extensión browser con sus overrides; built-ins de eve y memoria. Mide el JSON `{name, description, input_schema}` de cada tool. `eve__search/tool/skill` y los peers se estiman con textos de `eve/dist` y una entrada típica del directorio, con 8 peers (`PEERS=n`).

## Guard CI de presupuesto

`pnpm check:context-budget` ejecuta el inventario offline para los tres niveles (`off`, `on` y `core`) y suma los schemas/descripciones de las tools presentes al tamaño de las instrucciones de sistema y la guía del navegador. Usa ocho peers sintéticos, no llama a ningún proveedor y no lee secretos. El resultado se compara con los techos explícitos de `templates/bot/scripts/context-budget-baseline.json`; cualquier crecimiento falla.

Actualizar un techo requiere una decisión visible y el comando dedicado `pnpm update:context-budget`, que vuelve a medir y reescribe ese archivo. El job `test-bot` de CI ejecuta el guard antes de los tests cuando el plan selecciona el template del bot. La prueba de regresión también verifica que las mediciones repetidas sean idénticas y que se incluyan tools dinámicas.

El snapshot histórico con el flag apagado fue **63 tools en el prompt, 36,954 B (~9.2k tok)**, más 14 browser tools que la extensión ya difiere. La diferencia con los 48.7 KB de producción viene del encuadre por tool del provider, de los peers reales y de los campos que agrega eve. Por eso conviene leer las proporciones, no los absolutos; para el estado actual, el guard y su baseline son la fuente de verdad.

| Grupo | Tools | Bytes |
| --- | --: | --: |
| browser (en el prompt) | 26 | 12,987 |
| core (plan, files, history, login, fireside, suggest, propose_skill, send_file) | 9 | 7,479 |
| eve (bash, read/write_file, web_fetch, web_search, agent) | 6 | 4,876 |
| code tasks | 5 | 3,971 |
| peers (est., 8) | 8 | 2,416 |
| skills (find/preview/install) | 3 | 1,781 |
| routines | 1 | 1,452 |
| eve catalog (est.) | 3 | 1,353 |
| memory | 2 | 639 |

Top 10: `manage_plan` 2186, `read_file` 1525, `manage_routines` 1452, `browser__open` 1290, `propose_skill` 1265, `browser__screenshot` 1232, `browser__snapshot` 1201, `web_fetch` 1177, `start_code_task` 1106, `write_file` 1007.

## Diseño

Flag `"lazyTools": true` en `agent/config.json`. Por defecto es `false`, así que se puede activar por bot para hacer A/B. Con el flag activo, los grupos `browser`, `code`, `routines` y `skills` (`agent/lib/lazy-tools.ts`) empiezan **diferidos**: siguen en el catálogo de eve y se pueden llamar con `eve__search` y `eve__tool`, pero no ocupan el prompt.

- Una tool liviana, `enable_tools({ groups })`, cuyo texto lista los grupos, los habilita **nativos** desde el siguiente paso y por el resto de la sesión. También se habilita un grupo si cualquiera de sus tools ya se usó vía `eve__tool`.
- El estado se deriva de `ctx.view` (`calls()`): no hay estado propio, sobrevive a reinicios y replays y no depende de memos. Si la vista ya no conserva la llamada, el modelo vuelve a llamar `enable_tools`, que no tiene efectos secundarios.
- Diferir no es un guard de autorización: una tool diferida sigue invocable con `eve__tool`. Las guardas son las de cada tool (resolver dinámico que devuelve `null` y un nuevo chequeo dentro de `execute`): code tasks, routines, `install_skill`, `find_skills`/`preview_skill` y `web_fetch` siguen ocultas y rechazadas en consultas entre bots, rutinas o entregas de code task según corresponda, también por la copia diferida.
- Las workflow tools (`prepare_code_repository`) no pueden ser dinámicas: con el flag quedan `deferred` y se llaman por `eve__tool`.
- `propose_skill` queda en core porque las instrucciones lo ofrecen de forma proactiva.
- Las instrucciones agregan una línea solo con el flag activo.

Se descartó una heurística por contenido del mensaje: falla en silencio y cambia el set de tools turno a turno, lo que rompe el prompt cache. También se descartó dejar todo en `deferred` puro, la opción nativa de eve: en flujos de browser de 20 pasos cada llamada pasaría por `eve__tool` y `eve__search` devuelve como mucho 10 resultados.

## Ahorro esperado

`--lazy`: **29 tools, 17,557 B (~4.4k tok)**, es decir −19.4 KB (−52%) en tools. Si la proporción se mantiene sobre los 48.7 KB de producción, el ahorro sería de ~25 KB (~6k tokens) por turno trivial, que pasaría de 29–39k a ~23–33k tokens. Para llegar a menos de 15k también hay que recortar instrucciones e historia; ver los otros frentes del plan de performance.

Al habilitar un grupo, el set de tools cambia una vez y se pierde el prompt cache de ese prefijo una sola vez por sesión.

## Nivel `"core"`

`"lazyTools": "core"` hace lo mismo que `true` y además difiere las tools de uso cotidiano en grupos nuevos de `enable_tools`: `files` (`write_file`, `chat_files`), `history` (`search_history`, `read_history`, `read_fireside`), `plan` (`manage_plan`, `bind_plan_execution`, `dispatch_plan_step`) y `web` (`web_fetch`). `write_file` se sobrescribe en `agent/tools/` con `lazyTool`; con el flag apagado o en `true` devuelve la definición de eve sin cambios. `web_fetch` envuelve la de eve en un resolver dinámico con `lazyResult`: no se ofrece en consultas y su `execute` vuelve a rechazar una consulta antes de cualquier fetch (H-07); fuera de consultas se comporta igual que la de eve. `propose_skill`, `request_login` y `request_form` son workflow tools: en `"core"` quedan `deferred` fijas y se llaman con `eve__tool`.

Quedan fijas: `enable_tools`, `memory__save_memory`/`remove_memory`, `send_file`, `suggest_replies` (chips de la UI), `bash` (la computadora del bot), `read_file` (adjuntos e imágenes), `agent` (workflow tool del framework: no puede ser dinámica y las instrucciones la piden de forma proactiva), `web_search` (provider tool, eve no permite diferirla), los peers (escalar a otros bots) y `eve__search/tool/skill`. Las instrucciones suman una línea al inicio de "How you work" solo en este nivel.

| Nivel | Tools en el prompt | Bytes | ~tok |
| --- | --: | --: | --: |
| apagado | 63 | 36,954 | 9.2k |
| `true` | 29 | 17,557 | 4.4k |
| `"core"` | 20 | 9,220 | 2.3k |

(`pnpm dlx tsx scripts/tool-inventory.ts --core`; incluye 8 peers y 3 tools de catálogo estimados.) Hub: `LAZY_TOOLS_LEVEL=core` hace que `LAZY_TOOLS_BOTS` escriba `"lazyTools": "core"`; el default `on` escribe `true`.

## Flag apagado

Mismo set de tools, mismos schemas y mismas instrucciones (verificado con `eve info --json`). Los 26 overrides de `agent/extensions/browser/tools/` devuelven la definición original, pero cambian el **orden** en que eve lista esas browser tools. El efecto es benigno: invalida el prompt cache una vez, como cualquier deploy.

## Riesgos de calidad

- El modelo puede intentar `browser__open` sin habilitar el grupo. Recibe un error de tool desconocida y debería llamar `enable_tools`. Hay que medirlo en el A/B (tasa de errores y pasos extra por tarea de browser).
- Hay un paso extra la primera vez que se usa cada grupo en una sesión.
- Overrides dinámicos en el slot de una extensión: compila sin diagnósticos, pero no está probado en un sandbox real. Validarlo en un bot de staging antes de activar el flag.

## Rollout por bot (hub, sin migración)

Al desplegar, `rolloutFlags(slug)` (`apps/hub/lib/bots/files.ts`) agrega claves a `config.json` solo si el bot está en una lista de la env del hub. Cada lista es de slugs separados por comas, o `*`:

| Env del hub | Efecto en `config.json` |
| --- | --- |
| `LAZY_TOOLS_BOTS` | `"lazyTools": true`, o `"core"` con `LAZY_TOOLS_LEVEL=core` |

Un bot que no está en ninguna lista recibe el mismo `config.json` que hoy. El cambio aplica en el próximo deploy de cada bot.

## Compaction

`agent.ts` fija `compaction: { threshold: 0.8 }`: eve compacta al 80 % de la ventana de contexto del modelo, sin números fijos. Es el umbral de OpenBot.

- Modelos de gateway: la ventana sale del catálogo de AI Gateway (por ejemplo 1M para `moonshotai/kimi-k3`, así que compacta cerca de 800k).
- Suscripción (ChatGPT, Grok): `agent.ts` declara 128k, así que compacta cerca de 102k. Fireside igual.
- Subagentes: heredan la misma regla.

Historia: hasta el 2026-11-09 `COMPACT_AT_BOTS`/`COMPACT_AT_TOKENS` fijaban 30k. Después de cada compactación quedaban ~16–22k fijos, así que un subagente con muchos `web_fetch` compactaba cada 3–4 pasos y cada compactación con Grok tardaba 25–117 s (en `account-researcher`, ~13 de 18 minutos). Se eliminó.

Para recuperar detalles viejos siguen disponibles `search_history` y `read_history`.

## Orden del prompt y caché (C.2, en pausa)

- Orden que arma eve: `[tools] [system: instructions.ts + fireside] [historia, con cada recall anclado antes de su turno] [clientContext del turno] [input]`.
- Instrucciones estáticas y fireside van en system: son estables dentro de la sesión. `plan.ts` (rol user) se agrega en la posición actual solo cuando cambia.
- `clientContext` (`timeZone`) se inserta antes del input y no se guarda, así que en el turno siguiente invalida solo el último turno (~95% de prefijo estable).
- Si `<memory>` y `<bot_directory>` no cambian, la copia vieja queda en su lugar. Si cambian, eve borra la copia vieja y la vuelve a insertar en el turno actual: se recalcula todo lo que venía después de esa posición.
- Prefijo estable estimado con historia QA de 101 KB: memoria con un hecho nuevo ~34% (flag apagado) / ~25% (`lazyTools`). Bot nuevo ≤23% / ≤13%, porque además aparece una tool `peer-N` y las tools van primero.
- Habilitar un grupo de `lazyTools` también rompe el prefijo, una vez por sesión.
- Arreglarlo desde el template implica pasar la memoria a una instrucción dinámica con rol user, lo que cambia la semántica de eve y suma ~1–2k tokens por cambio, o diferir los peers.
- En pausa: los cambios de memoria y directorio son infrecuentes. Retomarlo solo si los datos de producción muestran caídas de cache hit asociadas a esos cambios.
