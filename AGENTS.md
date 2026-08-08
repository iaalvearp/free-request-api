# free-request-api — AI Proxy Multi-Proveedor

Cloudflare Worker proxy OpenAI-compatible que rota entre Gemini, NVIDIA, Groq y Cerebras.

## Comandos exactos

| Comando | Qué hace |
|---------|----------|
| `pnpm run dev` | `wrangler dev` local en puerto 8787 |
| `pnpm run test` | `vitest` con `@cloudflare/vitest-pool-workers` |
| `pnpm run test:run` | `vitest run` (sin watch) |
| `pnpm run deploy` | `wrangler deploy` |
| `pnpm run typecheck` | `tsc --noEmit` |
| `npx wrangler tail` | logs en tiempo real desde prod |
| `npx wrangler secret put KEY` | inserta secreto en prod |
| `pnpm test:nvidia` | valida modelos NVIDIA localmente |

## Reglas clave

- **Auth**: Bearer contra `env.CUSTOM_API_KEY`.
- **OpenCode detection**: `User-Agent` conteniendo "opencode" o header `X-OpenCode-Session` presente.
- **OpenCode + model en body** → usar ESE modelo exacto, NO rotar.
- **Sin OpenCode o sin model** → weighted random del pool.
- **Modelos virtuales**: `alpes-auto` (pool completo ponderado), `alpes-agent` (solo ≥1M ctx + tool calls), `alpes-small` (rápidos ≤131K).
- **Virtual never upstream**: ningún modelo virtual se envía como nombre upstream.
- **Context overflow**: ~4 chars/token. Si `contextWindow ≤ 128K` y `estimated > 50K` → 400. Si `contextWindow ≥ 1M` y `estimated > 800K` → 400.
- **Failover**: 429/503/timeout/400-context/ResourceExhausted/410-Gone → siguiente modelo del pool elegible. Máximo un intento por modelo por solicitud.
- **ResourceExhausted**: cooldown 15 min específico del modelo (no del proveedor).
- **Timeout upstream**: 25s con `AbortController`.
- **Throttle**: 1 req/s por provider (Map de timestamps en isolate).
- **Health tracking**: por modelo (`provider:modelId`) en isolate. 404/model_not_found de un modelo NVIDIA NO deshabilita otros modelos NVIDIA. 401/403 de NVIDIA SÍ deshabilita todo el proveedor.
- **Affinity**: por `sessionId + virtualRoute`. alpes-agent no afecta alpes-small ni viceversa.
- **Response headers**: `X-Model-Used`, `X-Provider-Used`, `X-Model-Context-Window`, `X-Fallback-Count`, `X-Retry-Reason`.
- **CORS**: OPTIONS responde con `Access-Control-Allow-Origin: *`.
- **Secrets**: todas via Cloudflare Secrets o `.dev.vars`, NUNCA hardcodeadas.
- **No deploy, no commit, no push** sin orden explícita.

## Pool de modelos

```
gemini-2.5-flash           | 1M | gemini
z-ai/glm-5.2               | 1M | nvidia
nvidia/nemotron-3-super-120b-a12b | 1M | nvidia
nvidia/nemotron-3-nano-30b-a3b  | 1M | nvidia
llama-3.3-70b-versatile    | 131K | groq
gpt-oss-120b               | 131K | cerebras
openai/gpt-oss-120b        | 131K | groq
```

## Rutas virtuales

| Ruta | Modelos | Contexto |
|------|---------|---------|
| alpes-auto | Todos disponibles con key | min(contextWindow) del pool |
| alpes-agent | Solo ≥1M (Gemini, NVIDIA) | min(1M) = 1_000_000 |
| alpes-small | Solo ≤131K (NVIDIA Nano, Cerebras, Groq) | min(131K) = 131_072 |

## Archivos importantes

| Archivo | Rol |
|---------|-----|
| `src/index.ts` | Handler principal |
| `src/types.ts` | Interfaces |
| `src/providers.ts` | Pool modelos, URLs |
| `src/selector.ts` | Selección, health, throttle, affinity, cooldown |
| `src/transformer.ts` | Request/Response builder |
| `src/stats.ts` | Contador diario KV |
| `src/utils.ts` | Utilidades |
| `test/index.spec.ts` | Tests Vitest |
| `docs/agent-reference.md` | Documentación detallada del proyecto |
| `opencode.jsonc` | Configuración de OpenCode |

## Prohibiciones

- `wrangler deploy`, `git commit`, `git push` solo con orden explícita.
- No mostrar secretos ni claves. Informar solo presente/ausente.
- No eliminar datos o sesiones globales de OpenCode.
