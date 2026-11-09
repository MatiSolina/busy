# Second opinion: fireside chat

Estado: **implementada y cubierta por pruebas locales**.

La experiencia se puede validar con las pruebas del repositorio y con una
instancia propia configurada según [la guía de setup](../skills/busy-setup/SKILL.md).
No se incluyen resultados, cuentas, sesiones ni capturas de producción.

## Objetivo

Contrastar lo que el usuario viene hablando con su bot mediante una conversación
entre dos agentes completos. El intercambio tiene turnos finitos y el usuario
puede intervenir. Al cerrar, el principal conserva las conclusiones y puede
consultar el hilo completo.

[Prototipo de referencia](./provenance/second-opinion/prototype.zip)
· [Captura aprobada](./provenance/second-opinion/approved.png)

## Experiencia aprobada

1. `/second opinion` abre el fireside directamente, dentro del chat actual.
2. Busy incorpora automáticamente otro bot con un modelo distinto que el usuario
   pueda utilizar. No presenta un selector, formulario ni confirmación inicial.
3. Ambos reciben el contexto relevante de la conversación. Cada participante usa
   un runtime completo, con instrucciones, skills, memoria y herramientas propias
   o heredadas de un perfil autorizado.
4. El invitado responde primero. El principal responde a continuación. Cada uno
   tiene una sola respuesta por intercambio y después ambos esperan.
5. Enviar un mensaje interviene en la discusión y habilita otro intercambio de
   hasta una respuesta por bot. Se conserva la alternancia.
6. **Continuar** habilita otro intercambio con el contexto actual. Si había un
   turno pausado, retoma solamente el presupuesto pendiente.
7. Cerrar detiene los turnos pendientes. En el chat principal queda una referencia
   al fireside con sus conclusiones y acceso al historial completo.
8. Reabrir muestra el historial y no genera trabajo por sí solo. Para seguir, el
   usuario escribe o toca Continuar.

La interfaz conserva el diseño actual de Busy. Muestra los participantes, los
mensajes, el compositor, Continuar y el cierre. Durante una respuesta se puede
usar el control de pausa/stop habitual. Las aprobaciones o preguntas de una
herramienta usan las interacciones nativas existentes, cuando corresponda.

No se agregan contadores de turnos, selectores de límites, barras de progreso,
instrucciones permanentes, explicaciones de la mecánica ni estados redundantes.
Los límites se aplican en el servidor.

## Participantes y conexiones

Dos proveedores no son un requisito: hacen falta dos modelos diferentes y
utilizables. Se consideran todas las conexiones autorizadas, además del default
de la cuenta, sin cambiar el modelo o el billing guardados del principal.

| Acceso disponible | Comportamiento |
| --- | --- |
| AI Gateway | Elegir otro modelo soportado y accesible por esa conexión. |
| Token Pass | Elegir otro modelo cubierto por el pase. |
| ChatGPT y otra conexión | Usar un modelo permitido por la cuenta conectada y otro modelo disponible. |
| Grok y otra conexión | Misma regla, respetando el acceso de cada cuenta. |
| Un único modelo utilizable | Mantener el chat y mostrar un aviso breve sobre la conexión que falta. |

**Política inicial propuesta:** preferir un bot existente, listo y disponible,
con un modelo distinto; favorecer otra familia de modelos y resolver empates
de forma estable. Si hay otro modelo autorizado pero no un segundo bot creado,
instanciar un invitado completo temporal, asociado al fireside, sin crear un bot
permanente en el sidebar ni desplegar un proyecto nuevo por invocación.

El invitado temporal usa un perfil explícito derivado del principal, con sus
capacidades efectivas autorizadas y un ámbito de estado/memoria definido. Una
llamada aislada a `generateText` no satisface este requisito. La primera etapa
del plan debe verificar esta ruta en la versión de eve instalada.

Se congela la selección de participantes/modelos/billing para ese fireside.
Una conexión que falla solicita recuperación para ese proveedor; no cambia
silenciosamente de modelo, conexión o fuente de pago.

## Reglas de conversación

- Un solo participante puede ejecutar un turno a la vez.
- Cada acción explícita de inicio, intervención o Continuar concede como máximo
  una respuesta de cada bot. Un evento del modelo nunca concede otro turno.
- Cuenta la respuesta final del turno; narración, streaming, herramientas,
  aprobaciones y retries no son respuestas adicionales ni amplían el permiso.
- El primer turno es del invitado. Después responde el bot distinto al que
  completó la última respuesta. Una intervención humana no borra ese orden.
- Una intervención invalida la continuación vieja, solicita la cancelación del
  turno activo y se incorpora antes del siguiente turno autorizado. Varias
  intervenciones rápidas se conservan en orden; las generaciones reemplazadas
  no pueden seguir ejecutándose ni emitir una respuesta tardía como vigente.
- Doble click, retry HTTP, replay de eventos, reconexión o doble pestaña no
  conceden turnos adicionales ni crean firesides duplicados por la misma acción.
