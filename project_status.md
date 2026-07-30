# free-request-api — Estado Técnico del Proyecto (ACTUALIZADO)

> **Fecha:** 17 de julio de 2026  
> **Despliegue:** `free-request-api.iaalvearp.workers.dev` (Cloudflare Workers)  
> **Stack:** TypeScript + Cloudflare Workers + Vitest + pnpm

---

## 1. Resumen Ejecutivo

**free-request-api** es un **proxy OpenAI-compatible** (`/v1/chat/completions`) desplegado como **Cloudflare Worker** que rota inteligentemente entre **4 proveedores de IA** (Gemini, NVIDIA, Groq, Cerebras) con **7 modelos** en pool ponderado. Incluye:

- **Failover automático** ante 429/503/timeout/error 400 contexto
- **Detección de OpenCode** → lock de modelo exacto si envía `model` + User-Agent
- **Throttle 1 req/s por proveedor** (in-isolate Map)
- **Health tracking por modelo** (`provider:modelId`) en isolate
- **Stats diarias en KV** (límite 100k req/día CF Free)
- **CORS + Headers de respuesta** con trazabilidad completa (`X-Model-Used`, `X-Fallback-Count`, etc.)
- **Modelos virtuales**: `alpes-auto` (rotación ponderada), `alpes-long` (solo modelos ≥1M ctx)
- **Endpoints:** `POST /v1/chat/completions`, `GET /health`, `GET /stats`, `OPTIONS` CORS

---

## 2. Estructura del Proyecto

```
free-request-api/
├── src/
│   ├── index.ts        → Handler principal (auth, OpenCode detection, failover, routing, virtual models)
│   ├── types.ts        → Types: Env, ModelEntry, ProviderName, IncomingRequest, ChatMessage
│   ├── providers.ts    → MODEL_POOL (7 modelos), PROVIDERS (URLs), ALT_KEYS, getAvailableModels
│   ├── selector.ts     → Weighted random, throttle 1/s, health tracking por modelo (Map in-isolate)
│   ├── transformer.ts  → buildUpstreamRequest, buildProxyResponse (headers OpenAI)
│   ├── stats.ts        → KV daily counter (100k/día CF), getTodayStats
│   └── utils.ts        → sleep, calcBackoff, log estructurado, errorResponse, getRetryAfterMs
├── test/
│   └── index.spec.ts   → Tests: auth, routing, provider config, virtual models, failover, health, headers
├── scripts/
│   └── check-nvidia-models.mjs → Validación local de modelos NVIDIA (pnpm test:nvidia)
├── wrangler.jsonc      → Config CF Worker (KV binding, compat_date, nodejs_compat)
├── tsconfig.json       → TS strict, ES2024, Bundler moduleResolution
├── vitest.config.mts   → @cloudflare/vitest-pool-workers
├── package.json        → scripts: dev, deploy, test, cf-typegen, test:nvidia
├── .dev.vars.example   → Template secrets locales (CUSTOM_API_KEY, GOOGLE_API_KEY, NVIDIA_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY)
├── .gitignore          → .dev.vars*, node_modules, .wrangler
└── README-ES.md / README-EN.md / AGENTS.md
```

---

## 3. Archivos Fuente — Detalle Técnico

### `src/types.ts` (50 líneas)
```typescript
ChatMessage { role: 'user'|'assistant'|'system', content: string }
IncomingRequest { model?, messages[], stream?, temperature?, max_tokens?, tools?, tool_choice?, ... }
ProviderName = 'gemini' | 'nvidia' | 'groq' | 'cerebras'        // ← ACTUALIZADO: agregado nvidia, removido deepseek
ModelEntry { id, weight, provider, envKey, contextWindow }
ProviderConfig { url }
ProviderHealth { lastSuccess, last429, lastError, successCount, failureCount, cooldownUntil, consecutiveFailures }
Env { CUSTOM_API_KEY, ENVIRONMENT, GOOGLE_API_KEY, NVIDIA_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, PROXY_STATS: KVNamespace }
```

