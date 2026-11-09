## Preferencia de conversación

Responde en tono normal, claro y directo por defecto. Cambia el tono solo cuando el usuario lo solicite explícitamente.

## Calidad de código

- Usamos Ultracite con Biome. La configuración común está en `biome.jsonc`; `apps/hub/biome.jsonc` agrega React, Next.js, Drizzle y soporte para las directivas de Tailwind CSS.
- Ejecutar `pnpm check` para revisar formato, imports, accesibilidad y reglas de lint en todo el monorepo. Para un archivo o directorio: `pnpm exec ultracite check <ruta>` desde la raíz.
- Ejecutar `pnpm exec ultracite fix <ruta>` para correcciones automáticas seguras en los archivos de la tarea. `pnpm fix` aplica esas correcciones en todo el monorepo; no usarlo sobre cambios ajenos. No usar `--unsafe` sin revisar sus cambios.
- Mantener `pnpm lint:next`: ejecuta las reglas adicionales de ESLint para Next.js y React. `pnpm typecheck` y `pnpm test` siguen siendo validaciones independientes.
- `pnpm check:staged` revisa los archivos seleccionados para el commit sin modificarlos. `pnpm check:changed` revisa los cambios contra `origin/main`; actualizar esa referencia antes de usarlo.
- `pnpm hooks:install` activa `.githooks/pre-commit` solo en el checkout actual. No usar `git config --global core.hooksPath` ni instalar hooks compartidos para todos los worktrees.
- El hook `.githooks/pre-push` revisa los archivos cambiados y ejecuta lint de Next y tipos afectados contra `origin/main`; actualizar esa referencia antes de publicar cambios.
- La CI exige `pnpm quality:doctor`, `pnpm check:tooling`, cero diagnósticos de Ultracite, `pnpm lint:next`, `pnpm typecheck` y los tests. El informe completo se conserva incluso cuando hay fallos.
- No desactivar reglas para ocultar deuda existente. Documentar las excepciones justificadas con alcance mínimo.
- Las dependencias, builds, cachés, worktrees y archivos generados están excluidos del chequeo. Biome no valida Python ni shell.
- La adopción inicial es de configuración y diagnóstico: no reformatear ni refactorizar masivamente el código existente sin una tarea específica.
- Ver `docs/code-quality.md` para los comandos, el baseline inicial y las prioridades de corrección.

## Diagnóstico de Vercel

- Antes de investigar problemas de configuración o despliegue en Vercel, ejecutar `pnpm doctor:vercel` desde la raíz. Usa la CLI fijada en el proyecto y revisa `apps/hub`, donde están el vínculo y `vercel.json`.
- Para procesar el informe, usar `pnpm --silent doctor:vercel:json`. Revisar `checks[].status` y `summary`: Doctor devuelve código 0 aunque encuentre controles fallidos.
- Doctor no inicia sesión, no vincula proyectos ni aplica reparaciones. Evaluar los comandos sugeridos antes de ejecutarlos; para operaciones sobre un proyecto, verificar primero el equipo y proyecto de destino.
- Ver `docs/code-quality.md` para interpretar las advertencias y actualizar la CLI local.
