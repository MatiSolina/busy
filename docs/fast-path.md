# Fast path para turnos simples

Cada turno con eve 0.91 pasa por hook → Vercel Queue → función `flow` → bookkeeping del workflow
antes de llamar al modelo. Medido en prod con el bot caliente: `POST`/`eve.send` 200–450 ms, más
cola/flow/bookkeeping 500–900 ms, más recalls ~100 ms, más el modelo. El primer token p50 queda en
~2,5 s. eve no tiene modo inline (`dispatchWorkflowCommand`/`resumeSessionInbox` siempre encolan, y el
world local no corre en Vercel), así que el fast path responde los mensajes simples desde el hub,
sin pasar por eve. Objetivo: primer token visible < 1,2 s.

## Flag

`FAST_PATH_BOTS`: slugs separados por coma, o `*` para todos. Sin definir, o sin el slug, no cambia
nada: la ruta no consulta el router, no hace queries extra y responde el mismo JSON de siempre.

## Flujo

`POST /api/bots/[slug]/messages` inserta el mensaje igual que siempre (mismo id, hash e idempotencia).
Después:

1. **Router sin LLM** (`routeFast` en `lib/chat/fast-path.ts`): solo texto, ≤ 300 caracteres, sin
   archivos, sin URL ni dominios y sin palabras que pidan una acción. La lista es conservadora
   (inglés y español: abrir, buscar, navegar, crear, enviar, programar, recordar, archivo, link,
   noticias, precio, etc.). Un falso positivo solo manda el mensaje por el camino normal.
2. **Estado del bot** (`fastIneligible` en `lib/chat/fast-reply.ts`): requiere una sesión ya creada
   (no `historyPending`), que la proyección de turno (`sessionTurn` en `lib/chat/open-turn.ts`) no
   tenga un turno `running`, `awaiting_input` o `unknown` ni entregas admitidas sin `delivery.settled`
   (una sesión con `session.ended` da `no_session`; nunca se inventa un `turn.settled`), que eve haya tomado el último
   mensaje normal (`delivery.consumed`), que no haya otro mensaje `pending`, ni una consulta abierta, un
   fireside o un code task activo. Con `token-pass`, además, el modelo tiene que estar cubierto y
   `TOKEN_PASS_API_KEY` configurada.
3. **Respuesta**: `streamText` del AI SDK con el modelo del bot y una sola tool, `escalate`, sin
   `execute` y con un solo argumento opcional, `status`: 2 a 6 palabras sobre lo que el bot va a
   hacer ("Finding leads for Acme"). El hub lo manda como línea `{status}` y la UI lo muestra en lugar
   de "Thinking…" hasta que el turno termina. El prompt usa la identidad y el estilo del template (nombre,
   descripción, `bots.instructions`, "clear and brief"), una sección de modo rápido, la memoria del bot
   (tabla `memories`, la misma que lee `/api/bot/memory`) y `recentHistory` (los últimos intercambios,
   lo mismo que se siembra en `<prior_history>`). `maxRetries: 0`: si falla, se usa el camino normal. Si el modelo no
   emite nada (texto ni `escalate`) en `FAST_FIRST_OUTPUT_MS` (8 s), se aborta y también escala: el
   2026-11-09 grok.com tardó 40 s en devolver un 520 y retuvo el mensaje, con `maxDuration` de 60 s.
4. **Billing**, igual que los turnos del bot:
   - `gateway`: AI Gateway con `AI_GATEWAY_API_KEY` o el token OIDC del hub (`createGateway`).
   - `token-pass`: AI Gateway con `TOKEN_PASS_API_KEY`.
   - `chatgpt`/`grok`: `@ai-sdk/openai` (Responses) con un `fetch` que reusa `getSubscriptionAccess`,
     `hasSubscriptionModel`, `prepareSubscriptionBody`, `subscriptionUrl` y `subscriptionHeaders`, el
     mismo upstream y filtro de body que `/api/bot/ai/responses`.
5. **Escalado**: si el modelo llama a `escalate`, devuelve texto vacío o falla, se descarta el borrador
   y el mensaje original va al bot por `deliverMessage` → `sendToBot`, en la misma respuesta HTTP.

## Ack rápido (`FAST_PATH_ACK=1`)

Apagado por defecto: sin la variable, todo sigue como arriba. Encendido, el prompt pide que, si hace
falta escalar, el modelo escriba primero UNA frase corta (≤ 15 palabras, en el idioma de Mati) con lo
que va a hacer, sin afirmar resultados, y después llame a `escalate`. Si llama a `escalate` sin texto,
es el escalado de siempre.

Con texto antes del `escalate`:

