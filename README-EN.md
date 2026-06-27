# free-request-api

> Multi-provider AI proxy deployed on Cloudflare Workers — OpenAI-compatible endpoint with automatic rotation, failover, and daily request tracking.

---

## Overview

**free-request-api** is a lightweight reverse proxy that sits between your AI coding tools (Opencode, Continue, VS Code extensions) and multiple free-tier LLM providers. Instead of managing multiple API keys and rate limits manually, you point your tools to a single endpoint and the proxy handles everything transparently.

Built on **Cloudflare Workers**, it runs at the edge across 300+ global locations with sub-10ms network latency — no server to maintain, no infrastructure to manage.

---

## Features

- **Single OpenAI-compatible endpoint** — works with any tool that accepts a custom `baseURL`
- **Multi-provider pool** — NVIDIA NIM, Groq, Google AI Studio, OpenRouter, OVHcloud
- **Weighted random selection** — higher-quality models get more traffic by default
- **Automatic failover** — if a provider returns 429 or 5xx, the next one is tried seamlessly
- **Per-isolate cooldown tracker** — rate-limited providers are temporarily excluded from rotation
- **Exponential backoff with jitter** — smart retry logic on transient failures
- **Daily request counter** — tracks Cloudflare's 100k/day free tier limit via KV storage
- **Alert threshold** — warns at 90,000 requests/day before hitting the Cloudflare limit
- **Stats endpoint** — query current usage anytime via `GET /stats`
- **Zero cold-start secrets** — all API keys stored as encrypted Cloudflare secrets, never in code

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
  │     └─ Skip cooldown providers  │
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
NVIDIA_API_KEY_1=nvapi-xxxxxxxxxxxxxxxxxxxx
NVIDIA_API_KEY_2=
NVIDIA_API_KEY_3=
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GOOGLE_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxx
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
| `NVIDIA_API_KEY_1` | NVIDIA NIM account 1 (`nvapi-...`) |
| `NVIDIA_API_KEY_2` | NVIDIA NIM account 2 (optional) |
| `NVIDIA_API_KEY_3` | NVIDIA NIM account 3 (optional) |
| `GROQ_API_KEY` | Groq API key (`gsk_...`) |
| `GOOGLE_API_KEY` | Google AI Studio key (`AIza...`) |
| `OPENROUTER_API_KEY` | OpenRouter key (`sk-or-...`) |

### 4. Deploy

```bash
pnpm run deploy
```

---

## API Reference

### `POST /v1/chat/completions`

Standard OpenAI-compatible chat completions endpoint. The proxy selects a provider internally — the `model` field in the request body is ignored.

**Headers**

```
Authorization: Bearer YOUR_CUSTOM_API_KEY
Content-Type: application/json
```

**Body**

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Explain async/await in JavaScript." }
  ],
  "temperature": 0.7,
  "max_tokens": 4096
}
```

**Response** — standard OpenAI `chat.completion` object with an additional `X-Proxy-Provider` header indicating which provider handled the request.

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
  "date": "2026-06-27",
  "requests": 142,
  "limit": 100000,
  "remaining": 99858,
  "alertThreshold": 90000,
  "alert": false
}
```

When `requests` reaches `alertThreshold`, the proxy logs a `WARN`-level alert visible via `pnpm wrangler tail`.

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
| Model ID | `gpt-4o` |
| Model Name | `Free Proxy` |

### Continue (VS Code extension)

Open `config.yaml` via **Continue panel → ⚙️ → Config** and add:

```yaml
models:
  - name: Free Request API
    provider: openai
    model: gpt-4o
    apiBase: https://free-request-api.YOUR_SUBDOMAIN.workers.dev/v1
    apiKey: YOUR_CUSTOM_API_KEY
```

---

## Providers

All providers used are free-tier with no credit card required (except OpenRouter, which requires a payment method on file but does not charge for free models).

| Provider | Models | RPM | RPD | Notes |
|----------|--------|-----|-----|-------|
| NVIDIA NIM | DeepSeek V4 Flash, Nemotron Super 120B, Kimi K2.6, Qwen 3.5 122B, DeepSeek V4 Pro | ~40 | unlimited | Phone verification required |
| Groq | Llama 3.3 70B, DeepSeek R1 Distill 70B | 30 | 1,000/model | Fastest inference (LPU hardware) |
| Google AI Studio | Gemini 2.5 Flash | 15 | 1,500 | 1M token context window |
| OpenRouter | DeepSeek V4 Flash, Kimi K2.6 | 20 | 200 | 1,000/day with $10 credit |
| OVHcloud | Llama 3.3 70B | 2 | unlimited | Anonymous, no signup required |

Adding multiple NVIDIA accounts multiplies capacity linearly (each account has independent rate limits per model).

---

## Adding a New Provider

1. Open `src/providers.ts` and add an entry to `PROVIDER_POOL`:

```typescript
{
  id: 'my-provider-model',
  name: 'My Provider Model Name',
  endpoint: 'https://api.myprovider.com/v1/chat/completions',
  apiKeyEnvVar: 'MY_PROVIDER_API_KEY',
  modelId: 'model-id-expected-by-provider',
  format: 'openai',   // or 'google' for Gemini-native format
  weight: 8,          // higher = more traffic
  requiresApiKey: true,
},
```

2. If it requires a new API key, add it to the `Env` interface in `src/types.ts`.
3. Add the secret in the Cloudflare dashboard.
4. If the provider uses a non-OpenAI request/response format, add an adapter in `src/transformer.ts`.
5. Deploy: `pnpm run deploy`

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

- [ ] NVIDIA NIM multi-account support (accounts 2 and 3)
- [ ] Per-provider request counter breakdown in `/stats`
- [ ] Streaming support fix for Continue/VS Code
- [ ] Webhook alert when daily limit threshold is reached
- [ ] Additional provider adapters (Cerebras, SambaNova)

---

## License

MIT — see [LICENSE](LICENSE) for details.