- Invocar el comando mientras ese chat tiene un fireside activo lo enfoca;
  no inicia otro intercambio automáticamente. Después de cerrarlo, una nueva
  invocación puede crear otro. Los anteriores se abren desde su referencia.
- Un límite de ejecución por turno y las políticas de herramientas existentes
  siguen aplicándose; dos respuestas visibles no equivalen a costo ilimitado.

## Cierre y contexto del principal

Cerrar el panel es una acción persistente del servidor, no solo ocultar la UI.
Invalida el trabajo pendiente, cancela el turno activo por su identidad exacta y
espera su finalización para liberar los recursos que pueda usar el principal.
La UI puede volver al chat inmediatamente; un mensaje nuevo del principal no
debe competir con un turno que todavía esté cerrándose.

Se guarda una versión estable del historial y un handoff con:

- tema, participantes y procedencia;
- coincidencias, diferencias y propuestas, atribuidas al bot que las sostuvo;
- datos y restricciones que agregó el usuario;
- puntos sin responder y resultado parcial si se interrumpió la conversación;
- referencia al historial y su versión.

El principal recibe este contexto en su próximo turno aunque se haya cerrado
la app, recargado el navegador o reemplazado su sesión de eve. Puede leer el hilo
mediante una herramienta autorizada. No se vuelca la discusión completa en la
memoria permanente del bot ni se presenta la opinión del invitado como propia.

Si todavía no existe un resumen listo, el registro parcial y el acceso al hilo
permiten continuar; no se inventan acuerdos ni se oculta una intervención sin
respuesta. Reabrir y volver a cerrar sin cambios no duplica el handoff.

Una desconexión de transporte no concede más trabajo ni se interpreta por sí
sola como un cierre confirmado.

Cada sesión de participante a cerrar tiene una entrada en
`state.cancellations` (`requestedAt`, `attempts`, `nextAttemptAt`, `lastError`,
participante y generación), además de `cancelSessions`. La secuencia es
solicitada → `session.ended` confirmado (`endSession` verdadero o el hecho en el
stream; queda persistido como `computerStopPending`) → computadora detenida →
sesión liberada (`sessionId = null`, `generation + 1`). Cada etapa se guarda
antes del siguiente llamado remoto, fuera de la transacción, y cada escritura
exige el lease del tick y el mismo participante, sesión y generación: un worker
viejo no limpia una sesión nueva. Un reinicio retoma la etapa guardada. El
tiempo solo espacia los reintentos (backoff hasta 60 s); nunca confirma un fin
ni pasa `closing` a `closed`. Tras tres intentos fallidos, o si falla detener
la computadora, el fireside muestra "Still stopping the participant" y sigue en
`closing` hasta confirmar todas las sesiones.

## Runner durable

Cada fireside tiene a lo sumo un runner vivo en `fireside_runners` (migración
`0034`): `run_id`, `generation`, `status` (`starting`/`active`/`idle`), `wakes`,
`heartbeat_at`, `lease_until` (5 min), `attempts` y `last_error`. Crear, comandar,
responder y el cron llaman a `scheduleFireside`, que solo "despierta" la fila
(`INSERT … ON CONFLICT`); la adquiere con un `run_id` nuevo únicamente si el
runner está `idle` o su lease venció, y un solo llamador gana el paso
`starting → active` y ejecuta `start(firesideWorkflow, [id, runId])`. La creación
y los comandos despiertan la fila en la misma transacción que guarda el cambio.
El workflow renueva el heartbeat con su `run_id` antes de cada tick; si otra
adquisición lo reemplazó, se detiene sin mutar nada. Pasa a `idle` solo con un
CAS sobre `wakes`, así un comando que llega mientras decide terminar lo mantiene
vivo. Cada 300 ticks continúa en un run nuevo con el mismo `run_id`: llegar a un
límite de polling no libera el runner. `pendingFiresides` (cron) solo devuelve
firesides con trabajo (`running`, `closing`, `paused` con cancelaciones o
asignaciones) y sin runner vivo. `waiting` y `paused` no expiran ni se cierran
por edad; un comando explícito los vuelve a despertar con el transcript intacto.
La expiración automática queda pendiente de una decisión de producto. La acción de cierre del panel —incluido Escape—
envía el comando de cierre, con retry idempotente si se pierde la respuesta.

## Alcance de v1

Incluye dos bots completos, selección automática, hilo durable, alternancia
finita, intervención, pausa/Continuar, cierre, resumen y lectura del historial
por el principal, y las conexiones ya soportadas por Busy.

Quedan fuera los debates autónomos ilimitados, más de dos bots, un selector o
configuración de turnos, elección manual obligatoria, votación o consenso
forzado, Reason Network como dependencia, y agentes recortados a texto sin sus
capacidades normales.

El HTML es una simulación de la interacción aprobada. La implementación real
debe usar los componentes y el runtime del producto; el prototipo no demuestra
integración con proveedores, ejecución de herramientas ni persistencia remota.
