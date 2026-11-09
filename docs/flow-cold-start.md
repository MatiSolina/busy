# Cold start de `flow.func` en los bots

En producción, el primer mensaje a un bot inactivo tarda ~1.6 s de la cola a
`delivery.admitted`; con `flow` caliente tarda ~0.4 s. Este documento mide qué parte de esa
diferencia sale del bundle y qué se puede cambiar desde Busy.

## Qué hay en `flow.func`

Build local con `VERCEL=1 pnpm -C templates/bot build` (eve 0.91, Node 24, sin deploy):

- `.well-known/workflow/v1/flow.func` es una **copia completa de `__server.func`**: el mismo
  `index.mjs` y 16 MB. Las demás rutas de `__server` son symlinks, pero `flow` es una carpeta
  aparte con su propio trigger `queue/v2beta`. Sin `memory` en `.vc-config.json`, usa el default
  del proyecto.
- El import top-level carga 22 archivos y 15.5 MB de JS. Los más pesados son `_libs/eve.mjs`
  (7.9 MB, eve con todo lo vendorizado: providers de Anthropic, Google, OpenAI y MCP) y
  `_chunks/vercel.web.mjs` (5.9 MB, la app Nitro, el código del agente y `workflowCode`). También
  carga `ai.mjs` (0.8 MB), `@ai-sdk/gateway` (0.46 MB) y `undici` (1.2 MB).
- `workflowCode` pesa 1.6 MB, de los que 0.68 MB son un sourcemap inline. eve guarda en caché el
  `vm.Script` (`new Script` memoizado), así que solo se compila en el primer run de la instancia
  (~7 ms con parse lazy).
- Perfil de CPU del import: la mayor parte es compilar módulos ESM (`esm/utils`, ~180 ms) y evaluar
  `eve.mjs` (~110 ms). Dentro de eso, el compilador JIT de schemas de eve se lleva ~45 ms y un
  bundle CJS de protobuf/OTel ~22 ms. Casi todo pertenece a eve; nuestro código pesa poco.

## Mediciones locales del import en frío

Hechas en un Mac (Apple Silicon) con Node 24.18: un proceso nuevo por corrida, 15 corridas, mediana
en ms. `node -e 0` tarda ~40 ms. La CPU de Vercel es más lenta, así que importan las proporciones,
no los valores absolutos.

| Variante                                                | p50 | Δ     |
| ------------------------------------------------------- | --- | ----- |
| Base (template actual)                                  | 356 | —     |
| Sin la extensión browser (`@agent-browser/eve`)          | 328 | −8 %  |
| `--single-threaded` (aproxima 1 vCPU)                    | 393 | +10 % |
| `NODE_COMPILE_CACHE` con caché precargada                | 243 | −32 % |

## Qué es accionable desde Busy

