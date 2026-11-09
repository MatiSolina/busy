# Prewarm del bot y ack temprano

## Qué se puede calentar (eve 0.91)

- El bot despliega dos funciones desde el mismo build: `eve/__server.func` (todas las rutas
  `/eve/v1/*`, incluido el stream) y una **`flow.func` dedicada** para
  `/.well-known/workflow/v1/flow`, con trigger de cola `queue/v2beta`
  (`eve/dist/src/internal/nitro/host/vercel-build-output-config.d.ts`). Por eso el SSE que abre el
  chat no calienta la entrega: mantiene vivo `__server`, nunca `flow`.
- `GET /eve/v1/health` es público y solo toca `__server`.
- `POST /eve/v1/session/:id` **sin body** es el prewarm de eve (`client.sessions.attach(id).prewarm()`):
  nunca inicia un turno ni llama al modelo. Hace el lookup del hook del inbox y `runs.get`
  (`eve/dist/src/execution/session-prewarm.js`) y responde:
  - `ready`: la sesión ya corre en el deployment actual. No se encola nada, `flow` no se despierta.
  - `accepted`: la sesión corría en un deployment anterior y eve la mueve al actual
    (`resumeSessionInbox`). Esto sí invoca `flow`, sin turno.
  - `unsupported` / `no_active_session`: nada que hacer; el envío sigue su camino normal.
- No hay una entrega de control sin efectos visibles: `cancel` con un `turnId` inexistente sí
  despertaría `flow`, pero escribe eventos de entrega en el stream persistido. Descartado.

**Limitación:** con la sesión ya en el deployment actual (el caso común), el prewarm calienta
`__server`, la firma del token del hub, la conexión TLS hub→bot y el acceso al mundo de Workflow
del lookup del hook, pero no la instancia de `flow`. Calentar `flow` en limpio necesitaría que eve
exponga una entrega no-op.

## `BOT_PREWARM=1`

- Cliente (`lib/chat/client-store.ts` `warm`): al enfocar el composer o tipear, `POST
  /api/bots/[slug]/warm`, como máximo una vez cada 2 min por bot y pestaña. Sin flag, el hub responde
  `204` sin tocar la base ni el bot.
- Hub (`app/api/bots/[slug]/warm/route.ts`): si el bot está `ready` y tiene sesión, llama al
  prewarm de eve. Nunca crea una sesión (eso arranca sandbox y siembra historial).
- Registra `message.warm` con `durationMs`, `outcome` (`success`, `skipped`, `failed`,
  `not_found`) y `status` de eve.

## `EARLY_ACK`: no implementado

El cliente depende del `deliveryId` síncrono:

- `deliver()` marca el pendiente como `failed` cuando la respuesta no trae `deliveryId`.
- El pendiente se quita cuando llega `delivery.consumed` con **ese** `deliveryId`; el cliente no tiene otra
  forma de correlacionar el pendiente con su entrega.
- Un fallo del send en `after()` no tendría canal hacia el cliente: el `failed` en la base no
  llega al navegador, y el pendiente quedaría colgado sin botón de reintento.

Hacerlo bien exige que el stream o el SSE publiquen `messageId → deliveryId`/`failed` (o que el
cliente sondee el mensaje), más cambios en la UI. Ganancia: 190–630 ms de percepción del ack, sin
acelerar la respuesta del bot. Recomendación: no hacerlo por ahora; si se retoma, primero agregar el
evento `message.accepted|failed` al SSE del hub y correlacionar los pendientes por id del mensaje.

## Cómo medir

1. Con el bot inactivo ≥10 min, mandar el primer mensaje con `BOT_PREWARM` apagado; repetir con
   `BOT_PREWARM=1` enfocando el composer ≥3 s antes de enviar.
2. En las trazas de Vercel del bot, comparar `POST /eve/v1/session/<id>` (202) →
   `/.well-known/workflow/v1/flow` → `delivery.admitted`, y en los logs del hub `message.warm`
   (`status`, `durationMs`) y `message.post` (`eve.send`).
3. Se espera mejora en el 202 del send (`__server` y token calientes) y casi nada en
   ack→admitted salvo cuando `status` es `accepted`.
