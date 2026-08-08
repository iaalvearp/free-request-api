# free-request-api — Referencia Completa para Agentes

## Arquitectura

```
src/
├── index.ts        → handler principal: auth, OpenCode detection, failover, routing
├── types.ts        → Env, ModelEntry, ProviderName, IncomingRequest
├── providers.ts    → MODEL_POOL (7 modelos con pesos), PROVIDERS map (URLs), ALT_KEYS
├── selector.ts     → weighted random, throttle (1 req/s por provider), health tracking por modelo (in-isolate)
├── transformer.ts  → construye upstream Request OpenAI-compatible, wrappea Response con headers
├── stats.ts        → contador diario KV (100k/día Cloudflare)
└── utils.ts        → sleep, calcBackoff, log estructurado, errorResponse
```

## Pool de modelos (src/providers.ts)

```ts
{ id: "gemini-2.5-flash",          weight: 4, provider: "gemini",   envKey: "GOOGLE_API_KEY",     contextWindow: 1_048_576 }
{ id: "z-ai/glm-5.2",              weight: 4, provider: "nvidia",   envKey: "NVIDIA_API_KEY",     contextWindow: 1_000_000 }
{ id: "nvidia/nemotron-3-super-120b-a12b", weight: 3, provider: "nvidia",   envKey: "NVIDIA_API_KEY",     contextWindow: 1_000_000 }
{ id: "llama-3.3-70b-versatile",   weight: 3, provider: "groq",     envKey: "GROQ_API_KEY",       contextWindow: 131_072 }
{ id: "gpt-oss-120b",              weight: 3, provider: "cerebras", envKey: "CEREBRAS_API_KEY",   contextWindow: 131_072 }
{ id: "openai/gpt-oss-120b",       weight: 2, provider: "groq",     envKey: "GROQ_API_KEY",       contextWindow: 131_072 }
```

## URLs upstream

- gemini: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- nvidia: `https://integrate.api.nvidia.com/v1/chat/completions`
- groq: `https://api.groq.com/openai/v1/chat/completions`
- cerebras: `https://api.cerebras.ai/v1/chat/completions`

Todos usan `Authorization: Bearer <key>` (formato OpenAI). Sin transformación de formato.

## Rutas virtuales

### alpes-auto
- Pool completo ponderado de todos los modelos con API key configurada
- Context window: min(contextWindow) de todos los modelos disponibles
- OpenCode lock: si OpenCode + model en body → ese modelo exacto, sin rotación

### alpes-agent
- Solo modelos con contextWindow >= 1_000_000
- Debe soportar tool_calls y mensajes multi-turno
- Candidatos: gemini-2.5-flash, z-ai/glm-5.2, nvidia/nemotron-3-super-120b-a12b
- Context window: min(1M) = 1_000_000
- Nunca se envía upstream como nombre real

### alpes-small
- Modelos rápidos con contextWindow ≤ 131_072
- Para títulos, resúmenes, clasificación, tareas internas
- Evita NVIDIA mientras exista ResourceExhausted recurrente
- Context window: 131_072

## Health tracking

- Map in-isolate (`healthMap`) con clave `provider:modelId`
- markSuccess: resetea consecutiveFailures, cooldownUntil = 0
- markRateLimited: cooldown 3 min (429)
- markError: cooldown 1 min (errores generales)
- ResourceExhausted: cooldown 15 min específico del modelo

## Throttle

- 1 req/s por provider (Map de timestamps)
- No bloquea otros providers

## Affinity

- Map in-isolate con clave `sessionId:virtualRoute`
- alpes-agent no afecta alpes-small ni viceversa
- Se actualiza tras fallback exitoso
- No es persistente entre cold starts

## NVIDIA Integration Notes

- Una sola `NVIDIA_API_KEY` permite seleccionar distintos modelos NVIDIA.
- GLM 5.2 y Nemotron 3 se consumen mediante NVIDIA.
- DeepSeek V4 Flash (NVIDIA) fue retirado (end of life): NVIDIA responde HTTP 410 Gone, el proxy hace failover y lo marca como no disponible en el isolate.
- NO se utiliza `DEEPSEEK_API_KEY` ni endpoint directo `api.deepseek.com`.
- OpenRouter fue retirado.
- Health tracking por modelo (`provider:modelId`), throttle por proveedor.
- Endpoints gratuitos de NVIDIA son para desarrollo/pruebas, no para producción.
- 404/model_not_found de un modelo NVIDIA NO deshabilita otros modelos NVIDIA.
- 401/403 de NVIDIA SÍ deshabilita todo el proveedor.

## Context overflow

- Estimación ~4 chars/token
- Si contextWindow ≤ 128K y estimated > 50K → 400
- Si contextWindow ≥ 1M y estimated > 800K → 400

## Failover

- 429, 503, timeout (25s), 400 context/model_not_found/reasoning_content, 410 Gone → fallback
- 410 Gone: marca el modelo como retirado (no se vuelve a seleccionar en el isolate) y continúa con el siguiente modelo
- ResourceExhausted (detectado en body) → fallback
- Máximo un intento por modelo por solicitud
- Set<string> de modelos intentados
- Tras fallback exitoso: actualiza afinidad

## Secrets

- CUSTOM_API_KEY: auth del proxy
- GOOGLE_API_KEY: Gemini
- NVIDIA_API_KEY: NVIDIA NIM
- GROQ_API_KEY: Groq
- CEREBRAS_API_KEY: Cerebras

## Configuración Cloudflare

- wrangler.jsonc: compatibility_date 2026-06-27, nodejs_compat
- KV binding PROXY_STATS (id: 01330c9033254eb6bda3d991f2f5731f)
- Plan gratuito: 100k req/día, alerta a 90k

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | /v1/chat/completions | Bearer | Chat proxy |
| GET | /health | No | Status + health snapshot |
| GET | /stats | Bearer | Estadísticas diarias KV |
| OPTIONS | * | No | CORS preflight |

## Headers de respuesta

- X-Model-Used: modelo real upstream
- X-Provider-Used: gemini | nvidia | groq | cerebras
- X-Model-Context-Window: contexto del modelo
- X-Fallback-Count: número de fallbacks
- X-Retry-Reason: causas de fallback (si hubo)