1. No se retracta. La ruta llama a `deliverMessage` con `fastAck`, que agrega `quickAck` y
   `quickAckNote` al `clientContext` de **este** mensaje (el bot continúa desde ahí, sin saludar de
   nuevo). El mensaje queda `accepted` con el `deliveryId` real de eve, así que no es un intercambio
   `fast:` y `pendingFastExchanges` no lo vuelve a inyectar.
2. Con eve ya aceptado, `persistAck` guarda tres filas en la última línea de eve (índices ≥
   `FAST_INDEX_BASE`): `delivery.consumed` **con el `deliveryId` real**, `turn.started` y
   `content.completed` con el ack. No hay `turn.settled`: el turno queda abierto hasta que eve
   asienta el suyo.
3. Las mismas filas salen por el NDJSON con las mismas claves `line:index`; `readFast` reemplaza las
   que ya había mostrado (cambia `fast:<id>` por el id real) y agrega el ack. Al final llega
   `{deliveryId}` de eve como siempre.
4. Si eve no acepta el mensaje o falla el guardado, `{retract: true}` y queda como un escalado
   normal (pendiente o fallido).

Representación en la UI:

- **Unicidad**: `toChatView` salta un `delivery.consumed` cuyo `deliveryId` ya está en el chat. eve
  consume el mensaje en una línea posterior con el mismo id: esa fila no agrega otra burbuja.
- **Orden**: las filas del ack están en la línea `L` (la última de eve antes del mensaje) y las de eve
  en líneas `> L`. Mati → ack → trabajo de eve, en vivo y al recargar.
- **Espera**: el `turn.started` sin settle mantiene `working`; `waitStage` da `thinking` y la lista
  muestra "Thinking…" debajo del ack hasta que eve muestre algo o asiente su turno.
- `fastIneligible` ignora las filas fast al chequear si eve tomó el último mensaje, y el turno abierto
  del ack ya marca al bot como `busy`.

Observabilidad: `message.fast` agrega `acked: true` y `ackMs` (primer token del ack).

## Streaming en la UI

Desvío del diseño propuesto: en lugar de publicar hechos sintéticos en el SSE de eventos (que relaya
el stream de eve y no tiene un bus entre funciones), el `POST` responde `application/x-ndjson` cuando
toma el fast path. Las líneas tienen la misma forma que el SSE:

- `{fact}`: `delivery.consumed` (el mensaje de Mati) y `turn.started` con el primer token;
  `content.completed` y `turn.settled` al final.
- `{progress}`: `content.delta` con `partId` `fast-<id>:reply`, sin `line` (no toca el dedupe de
  progreso de eve).
- `{retract: true}`: si se escala después de mostrar texto (sin `FAST_PATH_ACK`, o si el ack no se
  pudo conservar), el cliente quita esas filas y vuelve a
  mostrar el mensaje como pendiente.
- `{deliveryId}` al final: `fast:<id>`, o el `deliveryId` de eve si se escaló. `{error}` si tampoco
  se pudo entregar.

`client-store.ts` (`readFast`) aplica esas líneas con los mismos `onFact`/`onProgress` del SSE.
Cualquier otra respuesta sigue el camino JSON de siempre.

Un NDJSON que se corta antes de `{deliveryId}`/`{error}` no es un fallo: el hub sigue entregando.
El pendiente queda `uncertain` (se muestra como enviando) y el cliente pregunta una vez con el mismo
id a `POST …/messages?reconcile=1`, que nunca corre otro turno rápido y responde desde la fila
guardada o la `idempotencyKey` de eve. Un snapshot solo quita el pendiente cuyo `delivery.consumed`
trae; `delivery.admitted` solo no alcanza.

## Persistencia y dedupe

Al terminar, en una transacción, se guardan las cuatro filas en `events` con el `sessionId` de la
sesión, la **última línea guardada de eve** (`cursors.nextLine - 1`) y un `index` ≥ 1.000.000.000
(`FAST_INDEX_BASE`), cuatro índices por intercambio. Además, el mensaje queda `accepted` con
`deliveryId = fast:<id>`. El PK `(session_id, line, index)` y la clave `line:index` del cliente no
colisionan con eve, que numera los hechos de cada línea desde 0. Ordenadas por `(line, index)`, las
filas quedan después de los hechos de esa línea y antes de la siguiente línea de eve.

