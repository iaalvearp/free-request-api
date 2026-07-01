# free-request-api — AI Proxy Multi-Proveedor

Cloudflare Worker en `free-request-api.iaalvearp.workers.dev`.
Proxy OpenAI-compatible (`/v1/chat/completions`) que rota entre Gemini, DeepSeek, Groq y Cerebras.

## Arquitectura

```
src/
├── index.ts        → handler principal: auth, OpenCode detection, failover, routing
├── types.ts        → Env, ModelEntry, ProviderName, IncomingRequest
├── providers.ts    → MODEL_POOL (5 modelos con pesos), PROVIDERS map (URLs), ALT_KEYS
├── selector.ts     → weighted random, throttle (1 req/s por provider), health tracking in-isolate
├── transformer.ts  → construye upstream Request OpenAI-compatible, wrappea Response con headers
├── stats.ts        → contador diario KV (100k/día Cloudflare)
└── utils.ts        → sleep, calcBackoff, log estructurado, errorResponse
```

## Comandos exactos

| Comando | Qué hace |
|---------|----------|
| `pnpm run dev` | `wrangler dev` local en puerto 8787 |
| `pnpm run test` | `vitest` con `@cloudflare/vitest-pool-workers` |
| `pnpm run deploy` | `wrangler deploy` |
| `npx wrangler tail` | logs en tiempo real desde prod |
| `npx wrangler secret put KEY` | inserta secreto en prod |
| `npx wrangler types` | regenera `worker-configuration.d.ts` |

## Reglas clave para el agente

- **Auth**: Bearer contra `env.CUSTOM_API_KEY`.
- **OpenCode detection**: `User-Agent` conteniendo "opencode" (case-insensitive) o header `X-OpenCode-Session` presente.
- **OpenCode lock**: si es OpenCode + `model` en body → usar ESE modelo exacto, NO rotar.
- **No OpenCode**: o sin `model` en body → weighted random del pool.
- **Context overflow**: estimación ~4 chars/token. Si `contextWindow ≤ 128K` y `estimated > 50K` → 400 con `X-Reason: context-too-large-for-model`. Si `contextWindow ≥ 1M` y `estimated > 800K` → 400.
- **Failover**: 429/503/timeout/400-context → siguiente modelo del pool.
- **Timeout upstream**: 25s con `AbortController`. Timeout = 503 → rotar.
- **Throttle**: 1 req/s por provider (Map de timestamps en isolate).
- **Response headers**: `X-Model-Used`, `X-Provider-Used`, `X-Model-Context-Window`, `X-Fallback-Count`, `X-Retry-Reason`.
- **Error 502**: devuelve `lastErrors` con últimos 3 errores enmascarados (sin exponer keys).
- **CORS**: OPTIONS responde con `Access-Control-Allow-Origin: *`.
- **Stats endpoint**: `GET /stats` autenticado con `CUSTOM_API_KEY` (misma key que chat).
- **Health endpoint**: `GET /health` público, devuelve snapshot de healthMap por provider.
- **Secrets**: todas via Cloudflare Secrets, NUNCA hardcodeadas. `.dev.vars` en `.gitignore`.

## Pool de modelos

```ts
{ id: "gemini-2.5-flash",          weight: 4, provider: "gemini",   envKey: "GOOGLE_API_KEY" }
{ id: "deepseek-v4-flash-20260423", weight: 4, provider: "deepseek", envKey: "DEEPSEEK_API_KEY" }
{ id: "llama-3.3-70b-versatile",   weight: 3, provider: "groq",     envKey: "GROQ_API_KEY" }
{ id: "llama-3.3-70b",             weight: 3, provider: "cerebras", envKey: "CEREBRAS_API_KEY" }
{ id: "openai/gpt-oss-120b",       weight: 2, provider: "groq",     envKey: "GROQ_API_KEY" }
```

## Context windows

| Modelo | Tokens |
|--------|--------|
| gemini-2.5-flash | 1,048,576 |
| deepseek-v4-flash-20260423 | 1,000,000 |
| llama-3.3-70b-versatile | 131,072 |
| llama-3.3-70b | 131,072 |
| openai/gpt-oss-120b | 131,072 |

## URLs upstream

- gemini: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- deepseek: `https://api.deepseek.com/v1/chat/completions`
- groq: `https://api.groq.com/openai/v1/chat/completions`
- cerebras: `https://api.cerebras.ai/v1/chat/completions`

Todos usan `Authorization: Bearer <key>` (formato OpenAI). Sin transformación de formato.
