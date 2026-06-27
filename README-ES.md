# free-request-api

> Proxy de IA multi-proveedor desplegado en Cloudflare Workers — endpoint compatible con OpenAI con rotación automática, failover y seguimiento diario de peticiones.

---

## Descripción general

**free-request-api** es un proxy inverso ligero que se sitúa entre tus herramientas de desarrollo con IA (Opencode, Continue, extensiones de VS Code) y múltiples proveedores de LLM con capa gratuita. En lugar de gestionar múltiples claves API y límites de peticiones manualmente, apuntas tus herramientas a un único endpoint y el proxy se encarga de todo de forma transparente.

Construido sobre **Cloudflare Workers**, corre en el edge en más de 300 ubicaciones globales con una latencia de red inferior a 10ms — sin servidor que mantener, sin infraestructura que gestionar.

---

## Características

- **Endpoint único compatible con OpenAI** — funciona con cualquier herramienta que acepte un `baseURL` personalizado
- **Pool multi-proveedor** — NVIDIA NIM, Groq, Google AI Studio, OpenRouter, OVHcloud
- **Selección aleatoria ponderada** — los modelos de mayor calidad reciben más tráfico por defecto
- **Failover automático** — si un proveedor devuelve 429 o 5xx, se intenta con el siguiente de forma transparente
- **Tracker de cooldown por isolate** — los proveedores con rate limit se excluyen temporalmente de la rotación
- **Backoff exponencial con jitter** — lógica de reintento inteligente ante fallos transitorios
- **Contador diario de peticiones** — rastrea el límite gratuito de 100k/día de Cloudflare mediante KV storage
- **Umbral de alerta** — avisa al llegar a 90.000 peticiones/día antes de alcanzar el límite de Cloudflare
- **Endpoint de estadísticas** — consulta el uso actual en cualquier momento vía `GET /stats`
- **Secretos sin exposición** — todas las claves API se almacenan como secretos cifrados de Cloudflare, nunca en el código

---

## Arquitectura

```
Opencode / Continue / VS Code
           │
           ▼
  POST /v1/chat/completions
  Authorization: Bearer <CUSTOM_API_KEY>
           │
           ▼
  ┌─────────────────────────────────┐
  │      Cloudflare Worker          │
  │                                 │
  │  1. Validación de autenticación │
  │  2. Selección de proveedor      │
  │     └─ Weighted random          │
  │     └─ Excluye en cooldown      │
  │  3. Transformación del request  │
  │     └─ Formato OpenAI (default) │
  │     └─ Formato Google Gemini    │
  │  4. Llamada al proveedor        │
  │  5. Failover en 429 / 5xx       │
  │  6. Normalización de respuesta  │
  │  7. Contador de peticiones (KV) │
  └─────────────────────────────────┘
           │
           ▼
  ┌──────────────────────────────────────────┐
  │           Pool de Proveedores            │
  │                                          │
  │  NVIDIA NIM     — DeepSeek V4 Flash      │
  │                 — Nemotron Super 120B    │
  │                 — Kimi K2.6              │
  │                 — Qwen 3.5 122B          │
  │                 — DeepSeek V4 Pro        │
  │                                          │
  │  Groq           — Llama 3.3 70B          │
  │                 — DeepSeek R1 Distill    │
  │                                          │
  │  Google         — Gemini 2.5 Flash       │
  │                                          │
  │  OpenRouter     — DeepSeek V4 Flash      │
  │                 — Kimi K2.6              │
  │                                          │
  │  OVHcloud       — Llama 3.3 70B (anon)  │
  └──────────────────────────────────────────┘
```

---

## Estructura del proyecto

```
src/
├── index.ts        ← Punto de entrada: autenticación, routing, orquestación
├── types.ts        ← Interfaces TypeScript (Env, AIProvider, etc.)
├── providers.ts    ← Definición del pool y configuración de pesos
├── selector.ts     ← Selección ponderada, tracker de cooldown, failover
├── transformer.ts  ← Adaptadores de formato por proveedor
├── stats.ts        ← Contador diario de peticiones y lógica de alertas (KV)
└── utils.ts        ← Backoff, logging, helpers de error
```

---

