# free-request-api

> Proxy de IA multi-proveedor en Cloudflare Workers. Endpoint compatible con OpenAI en `/v1/chat/completions`.
> Rotación inteligente entre Gemini, NVIDIA, Groq y Cerebras.

## Requisitos

- Node.js v20+, pnpm
- Cuenta de Cloudflare con Workers
- API keys de al menos un proveedor

## Desarrollo local

```bash
pnpm install
cp .dev.vars.example .dev.vars   # completá tus claves
pnpm run dev                      # http://localhost:8787
```

## Secrets de producción

```bash
npx wrangler secret put CUSTOM_API_KEY
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put CEREBRAS_API_KEY
```

Generá una `CUSTOM_API_KEY` segura: `openssl rand -base64 32`

## Endpoints

### `POST /v1/chat/completions`

Body compatible con OpenAI. Si el cliente NO es OpenCode (o no envía `model`) el proxy elige el modelo por weighted random. Si el cliente es OpenCode y envía `model`, usa ESE modelo exacto (sin rotación).

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hola"}],"model":"gemini-2.5-flash"}'
```

Headers de respuesta:
- `X-Model-Used` — modelo real que respondió
- `X-Provider-Used` — proveedor (`gemini`, `nvidia`, `groq`, `cerebras`)
- `X-Model-Context-Window` — contexto máximo del modelo
- `X-Fallback-Count` — número de fallbacks antes del éxito
- `X-Retry-Reason` — motivo del fallback (si hubo)

### Probar lock de OpenCode

```bash
# Con User-Agent opencode + modelo explícito → NO rota, usa ese modelo exacto
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: opencode/1.0" \
  -d '{"messages":[{"role":"user","content":"Hola"}],"model":"gemini-2.5-flash"}'

# Sin User-Agent → elige modelo por weighted random
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hola"}]}'
```

### Modelo virtual `alpes-auto`

```bash
# Usa rotación ponderada entre todos los modelos disponibles
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hola"}],"model":"alpes-auto"}'
```

### `GET /health`

Estado de cada modelo (último éxito, 429s, cooldown):

```bash
curl http://localhost:8787/health
```

### `GET /stats`

Contador diario de requests vs límite de Cloudflare (100k/día):

```bash
curl -H "Authorization: Bearer $CUSTOM_API_KEY" http://localhost:8787/stats
```

## Proveedores

| Proveedor | URL | Contexto |
|-----------|-----|----------|
| Google Gemini | `generativelanguage.googleapis.com` | 1M tokens |
| NVIDIA NIM | `integrate.api.nvidia.com` | 1M tokens |
| Groq | `api.groq.com` | 128K tokens |
| Cerebras | `api.cerebras.ai` | 128K tokens |

## Pool de modelos

| Modelo | Peso | Provider |
|--------|------|----------|
| `gemini-2.5-flash` | 4 | gemini |
| `deepseek-ai/deepseek-v4-flash` | 5 | nvidia |
| `z-ai/glm-5.2` | 4 | nvidia |
| `nvidia/nemotron-3-super-120b-a12b` | 3 | nvidia |
| `llama-3.3-70b-versatile` | 3 | groq |
| `gpt-oss-120b` (Cerebras) | 3 | cerebras |
| `openai/gpt-oss-120b` | 2 | groq |

## Logging

```bash
pnpm wrangler tail
```

Cada request loggea: `{model, provider, status, openCode, fallbackCount, durationMs}`.

## Monitoreo

- `/health` — estado actual de cada modelo
- `/stats` — uso diario contra el límite de Cloudflare
- Dashboard Cloudflare → Workers → free-request-api → Metrics
