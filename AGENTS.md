# free-request-api — AI Proxy Multi-Proveedor

STOP. Tu conocimiento de las APIs de Cloudflare Workers puede estar desactualizado.
Consulta siempre la documentación oficial antes de cualquier tarea relacionada con Workers.

- https://developers.cloudflare.com/workers/
- Límites: https://developers.cloudflare.com/workers/platform/limits/

---

## Qué es este proyecto

Un proxy HTTP desplegado en Cloudflare Workers que actúa como punto de entrada único
para múltiples proveedores de LLMs gratuitos. Opencode y VSCode se conectan a este
proxy como si fuera una API OpenAI estándar. El proxy selecciona automáticamente el
mejor proveedor disponible, rota entre ellos y hace failover si alguno falla o supera
su rate limit.

---

## Estructura de archivos
