# free-request-api

> Multi-provider AI proxy deployed on Cloudflare Workers — OpenAI-compatible endpoint with automatic rotation, failover, and daily request tracking.

---

## Overview

**free-request-api** is a lightweight reverse proxy that sits between your AI coding tools (Opencode, Continue, VS Code extensions) and multiple free-tier LLM providers. Instead of managing multiple API keys and rate limits manually, you point your tools to a single endpoint and the proxy handles everything transparently.

Built on **Cloudflare Workers**, it runs at the edge across 300+ global locations with sub-10ms network latency — no server to maintain, no infrastructure to manage.

---

## Features

- **Single OpenAI-compatible endpoint** — works with any tool that accepts a custom `baseURL`
- **Multi-provider pool** — NVIDIA NIM, Groq, Google AI Studio, Cerebras
- **Weighted random selection** — higher-quality models get more traffic by default
- **Automatic failover** — if a provider returns 429 or 5xx, the next one is tried seamlessly
- **Per-model cooldown tracker** — rate-limited models are temporarily excluded from rotation
- **Exponential backoff with jitter** — smart retry logic on transient failures
- **Daily request counter** — tracks Cloudflare's 100k/day free tier limit via KV storage
- **Alert threshold** — warns at 90,000 requests/day before hitting the Cloudflare limit
- **Stats endpoint** — query current usage anytime via `GET /stats`
- **Zero cold-start secrets** — all API keys stored as encrypted Cloudflare secrets, never in code
- **Virtual models** — `alpes-auto` for weighted rotation, `alpes-agent` for the 1M+ allowlist, `alpes-small` for fast models

---

## Architecture

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
   │  1. Auth validation             │
   │  2. Provider selection          │
   │     └─ Weighted random          │
   │     └─ Skip cooldown models     │
   │  3. Request transformation      │
   │     └─ OpenAI format (default)  │
   │     └─ Google Gemini format     │
   │  4. Upstream fetch              │
   │  5. Failover on 429 / 5xx       │
   │  6. Response normalization      │
   │  7. Request counter (KV)        │
   └─────────────────────────────────┘
           │
           ▼
   ┌──────────────────────────────────────────┐
   │           Provider Pool                  │
   │                                          │
   │  NVIDIA NIM     — GLM 5.2                │
   │                 — Nemotron 3 Super 120B  │
   │                 — Nemotron 3 Nano        │
   │                 — Nemotron 3 Ultra 550B  │
   │                 — DeepSeek V4 Flash      │
   │                                          │
   │  Groq           — Llama 3.3 70B          │
   │                 — GPT-OSS 120B           │
   │                                          │
   │  Google         — Gemini 2.5 Flash       │
   │                 — Gemini 3.6 Flash       │
   │                 — Gemini 3.5 Flash Lite  │
   │                                          │
   │  Cerebras       — GPT-OSS 120B           │
   └──────────────────────────────────────────┘