### `src/providers.ts` (41 líneas)
```typescript
MODEL_POOL = [
  { id: 'gemini-2.5-flash',          weight: 4, provider: 'gemini',   envKey: 'GOOGLE_API_KEY',     contextWindow: 1_048_576 },
  { id: 'deepseek-ai/deepseek-v4-flash', weight: 5, provider: 'nvidia',   envKey: 'NVIDIA_API_KEY',     contextWindow: 1_000_000 },
  { id: 'z-ai/glm-5.2',              weight: 4, provider: 'nvidia',   envKey: 'NVIDIA_API_KEY',     contextWindow: 1_000_000 },
  { id: 'nvidia/nemotron-3-super-120b-a12b', weight: 3, provider: 'nvidia',   envKey: 'NVIDIA_API_KEY',     contextWindow: 1_000_000 },
  { id: 'llama-3.3-70b-versatile',   weight: 3, provider: 'groq',     envKey: 'GROQ_API_KEY',       contextWindow: 131_072 },
  { id: 'gpt-oss-120b',              weight: 3, provider: 'cerebras',  envKey: 'CEREBRAS_API_KEY',   contextWindow: 131_072 },
  { id: 'openai/gpt-oss-120b',       weight: 2, provider: 'groq',     envKey: 'GROQ_API_KEY',       contextWindow: 131_072 },
]

PROVIDERS = {
  gemini:   { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  nvidia:   { url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  groq:     { url: 'https://api.groq.com/openai/v1/chat/completions' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions' },
}

ALT_KEYS = {}
getAvailableModels(env) → ModelEntry[] filtrados por env[envKey] presente
getModelById(id) → ModelEntry | undefined
getModelAltKeys(model) → string[]
isAltKeyConfigured(provider, env, altKeys) → string[] configuradas
```

### `src/selector.ts` (98 líneas) — **ACTUALIZADO: health por modelo**
```typescript
// Health tracking en Map<string, ProviderHealth> (clave: "provider" o "provider:modelId")
healthMap = Map<provider:modelId, ProviderHealth>
throttleMap = Map<provider, lastCallTs>  // throttle SOLO por proveedor

getHealthKey(provider, modelId?) → "provider" | "provider:modelId"
getHealth(providerName, modelId?) → ProviderHealth

markSuccess(providerName, modelId?)     → reset failures, cooldownUntil=0
markRateLimited(providerName, modelId?) → cooldownUntil = now + 3min (180s)
markError(providerName, modelId?)       → cooldownUntil = now + 1min (60s)
isAvailable(providerName, modelId?)     → Date.now() >= cooldownUntil

checkThrottle(providerName)   → null | msToWait (1 req/s por proveedor)
updateThrottle(providerName)  → set now

getHealthSnapshot() → Record<string, ProviderHealth>  // incluye claves "nvidia:deepseek-ai/deepseek-v4-flash"
selectWeightedModel(models[]) → ModelEntry | null
selectFallbackModel(failedModelId, models[]) → siguiente en array o null
filterAvailableModels(models[]) → filtra por isAvailable(provider, modelId)
getModelHealth(providerName, modelId) → ProviderHealth
getProviderHealth(providerName) → ProviderHealth
```

**Reglas de health:**
- 404/model_not_found de un modelo NVIDIA → **NO** deshabilita otros modelos NVIDIA
- Error de contexto (400 context_length) → **NO** deshabilita todo el proveedor
- 429 específico → cooldown SOLO ese modelo (`provider:modelId`)
- 401/403 de NVIDIA → **SÍ** puede considerarse problema de auth de todo el proveedor (provider-level)

### `src/transformer.ts` (61 líneas)
```typescript
buildUpstreamRequest(model, envKey, incoming, env, signal) → Request
  - Headers: Content-Type: application/json, Authorization: Bearer <key>
  - Body: { model: model.id, messages, stream, temperature, max_tokens, tools?, tool_choice? }
  - POST a PROVIDERS[model.provider].url con AbortSignal

buildProxyResponse(upstreamRes, modelId, provider, contextWindow, retryReason, fallbackCount) → Response
  - Headers passthrough + CORS + trazabilidad:
    X-Model-Used, X-Provider-Used, X-Model-Context-Window, X-Fallback-Count, X-Retry-Reason (si hubo)
```

### `src/stats.ts` (72 líneas)
```typescript
DAILY_CF_LIMIT = 100_000
ALERT_THRESHOLD = 90_000
key = `requests:${YYYY-MM-DD}` (UTC)

incrementRequestCount(env) → ctx.waitUntil()
  - KV get/put con TTL 48h (auto-limpieza)
  - Log WARN si >= 90k

getTodayStats(env) → { date, requests, limit, remaining, alertThreshold, alert: boolean }
```

