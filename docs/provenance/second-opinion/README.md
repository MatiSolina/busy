# Referencia visual aprobada: second opinion

Aprobada en la conversación de diseño del 2026-11-04, después de simplificar los controles.

- [prototype.zip](./prototype.zip): HTML autocontenido empaquetado como artefacto de referencia; extraer el ZIP y abrir `prototype.html` localmente. Incluye fuentes e iconos; no requiere red, build, login ni claves de IA.
- [approved.png](./approved.png): captura de la versión aprobada.
- [Spec](../../second-opinion.md).
- [Especificación de la experiencia](../../second-opinion.md).

El comando abre directamente el fireside. El invitado responde y después el principal; ambos esperan. La interfaz deja el campo de mensaje y Continuar. Cerrar conserva conclusiones e historial para el principal.

Es una simulación: respuestas preparadas, estado local en memoria, sin ejecución de herramientas ni consumo de proveedores. Recargar reinicia el estado. La implementación debe usar los componentes reales de Busy y las garantías del servidor descritas en el plan; no promover este HTML como código de producción.

Los estilos y recursos provienen del proyecto: fuentes Geist/Geist Mono del build local, iconos de lucide-react y avatares clásicos PixCostume. La barra inferior es solo un control de la demo y no forma parte del diseño del producto.

## Implementación en el frontend real

- [implemented-desktop.png](./implemented-desktop.png): verificación local del componente integrado en Busy, a 1440×1000. Respuestas sintéticas para probar la UI; no es una ejecución de proveedores.
- La verificación local cubre 390×844, intervención, Continuar, cierre y reapertura sin generación automática. La página temporal de prueba fue eliminada del código.