## Requisitos previos

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Cuenta de Cloudflare](https://dash.cloudflare.com/) con Workers habilitado
- Claves API de al menos un proveedor (ver [Proveedores](#proveedores))

---

## Desarrollo local

### 1. Clonar e instalar dependencias

```bash
git clone https://github.com/tu-usuario/free-request-api.git
cd free-request-api
pnpm install
```

### 2. Configurar secretos locales

Crea un archivo `.dev.vars` en la raíz del proyecto (ya incluido en `.gitignore`):

```bash
CUSTOM_API_KEY=tu-clave-generada-para-el-proxy
NVIDIA_API_KEY_1=nvapi-xxxxxxxxxxxxxxxxxxxx
NVIDIA_API_KEY_2=
NVIDIA_API_KEY_3=
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GOOGLE_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxx
```

Genera una `CUSTOM_API_KEY` segura con:

```bash
openssl rand -base64 32
```

Los proveedores con clave vacía se excluyen automáticamente del pool en tiempo de ejecución.

### 3. Iniciar el servidor de desarrollo

```bash
pnpm run dev
```

El worker estará disponible en `http://localhost:8787`.

### 4. Probar localmente

```bash
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer TU_CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hola"}]}' \
  | python3 -m json.tool
```

---

## Despliegue

### 1. Autenticarse en Cloudflare

```bash
npx wrangler login
```

### 2. Crear el namespace KV para el contador

En el dashboard de Cloudflare: **Workers y Pages → KV → Crear namespace** → nómbralo `proxy-stats`.

Luego vincularlo al Worker: **Workers y Pages → free-request-api → Configuración → Vinculaciones → Agregar → KV namespace** → nombre de variable `PROXY_STATS`, seleccionar `proxy-stats`.

Copia el ID del namespace desde **KV → proxy-stats → Configuración** y actualiza `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "PROXY_STATS",
    "id": "ID_DE_TU_NAMESPACE_KV"
  }
]
```

### 3. Agregar secretos desde el dashboard de Cloudflare

**Workers y Pages → free-request-api → Configuración → Variables y secretos → Agregar**

Agrega cada variable con tipo **Secreto**:

| Nombre | Descripción |
|--------|-------------|
| `CUSTOM_API_KEY` | Tu clave de acceso al proxy (generada con `openssl rand -base64 32`) |
| `NVIDIA_API_KEY_1` | Cuenta 1 de NVIDIA NIM (`nvapi-...`) |
| `NVIDIA_API_KEY_2` | Cuenta 2 de NVIDIA NIM (opcional) |
| `NVIDIA_API_KEY_3` | Cuenta 3 de NVIDIA NIM (opcional) |
| `GROQ_API_KEY` | Clave de Groq (`gsk_...`) |
| `GOOGLE_API_KEY` | Clave de Google AI Studio (`AIza...`) |
| `OPENROUTER_API_KEY` | Clave de OpenRouter (`sk-or-...`) |

### 4. Desplegar

```bash
pnpm run deploy
```

---

## Referencia de la API

### `POST /v1/chat/completions`

Endpoint estándar de chat completions compatible con OpenAI. El proxy selecciona el proveedor internamente — el campo `model` del body se ignora.

**Headers**

```
Authorization: Bearer TU_CUSTOM_API_KEY
Content-Type: application/json
```

**Body**

```json
{
  "messages": [
    { "role": "system", "content": "Eres un asistente de código experto." },
    { "role": "user", "content": "Explica async/await en JavaScript." }
  ],
  "temperature": 0.7,
  "max_tokens": 4096
}
```

**Respuesta** — objeto estándar `chat.completion` de OpenAI con el header adicional `X-Proxy-Provider` indicando qué proveedor atendió el request.

---

### `GET /stats`

Devuelve el uso diario de peticiones frente al límite de la capa gratuita de Cloudflare.

**Headers**

```
Authorization: Bearer TU_CUSTOM_API_KEY
```

**Respuesta**

```json
{
  "date": "2026-06-27",
  "requests": 142,
  "limit": 100000,
  "remaining": 99858,
  "alertThreshold": 90000,
  "alert": false
}
```

Cuando `requests` alcanza `alertThreshold`, el proxy registra una alerta de nivel `WARN` visible con `pnpm wrangler tail`.

---

## Configuración de clientes

### Opencode

Ve a **Agregar proveedor → Personalizado** y completa:

| Campo | Valor |
|-------|-------|
| ID del proveedor | `free-request-api` |
| Nombre para mostrar | `Free Request API` |
| URL base | `https://free-request-api.TU_SUBDOMINIO.workers.dev/v1` |
| Clave API | tu `CUSTOM_API_KEY` |
| ID del modelo | `gpt-4o` |
| Nombre del modelo | `Free Proxy` |

### Continue (extensión de VS Code)

Abre `config.yaml` desde **Panel de Continue → ⚙️ → Config** y agrega:

```yaml
models:
  - name: Free Request API
    provider: openai
    model: gpt-4o
    apiBase: https://free-request-api.TU_SUBDOMINIO.workers.dev/v1
    apiKey: TU_CUSTOM_API_KEY
```

---

## Proveedores

Todos los proveedores utilizados tienen capa gratuita sin tarjeta de crédito requerida (excepto OpenRouter, que solicita un método de pago pero no cobra si solo se usan modelos gratuitos).

| Proveedor | Modelos | RPM | RPD | Notas |
|-----------|---------|-----|-----|-------|
| NVIDIA NIM | DeepSeek V4 Flash, Nemotron Super 120B, Kimi K2.6, Qwen 3.5 122B, DeepSeek V4 Pro | ~40 | ilimitado | Requiere verificación de teléfono |
| Groq | Llama 3.3 70B, DeepSeek R1 Distill 70B | 30 | 1.000/modelo | Inferencia más rápida (hardware LPU) |
| Google AI Studio | Gemini 2.5 Flash | 15 | 1.500 | Ventana de contexto de 1M tokens |
| OpenRouter | DeepSeek V4 Flash, Kimi K2.6 | 20 | 200 | 1.000/día con $10 de crédito |
| OVHcloud | Llama 3.3 70B | 2 | ilimitado | Anónimo, sin registro requerido |

Agregar múltiples cuentas de NVIDIA multiplica la capacidad de forma lineal (cada cuenta tiene límites independientes por modelo).

---

## Agregar un nuevo proveedor

1. Abre `src/providers.ts` y agrega una entrada a `PROVIDER_POOL`:

```typescript
{
  id: 'mi-proveedor-modelo',
  name: 'Nombre legible del proveedor',
  endpoint: 'https://api.miproveedor.com/v1/chat/completions',
  apiKeyEnvVar: 'MI_PROVEEDOR_API_KEY',
  modelId: 'id-del-modelo-que-espera-el-proveedor',
  format: 'openai',   // o 'google' para formato nativo de Gemini
  weight: 8,          // mayor peso = más tráfico
  requiresApiKey: true,
},
```

2. Si requiere una nueva clave API, agrégala a la interfaz `Env` en `src/types.ts`.
3. Agrega el secreto en el dashboard de Cloudflare.
4. Si el proveedor usa un formato de request/response distinto a OpenAI, agrega un adaptador en `src/transformer.ts`.
5. Despliega: `pnpm run deploy`

---

## Monitoreo

### Logs en tiempo real

```bash
pnpm wrangler tail
```

Todos los logs son JSON estructurado. Campos clave: `level`, `message`, `providerId`, `attempt`.

### Estadísticas de peticiones

```bash
curl -s https://free-request-api.TU_SUBDOMINIO.workers.dev/stats \
  -H "Authorization: Bearer TU_CUSTOM_API_KEY" | python3 -m json.tool
```

### Métricas del dashboard de Cloudflare

**Workers y Pages → free-request-api → Métricas** — muestra volumen de requests, tasa de errores y tiempo de CPU por día.

---

## Límites de la capa gratuita de Cloudflare

| Recurso | Plan gratuito |
|---------|---------------|
| Peticiones | 100.000 / día |
| Tiempo de CPU | 10ms / petición |
| Lecturas KV | 100.000 / día |
| Escrituras KV | 1.000 / día |
| Memoria | 128 MB |

El proxy está diseñado para mantenerse muy por debajo de estos límites en uso individual de desarrollo. El endpoint `/stats` alerta cuando las peticiones diarias superan las 90.000.

---

## Seguridad

- La `CUSTOM_API_KEY` protege el proxy de uso no autorizado — trátala como una contraseña.
- Todas las claves API de los proveedores se almacenan como secretos cifrados de Cloudflare y nunca aparecen en el código ni en los logs.
- El archivo `.dev.vars` (secretos locales) está excluido del control de versiones mediante `.gitignore`.
- Nunca hagas commit de `.dev.vars` ni de ningún archivo que contenga claves API en texto plano.

---

## Roadmap

- [ ] Soporte multi-cuenta NVIDIA NIM (cuentas 2 y 3)
- [ ] Desglose del contador de peticiones por proveedor en `/stats`
- [ ] Corrección del soporte de streaming para Continue/VS Code
- [ ] Alerta por webhook al alcanzar el umbral del límite diario
- [ ] Adaptadores para proveedores adicionales (Cerebras, SambaNova)

---

## Licencia

MIT — consulta [LICENSE](LICENSE) para más detalles.