El slot se **reserva antes de llamar al modelo** en `fast_slot_reservations` (`lib/chat/fast-slots.ts`,
migración `0033`): PK `(session_id, line, slot_index)` e `INSERT … ON CONFLICT DO NOTHING`; el siguiente
índice es el mayor entre los eventos guardados (+1) y las reservas vivas (+4), y quien pierde el
conflicto recalcula. No se sostiene ningún lock durante la inferencia. La transacción que guarda las
filas consume la reserva (`DELETE … RETURNING`); si ya no existe (`FastSlotLost`), no inserta nada y el
mensaje vuelve al camino normal con el mismo id. Una escalada o un fallo liberan la reserva; un ack la
conserva hasta `persistAck`. Una reserva vencida (5 min, solo si el request murió) se recupera en la
siguiente asignación. El cursor no
cambia, así que el relay y el cron no se ven afectados. Al recargar, el snapshot las muestra como un
intercambio normal, y `recentHistory` las incluye (sirven si la sesión se vuelve a sembrar).

## Consistencia con el bot

eve no ve el intercambio rápido. Cuando el flag está activo, `deliverMessage` agrega al `clientContext`
del siguiente mensaje normal `recentQuickReplies` (`[{ mati, you }]`, de más antiguo a más nuevo) y una
nota. Es el mismo canal por el que ya llegan los firesides y la zona horaria, así que no hace falta
redeployar los bots. Los pendientes son los intercambios fast creados después del último mensaje
normal aceptado y antes del mensaje actual. Cuando eve acepta un mensaje normal, los anteriores quedan
fuera de esa ventana: así se marcan como consumidos, sin tabla ni columna nuevas. Un reintento del
mismo mensaje usa el mismo `createdAt` y recibe el mismo contexto. El texto visible no cambia.

## Observabilidad

- Log `message.fast` (allowlist en `lib/chat/observability.ts`). Con `decision: "fast"` incluye
  `outcome`, `escalated`, `ttftMs`, `totalMs`, `provider`, `inputTokens`, `outputTokens` y los
  `stage*Ms`. Si no aplica, `decision` es el motivo (`action`, `url`, `long`, `files`, `busy`,
  `consultation`, `fireside`, `code_task`, `model`, `no_session`) y `outcome: "skipped"`.
- Spans: `fast.eligible`, `fast.context`, `fast.model`, `fast.persist` y `message.fastContext`.

## Riesgos

- **Ack**: si eve nunca arranca el turno del mensaje aceptado, el chat queda en "Thinking…" (igual
  que un mensaje aceptado que eve no toma). Si el guardado del ack falla después de entregar, el bot
  igual recibió `quickAck`, pero el chat lo retracta. El modelo podría escribir más de una frase o
  insinuar un resultado; el prompt lo pide, no lo garantiza.

- **Voz y capacidades**: el modelo rápido no tiene herramientas ni skills. Podría prometer algo o
  contestar algo que el bot completo haría distinto. El router, el prompt y `escalate` lo mitigan,
  pero no hay garantía.
- **Memoria**: el fast path lee la memoria, pero no escribe en ella. Por eso "recordá…" escala.
- **Idioma**: copia la línea del template ("You write in English"), igual que el prompt del bot. Las
  instrucciones de idioma propias de cada bot aplican igual en los dos caminos.
- **Carreras**: si llega un mensaje de una rutina o un turno de eve mientras se responde un fast
  path, las filas igual quedan ordenadas antes de esa línea nueva. Dos fast paths simultáneos del
  mismo bot podrían competir por el mismo índice; el segundo fallaría al persistir y escalaría.
- **Reintento después de un corte**: si el stream se corta después de persistir, un reintento del
  `POST` responde `already_accepted` con `fast:<id>`. El cliente puede no tener las filas hasta
  recargar, porque el SSE retoma desde una línea posterior.
- **Apagar el flag** con intercambios pendientes: el próximo mensaje normal no los lleva en
  `clientContext`. Siguen en `recentHistory` si la sesión se vuelve a sembrar.
- **Costo**: con `bot.fast` no se usa el tier `priority`. Además, cada intercambio rápido agrega una
  llamada al modelo fuera de eve, que no aparece en `usage.recorded`; solo queda en el log.

## Cómo medir

Con un bot QA, sin tocar los bots de usuarios:

1. Sin `FAST_PATH_BOTS`, correr el harness de `docs/performance-production.md`
   (`production-browser-fixture.ts`) con mensajes simples ("hola", "¿qué opinás de X?") y guardar
   `firstTokenVisibleMs`.
2. Configurar `FAST_PATH_BOTS=<slug-qa>`, redeployar el hub, repetir los mismos mensajes y comparar
   `firstTokenVisibleMs` p50/p95.
3. En los logs, filtrar `event: "message.fast"`: `ttftMs` (hub → primer token), la tasa de `escalated`
   y el reparto de `decision`. Los escalados pagan el costo normal más el tiempo hasta el escalado.
