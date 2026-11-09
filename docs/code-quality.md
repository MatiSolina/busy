# Calidad de código con Ultracite

## Configuración

Usamos Ultracite **8.1.1** con Biome **2.6.4**, fijados como dependencias de desarrollo de la raíz. El proyecto requiere Node **24.15.0 o posterior** y pnpm **12.16.1**; la CI usa Node 24.18.0.

- `biome.jsonc`: presets `core` y `vitest`, integración con Git y comparación por defecto contra `origin/main`.
- `apps/hub/biome.jsonc`: hereda las reglas comunes y agrega React, Next.js, Drizzle y soporte para las directivas de Tailwind CSS.
- `.vscode/settings.json` y `.vscode/extensions.json`: formato y correcciones seguras al guardar archivos de código, con la extensión `biomejs.biome`.
- `apps/hub/eslint.config.mjs`: conserva ESLint/Next como validación adicional y excluye las rutas generadas por Workflow en `app/.well-known/workflow`.

Biome respeta los `.gitignore`, las exclusiones del preset y las adicionales del proyecto. Dependencias, builds, cachés, worktrees, grabaciones de Playwright y el bundle generado de bots quedan fuera. No valida Python ni shell.

Referencias: [Ultracite con Biome](https://www.ultracite.ai/providers/biome), [presets por workspace](https://www.ultracite.ai/docs/monorepos) y [Biome en CI](https://biomejs.dev/recipes/continuous-integration/).

## Comandos

Ejecutar desde la raíz, con la versión de Node requerida:

```sh
pnpm install --frozen-lockfile
pnpm quality:doctor
pnpm check:tooling
pnpm check
pnpm lint:next
pnpm typecheck
pnpm --filter busy-bot build:ci
pnpm test
```

`pnpm build`, `pnpm test` y `pnpm typecheck` delegan las tareas de los paquetes a Turborepo. `pnpm check` sigue siendo el chequeo transversal estricto de Ultracite; `pnpm lint` ejecuta el lint por paquete. `pnpm --filter hub lint` limita Ultracite al hub. `pnpm typecheck` genera primero el bundle de la plantilla del bot y los tipos de rutas de Next.js, por lo que funciona en un checkout recién creado sin arrancar el servidor.

La tarea Turbo `busy-bot#build` y `pnpm --filter busy-bot build:ci` usan `eve build --skip-sandbox-prewarm`, sin preparar sandboxes remotos. `build:deploy` conserva el `eve build` completo para un despliegue explícito; la API del hub también usa `buildCommand: "eve build"` para los proyectos de bots. La tarea Eve no se cachea porque sus artefactos dependen del entorno. TypeScript y la build del hub no detectan imports de Node que se filtran al bundle de un workflow. `hub#build`, `hub#typecheck` y `hub#test` dependen explícitamente de `hub#bundle-template`, que incluye `templates/bot/**` en su hash y restaura el JSON generado.

Los tests del hub, la plantilla, la imagen Docker y el escritorio son tareas independientes. La CI ejecuta el hub en dos shards: `pnpm turbo run test --filter=hub --force -- --maxWorkers=2 --shard=1/2` y el mismo comando con `--shard=2/2`. La plantilla y la imagen usan `pnpm turbo run test --filter=busy-bot --filter=busy-bot-base-image --concurrency=1 --force -- --maxWorkers=2`. El job de Electron en macOS usa `pnpm turbo run test --filter=busy-desktop --force -- --maxWorkers=2`. Para ejecutar todo localmente sigue disponible `pnpm test`.

Para trabajar sobre un módulo:

```sh
pnpm exec ultracite check apps/hub/components/composer.tsx
pnpm exec ultracite fix apps/hub/components/composer.tsx
```

`fix` aplica las correcciones que el preset considera seguras. Revisar el diff y ejecutar las validaciones relevantes después. `pnpm fix` opera sobre todo el monorepo y no debe usarse sobre trabajo ajeno. `--unsafe` puede cambiar el comportamiento y requiere revisión adicional.

Para revisar solo archivos seleccionados por Git:

```sh
pnpm check:staged
pnpm check:changed
```

`check:staged` selecciona archivos staged y revisa su contenido actual, incluyendo cambios sin stage del mismo archivo. `check:changed` selecciona los archivos de los commits de la rama comparados con `origin/main`; no incluye cambios todavía sin commit. Actualizar esa referencia antes de usarlo. Ninguno de los comandos modifica archivos ni el índice. Para comprobar un archivo nuevo sin añadirlo al índice, pasar su ruta explícitamente a `ultracite check`.

## Base de datos: migraciones y `drizzle-kit`

La base del hub se cambia **solo** con los SQL revisados de `apps/hub/drizzle/` (manuales, aditivos y aplicados en orden con `psql -v ON_ERROR_STOP=1 -f`). `apps/hub/lib/db/schema.ts` describe ese resultado para Drizzle, pero no lo reemplaza: las migraciones tienen RLS, `REVOKE`, nombres de foreign keys e índices que el schema todavía no modela.

- **Prohibido `drizzle-kit push` contra una base con datos**, incluida producción y cualquier `.env.local` que apunte a ella. Contra la base migrada, push ejecutaría todas las líneas de `apps/hub/scripts/schema-drift-allowlist.txt`: desactivaría RLS y recrearía claves e índices. Si el schema y el SQL se desalinean, también puede borrar columnas o CHECKs. `push` solo se usa contra una base vacía y descartable, como el job de performance en CI. Para una instalación nueva usar `pnpm db:init`, que aplica el baseline y las migraciones de forma transaccional; ver `skills/busy-setup/SKILL.md`.
- `pnpm --filter hub check:schema` ejecuta el `drizzle-kit push` real contra una copia PGlite temporal, construida con las tablas base y todos los SQL. Nunca toca una base real. Falla si push propone `DROP COLUMN`, `DROP TABLE`, `SET DATA TYPE` o borrar un CHECK; esos casos no se pueden aprobar. También falla con cualquier otra sentencia que no esté en la allowlist y con líneas de la allowlist que ya no ocurren. El mismo control corre en `pnpm test` (`apps/hub/scripts/schema-drift.test.ts`), que además compara nombre y definición de cada CHECK y cada columna entre una base creada desde `schema.ts` y la creada por las migraciones.
- Al agregar una migración, reflejar en `schema.ts` sus columnas y CHECKs con el nombre exacto que les da PostgreSQL (`<tabla>_<columna>_check` si el CHECK es inline). Para RLS, FKs e índices, preferir modelarlos; solo si no se puede, aprobar la diferencia en la allowlist con su motivo. No agregar líneas para que pase un drift nuevo.
- Estados con CHECK (`lib/db/status-values.ts`: billing, `files.status`, `consultations.status`, `mcp_connections.status`; y las listas de `lib/code-tasks/types.ts`): para agregar un estado, cambiar la lista y escribir una migración nueva que haga `DROP CONSTRAINT IF EXISTS`, `ADD CONSTRAINT ... NOT VALID` y `VALIDATE CONSTRAINT` con el mismo nombre. `lib/db/state-checks.test.ts` prueba que cada valor escrito por el runtime pase y que cualquier otro falle.

`0025_state_checks.sql` agrega `bots_billing_check`, `files_status_check` y `consultations_status_check`. También repone la columna `messages.selected_skills`, sus dos CHECKs y su índice donde nunca se aplicó la 0020. Se puede ejecutar más de una vez. Se detiene sin modificar filas si alguna está fuera de rango o si ya existe un CHECK con ese nombre y otra definición. Antes de aplicarla, correr este preflight de solo lectura; debe devolver cero filas, y cada fila que devuelva requiere una decisión explícita:

```sql
SELECT 'bots.billing' AS col, id::text, billing AS value FROM bots
  WHERE billing NOT IN ('token-pass', 'gateway', 'chatgpt', 'grok')
UNION ALL SELECT 'files.status', id::text, status FROM files
  WHERE status NOT IN ('pending', 'ready', 'blocked')
UNION ALL SELECT 'consultations.status', id::text, status FROM consultations
  WHERE status NOT IN ('open', 'done', 'synced')
UNION ALL SELECT 'messages.selected_skills', id::text, selected_skills::text FROM messages
  WHERE jsonb_typeof(selected_skills) <> 'array'
UNION ALL SELECT 'messages.payload_hash', id::text, payload_hash FROM messages
  WHERE payload_hash IS NOT NULL AND payload_hash !~ '^[0-9a-f]{64}$'
UNION ALL SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
  FROM pg_constraint
  WHERE conname IN ('bots_billing_check', 'files_status_check', 'consultations_status_check');
```

Si `messages.selected_skills` todavía no existe, quitar esas dos líneas de `messages`. Las filas de tipo `constraint` solo indican que el CHECK ya existe; la migración lo omite si la definición coincide y se detiene si no.

## Diagnóstico de Vercel

La raíz incluye Vercel CLI **65.11.0** como dependencia de desarrollo, fijada en `pnpm-lock.yaml`. Los siguientes comandos usan esa instalación y revisan `apps/hub`, donde están el vínculo al proyecto y `vercel.json`:

```sh
pnpm doctor:vercel
pnpm --silent doctor:vercel:json
```

Usarlos antes de investigar problemas de configuración o despliegue. [Vercel Doctor](https://vercel.com/docs/cli/doctor) comprueba la versión e instalación de la CLI, la sesión, el equipo, el proyecto vinculado, `vercel.json` y los incidentes activos de Vercel. Puede ejecutarse sin sesión ni proyecto vinculado; omite los controles que dependen de ellos. No inicia sesión, no vincula proyectos ni aplica los comandos de reparación sugeridos.

Cada control devuelve `ok`, `warning`, `failed` o `skipped`. Doctor termina con código **0** cuando pudo ejecutar el diagnóstico, incluso si algún control falla: revisar `checks[].status` y `summary`, sin usar únicamente el código de salida como aprobación. Es un diagnóstico independiente de `pnpm check`, `pnpm lint:next`, `pnpm typecheck` y `pnpm test`.

Para guardar un informe JSON sin el encabezado del script de pnpm:

```sh
pnpm --silent doctor:vercel:json > /tmp/busy-vercel-doctor.json
```

Evaluar los comandos sugeridos antes de ejecutarlos y verificar el equipo y proyecto de destino para cualquier operación sobre un proyecto.

La comprobación de instalación puede advertir que `vercel upgrade` no puede actualizar la CLI administrada por pnpm. Para actualizarla, reemplazar `65.11.0` por la versión elegida y revisar los cambios en el manifiesto, el lockfile y `pnpm-workspace.yaml`:

```sh
pnpm add --workspace-root --save-dev --save-exact vercel@65.11.0
```

`allowBuilds.koffi` habilita el script de instalación de una dependencia nativa de la CLI, necesario para completar la instalación con la política de builds de este workspace.

## Hooks locales

```sh
pnpm hooks:install
```

Activa `.githooks/pre-commit` **solo en el checkout actual**, mediante `git config --worktree`. No agrega dependencias ni cambia los hooks del resto de los worktrees. Ya está activado en el worktree `codex/ultracite`; debe habilitarse explícitamente en otros checkouts.

El hook de commit ejecuta `pnpm check:staged`, no aplica fixes ni vuelve a añadir archivos al índice. Si se toca un archivo con deuda existente, exige resolver los diagnósticos de ese archivo antes de completar el commit. La adopción de este hook es por checkout mientras se sanea el código por módulos. El hook de push añade `pnpm check:changed` y `pnpm turbo run lint:next typecheck --affected`, con `TURBO_SCM_BASE=origin/main` y `TURBO_SCM_HEAD=HEAD`. Un fallo bloquea el push. Actualizar `origin/main` antes de usarlo; los hooks se activan juntos y solo en el checkout que ejecuta `pnpm hooks:install`.

## Integración continua

`.github/workflows/ultracite.yml` se ejecuta en PR, push a `main` y manualmente:

1. Instala las versiones declaradas y las dependencias con lockfile congelado. Omite scripts de instalación porque este job solo analiza código y no construye Electron.
2. Exige que pasen `pnpm quality:doctor` y `pnpm check:tooling`.
3. Ejecuta el chequeo completo de Ultracite y conserva su JSON y código de salida fuera del checkout, bajo el directorio temporal del runner.
4. Publica el artifact `ultracite-report` durante 14 días y un resumen con los conteos y las reglas más frecuentes.

Las validaciones se ejecutan en jobs independientes para que el tiempo de espera dependa del más lento:

- `lint`: doctor, configuración, pruebas de la selección de macOS, informe global de Ultracite y `pnpm lint:next`.
- `typecheck`: tareas de tipos de los paquetes seleccionados, incluyendo la generación del bundle y los tipos de rutas cuando corresponde.
- `build`: una matriz de los paquetes afectados entre hub y bot. El bot conserva `eve build --skip-sandbox-prewarm`, sin cachear sus artefactos ni preparar sandboxes remotos. El hub usa Turbo con el entorno de Vercel de CI y ejecuta `check:runtime` en un paso separado, incluso al restaurar una build desde caché.
- `test-hub`: dos shards de Vitest en `ubuntu-24.04-arm`, cada uno con dos workers y aislamiento entre archivos. Entre ambos ejecutan todos los archivos del hub cuando está afectado. El script del hub usa `--pool=forks`: los motores WebAssembly de los tests viven en procesos separados para evitar el [fallo de Node 24/V8 al liberar wrappers compartidos entre threads](https://github.com/nodejs/node/issues/66366). Se conservan todos los tests, el aislamiento por archivo y el límite de dos workers; escritorio, bot e imagen también usan procesos. Las builds y sus verificaciones de runtime siguen en Linux x64.
- `test-bot`: suites afectadas de plantilla e imagen, una tarea de dos workers a la vez para no saturar los cores del runner. Los tests de la plantilla dependen de `hub#bundle-template`: importan el código de despliegue del hub y deben funcionar desde un checkout limpio, sin una build previa.
- `quality`: conserva el nombre del check requerido y exige `success` en lint, detección de cambios y todos los jobs seleccionados, incluido Desktop cuando corresponde. Solo acepta `skipped` si el plan lo indicó explícitamente. Un fallo, cancelación o salto inesperado hace fallar el check. Para exigirlo antes del merge, configurar la protección de la rama por separado.
- `desktop`: conserva los tests completos del actualizador con `ditto` nativo. En `main` y ejecuciones manuales corre siempre. En PR solo usa macOS si cambia `apps/desktop`, el contrato de descarga (`apps/hub/lib/install.ts`, `apps/hub/app/api/download` o el manifest del hub), las dependencias, la configuración compartida o `.github`. Una modificación solo de la UI del hub o de documentación no espera un runner de macOS.

La selección usa `turbo run build test typecheck --affected --dry=json` con la versión exacta de Turbo declarada en el repositorio. `affectedUsingTaskInputs` permite incluir contratos que se leen fuera del paquete: los tests del bot declaran los módulos del hub, `images/bot-base/push.sh` y la procedencia de skills; los tests de escritorio declaran el contrato de descarga del hub. La dependencia explícita del bundle propaga cambios de la plantilla al hub, y la imagen conserva sus inputs de sandbox y lockfile.

El plan compara contra el merge base con historia Git disponible. Un cambio en UI del hub evita las suites no afectadas del bot, imagen y escritorio. Documentación común conserva el lint global sin instalar ni ejecutar los jobs de producto. Cambios de configuración compartida, `main` y ejecuciones manuales seleccionan toda la cobertura. Los nuevos workspaces deben incorporarse explícitamente al plan: no se omiten en silencio. Los cambios globales y las validaciones completas comprueban también el grafo completo de Turbo, incluyendo nuevas carpetas declaradas en `pnpm-workspace.yaml`.

El job de selección instala solo el binario de Turbo mediante `npm exec` cuando aún no hay dependencias locales. Si falta la base, falla Git o Turbo, cambia el formato del grafo o aparece un paquete sin configurar, la detección falla y `quality` falla. `node --test .github/scripts/*.test.mjs` comprueba la selección con el Turbo real y repositorios temporales, incluyendo dependencias entre paquetes, eliminaciones y movimientos, nombres con saltos de línea, cambios de `main` y saltos inesperados del gate.

El setup compartido en `.github/actions/setup/action.yml` prepara solo los paquetes del job y el tooling de la raíz (`busy`). El job de tests del bot incluye también el hub por sus imports de contratos; las suites nativas instalan raíz y escritorio. Primero busca una copia exacta de los `node_modules` instalados, incluyendo los enlaces de cada workspace. Su identidad incluye SO, arquitectura, imagen del runner, versiones exactas de Node y pnpm, selección ordenada de paquetes, política de instalación, lockfile, manifests, configuración de pnpm y la propia acción de setup. No admite coincidencias parciales. Solo un hit exacto omite la instalación; si falta, restaura el store de pnpm, ejecuta la instalación con lockfile congelado y sin scripts, y guarda la copia antes de que los tests o builds puedan modificarla. Los jobs con la misma selección comparten esa copia.

También se restaura `.turbo/cache`; las builds de Next guardan además su `.next/cache`. Estas claves separan SO, arquitectura, Node, job y lockfile, con restauración desde ejecuciones previas del mismo ámbito; los pushes a `main` alimentan los cachés que pueden leer los PR. No requiere credenciales de un proveedor de caché remoto. Las suites seleccionadas usan `--force`: se ejecutan completas en cada validación del paquete y no se reutilizan resultados de tests.

`.github/workflows/ci-benchmark.yml` se ejecuta solo manualmente. Compara el store de pnpm (`dependency-cache: false`) con las dependencias instaladas en Linux x64, Linux ARM y macOS, usando dos workers y las suites completas del hub o escritorio. Registra la máquina, el hit exacto y la duración del setup en el resumen. Repetir la misma ejecución permite separar el primer llenado de la caché caliente; al cambiar la selección o las dependencias hay que volver a medir ambas fases. El tiempo de cola se consulta por separado en la ejecución de Actions. El benchmark no cambia los runners de la CI habitual.

Un nuevo commit cancela la ejecución anterior del mismo PR. Las ejecuciones de `main` se serializan sin cancelar la que está en curso. El bundle del bot sigue siendo una dependencia explícita de las tareas del hub; no hay un `pretest` raíz que oculte el orden del grafo. El JSON y el resumen de Ultracite se conservan también al fallar. La CI exige cero diagnósticos globales, incluyendo advertencias; una instalación incorrecta, un informe inválido/truncado o un error de ejecución hacen fallar el job. No se desactivan reglas para ocultar deuda. Los comandos locales de lint también rechazan advertencias.

## Validación reproducible

La CI y los clones locales deben ejecutar la misma cadena de calidad:

```sh
pnpm quality:doctor
pnpm check:tooling
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test
pnpm build
```

Los tests del hub usan procesos separados para aislar motores WebAssembly y
estado compartido. La plantilla, la imagen y el escritorio siguen siendo tareas
independientes; los cambios de la plantilla invalidan el bundle generado del
hub. Los jobs de CI conservan el aislamiento por archivo y los límites de
workers descritos arriba.

Para investigar un diagnóstico, regenerar el informe completo sin incluirlo en
el commit:

```sh
pnpm exec ultracite check --reporter=json --max-diagnostics=none > /tmp/busy-ultracite-diagnostics.json
```

El comando devuelve salida 1 mientras haya incidencias. Revisar el archivo y
corregir la causa en el módulo afectado; no desactivar reglas para ocultar
deuda. Las excepciones deben ser locales, explicar el contrato que las exige y
mantenerse fuera de archivos generados.

## Benchmarks y cachés

`.github/workflows/ci-benchmark.yml` se ejecuta manualmente para comparar la
instalación y las suites completas en los runners declarados. Registra el
entorno, el hit de caché y la duración del setup. Repetir una ejecución separa
el primer llenado del caché de una ejecución caliente; al cambiar la selección
o las dependencias, medir ambas fases de nuevo.

Las cachés de pnpm, Turbo y Next se identifican por sistema operativo,
arquitectura, Node, job, lockfile, manifests y configuración. Una copia de
dependencias solo se reutiliza cuando la identidad coincide exactamente. Los
tests seleccionados usan `--force` para evitar reutilizar resultados de tests.
Los informes y resúmenes se conservan cuando un job falla.

## Integración de cambios

La selección de tareas compara contra el merge base con historia Git disponible.
Una modificación de
UI del hub evita suites de bot, imagen y escritorio. Configuración compartida,
`main` y ejecuciones manuales seleccionan la cobertura completa. Los nuevos
workspaces deben incorporarse explícitamente al grafo y a sus contratos.

Actualiza la referencia base antes de usar `check:changed` o los hooks:

```sh
git fetch origin main
git diff --name-only origin/main...HEAD
```

El bundle de la plantilla sigue siendo una dependencia explícita de las tareas
del hub. No agregues un `pretest` raíz que oculte el orden del grafo. La CI
debe fallar ante un diagnóstico, informe inválido o instalación incompleta.