```

---

## Source Structure

```
src/
├── index.ts        ← Entry point: auth, routing, orchestration
├── types.ts        ← TypeScript interfaces (Env, AIProvider, etc.)
├── providers.ts    ← Provider pool definition and weight configuration
├── selector.ts     ← Weighted random selection, cooldown tracker, failover
├── transformer.ts  ← Request/response format adapters per provider
├── stats.ts        ← Daily request counter and alert logic (KV-backed)
└── utils.ts        ← Backoff, logging, error helpers
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Cloudflare account](https://dash.cloudflare.com/) with Workers enabled
- API keys for at least one provider (see [Providers](#providers))

---

## Local Development

### 1. Clone and install

```bash
git clone https://github.com/your-username/free-request-api.git
cd free-request-api
pnpm install
```

### 2. Configure local secrets

Create a `.dev.vars` file in the project root (already in `.gitignore`):

```bash
CUSTOM_API_KEY=your-generated-proxy-key
NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxx
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GOOGLE_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxx
CEREBRAS_API_KEY=csk-xxxxxxxxxxxxxxxxxxxx
```

Generate a secure `CUSTOM_API_KEY`:

```bash
openssl rand -base64 32
```

Providers with empty keys are automatically excluded from the pool at runtime.

### 3. Start the dev server

```bash
pnpm run dev
```

The worker is available at `http://localhost:8787`.

### 4. Test locally

```bash
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CUSTOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}' \
  | python3 -m json.tool
```

---

## Deployment

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 2. Create KV namespace for request tracking

In the Cloudflare dashboard: **Workers & Pages → KV → Create namespace** → name it `proxy-stats`.

Then bind it to the Worker: **Workers & Pages → free-request-api → Settings → Bindings → Add → KV namespace** → variable name `PROXY_STATS`, select `proxy-stats`.

Copy the namespace ID from **KV → proxy-stats → Settings** and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "PROXY_STATS",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

### 3. Add secrets via Cloudflare dashboard

**Workers & Pages → free-request-api → Settings → Variables and Secrets → Add**

Add each variable as type **Secret**:

| Name | Description |
|------|-------------|
| `CUSTOM_API_KEY` | Your proxy access key (generated with `openssl rand -base64 32`) |
| `NVIDIA_API_KEY` | NVIDIA NIM account (`nvapi-...`) |
| `GROQ_API_KEY` | Groq API key (`gsk_...`) |
| `GOOGLE_API_KEY` | Google AI Studio key (`AIza...`) |
| `CEREBRAS_API_KEY` | Cerebras Cloud key (`csk_...`) |

### 4. Deploy

```bash
pnpm run deploy
```

---

## API Reference

### `POST /v1/chat/completions`

Standard OpenAI-compatible chat completions endpoint. The proxy selects a provider internally — the `model` field in the request body is used for explicit model selection or virtual models.

**Headers**

```
Authorization: Bearer YOUR_CUSTOM_API_KEY
Content-Type: application/json
```

**Body**

```json
{
  "model": "alpes-auto",  // or specific model ID like "gemini-2.5-flash"
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Explain async/await in JavaScript." }
  ],
  "temperature": 0.7,
  "max_tokens": 4096
}
```

**Virtual Models**

- `alpes-auto` — weighted rotation across all available models
- `alpes-agent` — allowlist of 1M+ models (DeepSeek V4 Flash, Gemini 3.6 Flash, Nemotron Super, Gemini 2.5 Flash, Nemotron Ultra, GLM 5.2) with explicit failover order and weights
- `alpes-small` — fast models (Nemotron Nano, Gemini 3.5 Flash Lite, Cerebras GPT-OSS, Groq) with explicit failover order and weights

**Response** — standard OpenAI `chat.completion` object with additional headers:
- `X-Model-Used` — actual model that responded
- `X-Provider-Used` — provider (`gemini`, `nvidia`, `groq`, `cerebras`)
- `X-Model-Context-Window` — max context of the model used
- `X-Fallback-Count` — number of fallbacks before success
- `X-Retry-Reason` — reason for fallback (if any)

---

### `GET /stats`

Returns daily request usage against the Cloudflare free tier limit.

**Headers**

```
Authorization: Bearer YOUR_CUSTOM_API_KEY
```

**Response**

```json
{
  "date": "2026-07-16",
  "requests": 142,
  "limit": 100000,
  "remaining": 99858,
  "alertThreshold": 90000,
  "alert": false
}
```

When `requests` reaches `alertThreshold`, the proxy logs a `WARN`-level alert visible via `pnpm wrangler tail`.

---

### `GET /health`

Returns per-model health snapshot (last success, 429s, cooldown status).

---

## Client Configuration

### Opencode

Go to **Add provider → Custom** and fill in:

| Field | Value |
|-------|-------|
| Provider ID | `free-request-api` |
| Display name | `Free Request API` |
| Base URL | `https://free-request-api.YOUR_SUBDOMAIN.workers.dev/v1` |
| API Key | your `CUSTOM_API_KEY` |
| Model ID | `alpes-auto` |
| Model Name | `Free Proxy` |

### Continue (VS Code extension)

Open `config.yaml` via **Continue panel → ⚙️ → Config** and add:

```yaml
models:
  - name: Free Request API
    provider: openai
    model: alpes-auto
    apiBase: https://free-request-api.YOUR_SUBDOMAIN.workers.dev/v1
    apiKey: YOUR_CUSTOM_API_KEY
```

---

## Providers

All providers used are free-tier with no credit card required.

| Provider | Models | RPM | RPD | Notes |
|----------|--------|-----|-----|-------|
| NVIDIA NIM | GLM 5.2, Nemotron 3 Super 120B, Nemotron 3 Nano, Nemotron 3 Ultra 550B, DeepSeek V4 Flash | ~40 | unlimited | Phone verification required |
| Groq | Llama 3.3 70B, GPT-OSS 120B | 30 | 1,000/model | Fastest inference (LPU hardware) |
| Google AI Studio | Gemini 2.5 Flash, Gemini 3.6 Flash, Gemini 3.5 Flash Lite | 15 | 1,500 | 1M token context window |
| Cerebras | GPT-OSS 120B | 2 | unlimited | Ultra-fast inference |

**Important Notes:**
- A single `NVIDIA_API_KEY` enables multiple NVIDIA models
- DeepSeek V4 Flash (`deepseek-ai/deepseek-v4-flash-0731`) is active and verified. The older model without the `-0731` suffix reached its end of life (upstream responds HTTP 410 Gone)
- `DEEPSEEK_API_KEY` is NOT used; direct DeepSeek endpoint is removed
- OpenRouter has been removed
- NVIDIA free endpoints are for development/testing, not production
- Health tracking is per-model (`provider:modelId`); throttle is per-provider
- `reasoning_effort` is sent as `incoming.reasoning_effort ?? 'low'` for Gemini 3.6 Flash, Gemini 3.5 Flash Lite and Cerebras GPT-OSS; the client's value always wins

---

## Adding a New Provider

1. Open `src/providers.ts` and add an entry to `MODEL_POOL`:

```typescript
{
  id: 'my-provider-model',
  weight: 8,
  provider: 'myprovider',
  envKey: 'MY_PROVIDER_API_KEY',
  contextWindow: 131072,
}
```

2. Add the provider URL to `PROVIDERS` record.
3. If it requires a new API key, add it to the `Env` interface in `src/types.ts`.
4. Add the secret in the Cloudflare dashboard.
5. If the provider uses a non-OpenAI request/response format, add an adapter in `src/transformer.ts`.
6. Deploy: `pnpm run deploy`

---

## Monitoring

### Real-time logs

```bash
pnpm wrangler tail
```

All logs are structured JSON. Key fields: `level`, `message`, `providerId`, `attempt`.

### Request stats

```bash
curl -s https://free-request-api.YOUR_SUBDOMAIN.workers.dev/stats \
  -H "Authorization: Bearer YOUR_CUSTOM_API_KEY" | python3 -m json.tool
```

### Cloudflare dashboard metrics

**Workers & Pages → free-request-api → Metrics** — shows request volume, error rates, and CPU time per day.

---

## Cloudflare Free Tier Limits

| Resource | Free Plan |
|----------|-----------|
| Requests | 100,000 / day |
| CPU time | 10ms / request |
| KV reads | 100,000 / day |
| KV writes | 1,000 / day |
| Memory | 128 MB |

The proxy is designed to stay well within these limits for individual developer usage. The `/stats` endpoint alerts when daily requests exceed 90,000.

---

## Security

- The `CUSTOM_API_KEY` protects the proxy from unauthorized use — treat it like a password.
- All upstream API keys are stored as encrypted Cloudflare secrets and never appear in code or logs.
- The `.dev.vars` file (local secrets) is excluded from version control via `.gitignore`.
- Never commit `.dev.vars` or any file containing raw API keys.

---

## Roadmap

- [ ] NVIDIA NIM multi-account support
- [ ] Per-provider request counter breakdown in `/stats`
- [ ] Streaming support fix for Continue/VS Code
- [ ] Webhook alert when daily limit threshold is reached
- [ ] Additional provider adapters

---

## License

MIT — see [LICENSE](LICENSE) for details.