### `src/utils.ts` (75 líneas)
```typescript
sleep(ms) → Promise<void>
calcBackoff(attempt, baseMs=1000, maxMs=10000) → base*2^attempt + jitter(0-500) capped
log(level, message, data?) → JSON estructurado { level, message, timestamp, ...data }
getRetryAfterMs(Response) → number | null (parsea Retry-After header)
errorResponse(message, status, code) → Response OpenAI-compatible { error: { message, type, code } }
```

### `src/index.ts` (373 líneas) — **Handler Principal**

#### Flujo principal (`fetch`):
1. **CORS OPTIONS** → 204 con headers `Access-Control-Allow-*`
2. **GET /health** → público, devuelve `{ status: 'ok', providers: healthSnapshot }`
3. **GET /stats** → auth `Bearer CUSTOM_API_KEY`, devuelve stats KV del día
4. **POST /v1/chat/completions** (único endpoint de chat)
   - **Auth**: `Authorization: Bearer <CUSTOM_API_KEY>` → 401 si inválido
   - **Parse JSON** → 400 si inválido o sin `messages[]`
   - **OpenCode detection**: `User-Agent` contiene `opencode` (case-insensitive) **OR** header `X-OpenCode-Session` presente
   - **Model selection**:
     - Si **modelo virtual** (`alpes-auto`) → `selectWeightedModel(availableModels)`, `useRotation = true`
     - Si **modelo explícito** → busca en pool; si existe y tiene key → usa ESE modelo; `useRotation = openCode ? false : true`
     - Si **sin model** → `selectWeightedModel(availableModels)` (rotación ponderada)
   - **Context overflow check**: usa `virtualModelContextWindow` (min context window) para `alpes-auto`, o `targetModel.contextWindow` para modelos específicos
     - `estimateTokenCount(messages)` ≈ chars/4
     - Si `contextWindow ≤ 128k` y `estimated > 50k` → 400 `X-Reason: context-too-large-for-model`
     - Si `contextWindow ≥ 1M` y `estimated > 800k` → 400
   - **Failover loop** (máx `availableModels.length * 2` intentos):
     - Para cada modelo: prueba `envKey` principal + `ALT_KEYS` configuradas
     - **Throttle check** → espera si < 1s desde última call a ese provider
     - **Fetch con AbortController 25s timeout**
     - **Manejo de respuestas**:
       - `429` → `markRateLimited(provider, modelId)`, log WARN, continua fallback
       - `≥500` o `404` → `markError(provider, modelId)`, continua fallback
       - `400` con `context_length_exceeded` / `too large` / `maximum context` / `model not found` → `markError(provider, modelId)`, continua fallback
       - `400` otro → **devuelve al cliente** (no rota)
       - **2xx** → `markSuccess(provider, modelId)`, `ctx.waitUntil(incrementRequestCount)`, `buildProxyResponse`, **return**
       - **catch (AbortError/Error)** → `markError(provider, modelId)`, log WARN, continua fallback
     - **Selección siguiente modelo**:
       - Si `useRotation` → `selectFallbackModel(failedId, available)`
       - Si OpenCode locked → `selectWeightedModel(otherModels)`, `useRotation = true` (tras 1er fallo rota)
   - **Todos fallaron** → 502 `{ error: { message: 'Todos los proveedores fallaron', lastErrors: [últimos 3] } }`

#### Headers de respuesta exitosos:
```
X-Model-Used: gemini-2.5-flash
X-Provider-Used: gemini
X-Model-Context-Window: 1048576
X-Fallback-Count: 2
X-Retry-Reason: 429 rate limited (gemini/gemini-2.5-flash); 500 Internal Server Error (nvidia/deepseek-ai/deepseek-v4-flash)
Access-Control-Allow-Origin: *
```

---

## 4. Configuración y Despliegue

### `wrangler.jsonc`
```jsonc
{
  "name": "free-request-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-27",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "upload_source_maps": true,
  "vars": { "ENVIRONMENT": "development" },
  "kv_namespaces": [{ "binding": "PROXY_STATS", "id": "01330c9033254eb6bda3d991f2f5731f" }]
}
```

### Secrets producción (`wrangler secret put <KEY>`)
| Secret | Descripción |
|--------|-------------|
| `CUSTOM_API_KEY` | Auth del proxy (generar: `openssl rand -base64 32`) |
| `GOOGLE_API_KEY` | Google AI Studio (Gemini) |
| `NVIDIA_API_KEY` | NVIDIA NIM Platform |
| `GROQ_API_KEY` | Groq Console |
| `CEREBRAS_API_KEY` | Cerebras Cloud |