- **Memoria/CPU (implementado, `BOT_FUNCTION_MEMORY`, default apagado).** No se puede fijar con
  `vercel.json` ("You cannot set your memory size using `vercel.json`",
  [docs](https://vercel.com/docs/functions/configuring-functions/memory)). Es un ajuste del
  proyecto: `PATCH /v9/projects/{name}` con `resourceConfig.functionDefaultMemoryType`
  ([API](https://vercel.com/docs/rest-api/reference/endpoints/projects/update-an-existing-project)).
  Con `BOT_FUNCTION_MEMORY=performance` (4 GB/2 vCPUs) o `standard` (2 GB/1 vCPU), el deploy de
  cada bot lo aplica justo después de `ensureProject`, y rige desde el deployment siguiente. Afecta
  a **todas** las funciones del bot y sube el precio por GB-hora de Provisioned Memory. Requiere
  plan Pro o Enterprise: si Vercel lo rechaza, el deploy falla. Ganancia esperada: modesta (~10 %
  del import según el proxy de un hilo). Hay que medirla en un bot de prueba.
- **Sacar código propio de `flow`: no vale la pena.** Los steps (tools, browser) corren dentro de
  `flow`, así que no se pueden excluir del bundle. El mayor aporte nuestro, la extensión browser,
  vale ~28 ms locales, y su código lo genera el paquete de terceros.
- **Regiones:** los bots usan `iad1` por default, igual que la cola y el mundo de Workflow. No hay
  mejora clara.
- **Bytecode caching:** Vercel lo activa por default en Node 20+, pero el changelog dice que
  cubre CommonJS y que el soporte de ESM está "en camino"
  ([changelog](https://vercel.com/changelog/bytecode-caching-for-serverless-functions-by-default)).
  El output de eve es ESM (`.mjs`). Lo suplimos con una compile cache de Node empaquetada en la
  función (`BOT_COMPILE_CACHE`, sección siguiente).
- **Keep-warm:** Vercel mantiene una instancia caliente del deployment de producción en Pro y
  Enterprise ("scale to one", sin configuración,
  [blog](https://vercel.com/blog/scale-to-one-how-fluid-solves-cold-starts)). La doc habla de
  funciones de una o varias regiones y de middleware, pero no menciona funciones disparadas por
  cola. Los datos de producción sugieren que `flow` se enfría igual. No existe un flag de
  instancias mínimas.

## Compile cache empaquetada (`BOT_COMPILE_CACHE=1`, default apagado)

Con el flag prendido en el hub, el bot se construye con `eve build && node scripts/compile-cache.mjs`.

- **Build (`templates/bot/scripts/compile-cache.mjs`):** importa una vez `flow.func` y
  `__server.func` con `module.enableCompileCache({ directory: <func>/_compile-cache, portable: true })`.
  Después escribe un `manifest.json` que dice a qué módulo y tipo pertenece cada entrada, y cambia el
  `handler` de `.vc-config.json` (campo documentado de la
  [Build Output API](https://vercel.com/docs/build-output-api/primitives)) por
  `compile-cache-entry.mjs`. Suma 9.1 MB por función.
- **Runtime (`compile-cache-entry.mjs`):** Node nombra el subdirectorio de la caché
  `<versión>-<arch>-<tag V8>-<uid>`, y la clave de cada archivo es
  `crc32(byte de tipo, ruta relativa al subdirectorio)` (`src/compile_cache.cc`). El uid de runtime
  no se conoce en el build y la carpeta de la función es de solo lectura. Por eso el wrapper crea en
  `/tmp` el subdirectorio con el uid de la instancia, enlaza (symlink) cada entrada bajo la clave que
  Node va a buscar, activa la caché portable y recién entonces importa `index.mjs`. Si versión,
  arch o tag de V8 no coinciden, no activa nada y Node compila como siempre.
- **Log:** una línea por cold start, `{"event":"compile_cache","status":…}`. `1` = activa;
  `mismatch <build> <runtime>` = descartada.

### Verificación local

Se reconstruyó el bot, se copió `flow.func` a otra ruta absoluta (`…/var/task/flow.func`), se
puso en solo lectura y se vació `/tmp` antes de cada corrida (15 corridas por fila, mediana; dos
rondas):

| Variante                                   | p50 (ms)  |
| ------------------------------------------ | --------- |
| `index.mjs` sin caché                      | 328 / 334 |
| Wrapper con caché (reubicada, solo lectura) | 220 / 221 |

- **Solo lectura:** Node lee la caché y no falla; las escrituras de entradas nuevas van a `/tmp`.
- **Otra ruta:** las 21 entradas se aceptan (`NODE_DEBUG_NATIVE=COMPILE_CACHE`: "was accepted").
- **Otro uid:** renombrar el subdirectorio del build a `…-0` no cambia el resultado (216 ms).
- **Otro tag:** `--stack-size`, `--single-threaded`, `--no-opt` y `--expose-gc` cambian el tag de V8 → `mismatch`,
  sin error y con el tiempo de siempre. `--max-old-space-size` y `--max-semi-space-size` no lo cambian.

### Riesgo principal

La caché solo sirve si el Node del **build** de Vercel es exactamente el mismo (versión de parche,
arch y flags de V8) que el runtime `nodejs24.x`, y eso no se puede verificar en local. En el
peor caso se pierden 9 MB por función y no hay ganancia. El primer deploy de prueba lo muestra en el
log `compile_cache`. Tampoco está medido cuánto cuesta en Vercel leer 9 MB más del paquete
de la función.

## Pedidos upstream (listos para issue)

**1. eve — prewarm que despierte el workflow.** `POST /eve/v1/session/:id` sin body devuelve
`ready` y no encola nada cuando la sesión ya corre en el deployment actual. Por eso la primera
entrega tras unos minutos de inactividad paga el cold start de `flow.func` (~1.2 s en producción).
Pedido: una entrega de control no-op (o un modo del prewarm) que reanude el inbox en el deployment
actual sin iniciar un turno ni escribir eventos visibles.

**2. eve — bundle propio para `flow`.** `/.well-known/workflow/v1/flow` es hoy una copia completa de
`__server.func` (16 MB; el import en frío carga 15.5 MB de JS, incluidos `undici`, h3 y todas las
rutas HTTP). Pedido: emitir `flow.func` solo con el runtime de workflow y los steps, y cargar en
forma lazy los providers que el agente no usa (Anthropic, Google, OpenAI y MCP vendorizados en `eve.mjs`)
y el JIT de schemas (~45 ms en el import).

**3. eve — compile cache en el build.** Pedido: que `eve build` genere y empaquete una compile cache
portable de Node (como `scripts/compile-cache.mjs`) o emita un output que aproveche el bytecode caching
de Vercel. Medido local: −33 % del import en frío.

**4. Vercel — ESM y keep-warm para funciones de cola.** (a) Bytecode caching para funciones ESM
(hoy solo CommonJS según el changelog), o garantizar que la versión de Node del build coincida con
la del runtime para que una compile cache generada en el build sea válida. (b) Confirmar si
scale-to-one cubre funciones con `experimentalTriggers` de cola. Si no las cubre, pedir un mínimo
de instancias para ellas.

## Cómo reproducir

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH VERCEL=1 pnpm -C templates/bot build
node --input-type=module -e 'const t=performance.now();await import(process.argv[1]);console.log(performance.now()-t)' \
  "$PWD/templates/bot/.vercel/output/functions/.well-known/workflow/v1/flow.func/index.mjs"
```