### `.dev.vars` (local, gitignored)
```bash
CUSTOM_API_KEY=
GOOGLE_API_KEY=
NVIDIA_API_KEY=
GROQ_API_KEY=
CEREBRAS_API_KEY=
```

### Comandos `package.json`
| Script | Comando | Descripción |
|--------|---------|-------------|
| `dev` | `wrangler dev` | Local en `http://localhost:8787` |
| `deploy` | `wrangler deploy` | Deploy a producción |
| `test` | `vitest` | Tests con `@cloudflare/vitest-pool-workers` |
| `cf-typegen` | `wrangler types` | Regenera `worker-configuration.d.ts` |
| `test:nvidia` | `node scripts/check-nvidia-models.mjs` | Valida modelos NVIDIA localmente |

### Logs producción
```bash
npx wrangler tail
```

---

## 5. Endpoints — Contrato

### `POST /v1/chat/completions`
**Auth:** `Authorization: Bearer <CUSTOM_API_KEY>`  
**Body (OpenAI-compatible):**
```json
{
  "model": "alpes-auto",      // opcional; si OpenCode + model → lock
  "messages": [{ "role": "user", "content": "Hola" }],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 4096,
  "tools": [],
  "tool_choice": "auto"
}
```
**Respuesta exitosa:** Proxy transparente + headers trazabilidad  
**Errores:**
- `401` → `unauthorized` (API key inválida)
- `400` → `invalid_request` (JSON inválido, sin messages, contexto overflow)
- `502` → `all_providers_failed` + `lastErrors` (últimos 3, keys enmascaradas)
- Upstream errors no-context → propagados con headers trazabilidad

### `GET /health` (público)
```json
{
  "status": "ok",
  "providers": {
    "gemini": { "lastSuccess": 1721..., "last429": 0, "lastError": 0, "successCount": 42, "failureCount": 1, "cooldownUntil": 0, "consecutiveFailures": 0 },
    "nvidia:deepseek-ai/deepseek-v4-flash": { ... },
    "nvidia:z-ai/glm-5.2": { ... },
    "nvidia:nvidia/nemotron-3-super-120b-a12b": { ... },
    "groq": { ... },
    "cerebras": { ... }
  }
}
```

### `GET /stats` (auth `CUSTOM_API_KEY`)
```json
{
  "date": "2026-07-16",
  "requests": 1234,
  "limit": 100000,
  "remaining": 98766,
  "alertThreshold": 90000,
  "alert": false
}
```

### `OPTIONS *` (CORS)
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-OpenCode-Session
```

---

## 6. Lógica de Negocio Clave

| Regla | Implementación |
|-------|----------------|
| **Auth** | Bearer vs `env.CUSTOM_API_KEY` (index.ts:114-119) |
| **OpenCode detection** | `User-Agent` incluye `opencode` OR header `X-OpenCode-Session` (index.ts:27-30) |
| **OpenCode lock** | Si OpenCode + `model` en body → usa ESE modelo exacto, sin rotar (index.ts:148-166) |
| **No OpenCode / sin model** | Weighted random del pool disponible (index.ts:167-170) |
| **Modelos virtuales** | `alpes-auto` → weighted rotation; `alpes-long` → (pendiente, documentado) |
| **Context overflow** | ~4 chars/token; ≤128k ctx → threshold 50k; ≥1M ctx → threshold 800k (index.ts:37-47, 177-204) |
| **Failover triggers** | 429, ≥500, 404, timeout 25s, 400 context/model not found (index.ts:245-280) |
| **Throttle** | 1 req/s por provider (Map timestamps en isolate) (selector.ts:56-68) |
| **Health tracking** | success/429/error → cooldown 3min/1min, contadores por `provider:modelId` (selector.ts:26-54) |
| **Response headers** | `X-Model-Used`, `X-Provider-Used`, `X-Model-Context-Window`, `X-Fallback-Count`, `X-Retry-Reason` (transformer.ts:46-54) |
| **Error 502** | `lastErrors` últimos 3 con provider/modelo/reason (sin keys) (index.ts:351-365) |
| **Stats KV** | Contador diario con TTL 48h, alerta 90k (stats.ts) |

---

## 7. Testing

**`test/index.spec.ts`** (240 líneas, 20+ tests):
| Test | Qué valida |
|------|------------|
| `devuelve 401 sin Authorization` | Auth requerida en POST /chat |
| `devuelve 401 con Authorization inválida` | Auth key incorrecta |
| `devuelve 404 para rutas no reconocidas` | 404 en `/` |
| `GET /health devuelve 200` | Health endpoint público + estructura |
| `GET /stats sin auth devuelve 401` | Stats requiere auth |
| `OPTIONS devuelve CORS headers` | CORS preflight correcto |
| `NVIDIA está disponible cuando NVIDIA_API_KEY existe` | Provider config |
| `Modelos NVIDIA no aparecen cuando NVIDIA_API_KEY está ausente` | Provider config |
| `No existe dependencia activa de DEEPSEEK_API_KEY` | Limpieza DeepSeek |
| `No existe proveedor directo deepseek` | Limpieza DeepSeek |
| `No existe proveedor OpenRouter` | Limpieza OpenRouter |
| `IDs de modelos son únicos` | Pool integrity |
| `alpes-auto nunca se envía upstream` | Virtual model |
| `alpes-auto activa rotación` | Virtual model behavior |
| `Modelo exacto se intenta primero` | Explicit model selection |
| `Tras fallo apto para failover se intenta otro modelo` | Failover |
| `Fallo de un modelo NVIDIA no bloquea automáticamente otro modelo NVIDIA` | Health per model |
| `Health se diferencia por modelo` | Health tracking |
| `Throttle continúa diferenciándose por proveedor` | Throttle per provider |
| `401 y 403 se gestionan sin exponer secretos` | Error handling |
| `429, timeout, 5xx, context overflow y model_not_found conservan failover esperado` | Failover logic |
| `/health no expone claves` | Security |
| `Headers X-Model-Used y X-Provider-Used muestran modelo y proveedor reales` | Response headers |

**Ejecución:** `pnpm run test` (usa `@cloudflare/vitest-pool-workers`)

---

## 8. Observaciones Técnicas / Deuda

1. **Modelo virtual `alpes-long` documentado pero no implementado** — requeriría filtrar pool por `contextWindow >= 1_000_000` en selector
2. **Health tracking en isolate** — se pierde en cold starts / evicciones; no persistente
3. **Throttle en isolate** — 1 req/s por isolate; con múltiples isolates CF puede superar rate limit real del proveedor
4. **KV stats** — contador simple; no hay métricas por modelo/provider (solo total diario)
5. **No streaming real** — `stream: true` se pasa upstream pero Worker no hace streaming chunked (límite CF Workers)
6. **worker-configuration.d.ts** incluye secrets antiguos (NVIDIA_API_KEY_1/2/3, OPENROUTER_API_KEY) no usados en código actual — regenerar con `pnpm cf-typegen`
7. **Tests limitados** — solo validan endpoints básicos, no lógica de failover/selection completa (requiere mocks de fetch)
8. **Context overflow check** — usa estimación ~4 chars/token; no cuenta tokens exactos

---

## 9. Próximos Pasos Sugeridos

- [ ] Implementar `alpes-long` (filtrar pool por `contextWindow >= 1_000_000`)
- [ ] Migrar health/throttle a Durable Object o KV para persistencia cross-isolate
- [ ] Añadir métricas por modelo/provider en KV (requests, errors, latency p50/p99)
- [ ] Implementar streaming real con `ReadableStream` + `TransformStream`
- [ ] Añadir tests de integración: failover, OpenCode lock, throttle, context overflow
- [ ] Regenerar `worker-configuration.d.ts` (`pnpm cf-typegen`)
- [ ] Documentar uso de `ALT_KEYS` y añadir UI/config para gestionarlas
- [ ] Añadir alerta/notification cuando `stats.alert === true` (webhook, email, CF Logs)

---

## 10. Referencias Rápidas

| Archivo | Líneas | Responsabilidad |
|---------|--------|-----------------|
| `src/index.ts` | 373 | Handler HTTP, auth, routing, failover loop, OpenCode lock, virtual models |
| `src/types.ts` | 50 | Interfaces TypeScript centrales |
| `src/providers.ts` | 41 | Pool modelos, URLs providers, claves alternativas |
| `src/selector.ts` | 98 | Selección ponderada, throttle, health tracking por modelo |
| `src/transformer.ts` | 61 | Request/Response building + headers trazabilidad |
| `src/stats.ts` | 72 | Contador diario KV + alertas |
| `src/utils.ts` | 75 | Utilidades: sleep, backoff, log, errorResponse |
| `test/index.spec.ts` | 240 | Tests básicos endpoints + configuración providers |
| `scripts/check-nvidia-models.mjs` | ~100 | Validación local modelos NVIDIA (pnpm test:nvidia) |

---

*Generado automáticamente — 17/07/2026*