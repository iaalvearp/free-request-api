import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { getAvailableModels, MODEL_POOL, filterModelsByRoute, getVirtualContextWindow, ALT_KEYS, ROUTE_WEIGHTS } from '../src/providers';
import {
	selectWeightedModel,
	selectFallbackModel,
	selectNextUntriedModel,
	markSuccess,
	markRateLimited,
	markError,
	markResourceExhausted,
	filterAvailableModels,
	filterModelsByTried,
	checkThrottle,
	updateThrottle,
	getModelHealth,
	selectModelForRoute,
	updateAffinity,
	getAffinity,
	clearAffinity,
	resetAllHealth,
} from '../src/selector';
import type { ModelEntry } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// ─── Mock Helpers ──────────────────────────────────────────────

function openAIResponse(modelId: string, content = 'OK') {
	return JSON.stringify({
		id: 'chatcmpl-mock',
		object: 'chat.completion',
		created: Date.now(),
		model: modelId,
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
	});
}

interface MockCall {
	url: string;
	model: string;
	auth: string;
	bodyRaw: string;
}

function installMockFetch(responses: Array<{ status: number; body?: string; statusText?: string }>): {
	mock: ReturnType<typeof vi.fn>;
	calls: MockCall[];
} {
	let idx = 0;
	const calls: MockCall[] = [];

	const mock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		let bodyRaw = '';
		let model = '';
		try {
			bodyRaw = await req.text();
			model = (JSON.parse(bodyRaw).model as string) ?? '';
		} catch {
			/* noop */
		}
		const auth = req.headers.get('Authorization') ?? '';
		calls.push({ url: req.url, model, auth, bodyRaw });

		const s = responses[Math.min(idx, responses.length - 1)];
		idx++;
		return new Response(s.body ?? openAIResponse(model || 'mock'), {
			status: s.status,
			statusText: s.statusText ?? (s.status === 200 ? 'OK' : 'Error'),
			headers: { 'Content-Type': 'application/json' },
		});
	});

	vi.stubGlobal('fetch', mock);
	return { mock, calls };
}

function createMockEnv(overrides: Partial<Record<string, string>> = {}) {
	return {
		CUSTOM_API_KEY: 'test-key',
		ENVIRONMENT: 'test',
		GOOGLE_API_KEY: 'test-google-key',
		NVIDIA_API_KEY: 'test-nvidia-key',
		GROQ_API_KEY: 'test-groq-key',
		CEREBRAS_API_KEY: 'test-cerebras-key',
		PROXY_STATS: {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn().mockResolvedValue(undefined),
		},
		...overrides,
	};
}

// ─── Streaming Mock Helpers ─────────────────────────────────────

function createStreamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		statusText: 'OK',
		headers: { 'Content-Type': contentType },
	});
}

function installMockFetchStream(responses: Array<Response>): { mock: ReturnType<typeof vi.fn>; calls: MockCall[] } {
	let idx = 0;
	const calls: MockCall[] = [];

	const mock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		let bodyRaw = '';
		let model = '';
		try {
			bodyRaw = await req.text();
			model = (JSON.parse(bodyRaw).model as string) ?? '';
		} catch {
			/* noop */
		}
		const auth = req.headers.get('Authorization') ?? '';
		calls.push({ url: req.url, model, auth, bodyRaw });

		const s = responses[Math.min(idx, responses.length - 1)];
		idx++;
		return s;
	});

	vi.stubGlobal('fetch', mock);
	return { mock, calls };
}

async function readStreamBody(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(decoder.decode(value, { stream: true }));
	}
	return chunks.join('');
}

// ─── Tests ─────────────────────────────────────────────────────

describe('free-request-api Worker', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// ── Auth ────────────────────────────────────────────────────
	describe('Auth', () => {
		it('devuelve 401 sin Authorization', async () => {
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(401);
		});

		it('devuelve 401 con Authorization inválida', async () => {
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(401);
		});
	});

	// ── Routing ─────────────────────────────────────────────────
	describe('Routing', () => {
		it('devuelve 404 para rutas no reconocidas', async () => {
			const req = new IncomingRequest('http://example.com/');
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(404);
		});

		it('GET /health devuelve 200 con status ok', async () => {
			const req = new IncomingRequest('http://example.com/health');
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty('status', 'ok');
			expect(body).toHaveProperty('providers');
		});

		it('GET /stats sin auth devuelve 401', async () => {
			const req = new IncomingRequest('http://example.com/stats');
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(401);
		});

		it('OPTIONS devuelve CORS headers', async () => {
			const req = new IncomingRequest('http://example.com/v1/chat/completions', { method: 'OPTIONS' });
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		});
	});

	// ── Provider Configuration ──────────────────────────────────
	describe('Provider Configuration', () => {
		it('NVIDIA disponible cuando NVIDIA_API_KEY existe', () => {
			const models = getAvailableModels(createMockEnv());
			const nvidia = models.filter((m) => m.provider === 'nvidia');
			expect(nvidia.length).toBeGreaterThan(0);
		});

		it('NVIDIA no aparece cuando NVIDIA_API_KEY está ausente', () => {
			const models = getAvailableModels(createMockEnv({ NVIDIA_API_KEY: '' }));
			const nvidia = models.filter((m) => m.provider === 'nvidia');
			expect(nvidia.length).toBe(0);
		});

		it('Sin dependencia de DEEPSEEK_API_KEY', () => {
			const models = getAvailableModels(createMockEnv({ DEEPSEEK_API_KEY: 'test' }));
			const deepseek = models.filter((m: ModelEntry) => m.provider === 'deepseek');
			expect(deepseek.length).toBe(0);
		});

		it('Sin proveedor deepseek en pool', () => {
			const providers = [...new Set(MODEL_POOL.map((m) => m.provider))];
			expect(providers).not.toContain('deepseek');
		});

		it('Sin proveedor openrouter en pool', () => {
			const providers = [...new Set(MODEL_POOL.map((m) => m.provider))];
			expect(providers).not.toContain('openrouter');
		});

		it('IDs de modelos son únicos', () => {
			const ids = MODEL_POOL.map((m) => m.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});

	// ── Selector: selectWeightedModel ───────────────────────────
	describe('Selector: selectWeightedModel', () => {
		it('retorna un modelo del pool', () => {
			const result = selectWeightedModel(MODEL_POOL);
			expect(result).not.toBeNull();
			expect(MODEL_POOL.some((m) => m.id === result!.id)).toBe(true);
		});

		it('con Math.random()=0 retorna el primer modelo', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const result = selectWeightedModel(MODEL_POOL);
			expect(result?.id).toBe(MODEL_POOL[0].id);
		});

		it('con Math.random()≈0.99 retorna el último modelo', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0.99);
			const result = selectWeightedModel(MODEL_POOL);
			expect(result?.id).toBe(MODEL_POOL[MODEL_POOL.length - 1].id);
		});

		it('con lista vacía retorna null', () => {
			expect(selectWeightedModel([])).toBeNull();
		});
	});

	// ── Selector: selectFallbackModel ──────────────────────────
	describe('Selector: selectFallbackModel', () => {
		it('retorna el siguiente modelo del pool', () => {
			const next = selectFallbackModel(MODEL_POOL[0].id, MODEL_POOL);
			expect(next?.id).toBe(MODEL_POOL[1].id);
		});

		it('retorna null cuando está en el último', () => {
			const last = MODEL_POOL[MODEL_POOL.length - 1];
			expect(selectFallbackModel(last.id, MODEL_POOL)).toBeNull();
		});

		it('retorna null si el modelo no existe en el pool', () => {
			expect(selectFallbackModel('nonexistent', MODEL_POOL)).toBeNull();
		});

		it('selectNextUntriedModel con triedSet salta modelos ya intentados', () => {
			const tried = new Set<string>(['gemini-2.5-flash', 'z-ai/glm-5.2']);
			const result = selectNextUntriedModel('z-ai/glm-5.2', MODEL_POOL, tried);
			expect(result).not.toBeNull();
			expect(result!.id).not.toBe('gemini-2.5-flash');
			expect(result!.id).not.toBe('z-ai/glm-5.2');
		});

		it('selectNextUntriedModel con todos intentados retorna null', () => {
			const tried = new Set<string>(MODEL_POOL.map((m) => m.id));
			expect(selectNextUntriedModel(MODEL_POOL[0].id, MODEL_POOL, tried)).toBeNull();
		});
	});

	// ── Selector: Health per model ─────────────────────────────
	describe('Selector: Health per model', () => {
		it('markError en modelo A no afecta modelo B del mismo provider', () => {
			markError('nvidia', 'model-a');
			const healthA = getModelHealth('nvidia', 'model-a');
			const healthB = getModelHealth('nvidia', 'model-b');
			expect(healthA.failureCount).toBe(1);
			expect(healthB.failureCount).toBe(0);
		});

		it('markSuccess resetea consecutiveFailures', () => {
			markError('groq', 'model-x');
			markError('groq', 'model-x');
			expect(getModelHealth('groq', 'model-x').consecutiveFailures).toBe(2);
			markSuccess('groq', 'model-x');
			expect(getModelHealth('groq', 'model-x').consecutiveFailures).toBe(0);
		});

		it('filterAvailableModels excluye modelo en cooldown', () => {
			markRateLimited('cerebras', 'slow-model');
			const all: ModelEntry[] = [
				{ id: 'fast-model', weight: 1, provider: 'cerebras', envKey: 'CEREBRAS_API_KEY', contextWindow: 131_072 },
				{ id: 'slow-model', weight: 1, provider: 'cerebras', envKey: 'CEREBRAS_API_KEY', contextWindow: 131_072 },
			];
			const available = filterAvailableModels(all);
			expect(available.some((m) => m.id === 'slow-model')).toBe(false);
			expect(available.some((m) => m.id === 'fast-model')).toBe(true);
		});
	});

	// ── Selector: Throttle per provider ────────────────────────
	describe('Selector: Throttle per provider', () => {
		it('updateThrottle bloquea el mismo proveedor', () => {
			updateThrottle('nvidia');
			expect(checkThrottle('nvidia')).not.toBeNull();
		});

		it('throttle no afecta a otro proveedor', () => {
			updateThrottle('nvidia');
			expect(checkThrottle('groq')).toBeNull();
		});
	});

	// ── filterModelsByRoute ─────────────────────────────────────
	describe('filterModelsByRoute', () => {
		it('alpes-agent excluye modelos < 1M y excluye Nemotron Nano', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-agent');
			for (const m of result) {
				expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
			}
			expect(result.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(false);
			expect(result.length).toBeLessThan(MODEL_POOL.length);
		});

		it('alpes-small incluye Nemotron Nano, Cerebras y Groq', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-small');
			const ids = result.map((m) => m.id);
			expect(ids).toContain('nvidia/nemotron-3-nano-30b-a3b');
			expect(ids).toContain('gpt-oss-120b');
			expect(ids).toContain('llama-3.3-70b-versatile');
			expect(ids).toContain('openai/gpt-oss-120b');
			expect(result.length).toBe(4);
		});

		it('alpes-auto incluye todos los modelos', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-auto');
			expect(result.length).toBe(MODEL_POOL.length);
		});
	});

	// ── Virtual Route alpes-agent ──────────────────────────────
	describe('Virtual Route alpes-agent', () => {
		it('alpes-agent nunca se envía upstream', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-agent' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			for (const call of calls) {
				expect(call.model).not.toBe('alpes-agent');
				expect(call.model).not.toBe('alpes-small');
			}
		});

		it('alpes-agent no existe en MODEL_POOL', () => {
			expect(MODEL_POOL.some((m) => m.id === 'alpes-agent')).toBe(false);
		});
	});

	// ── Virtual Route alpes-small ──────────────────────────────
	describe('Virtual Route alpes-small', () => {
		it('alpes-small nunca se envía upstream', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			for (const call of calls) {
				expect(call.model).not.toBe('alpes-small');
				expect(call.model).not.toBe('alpes-agent');
			}
		});

		it('alpes-small no existe en MODEL_POOL', () => {
			expect(MODEL_POOL.some((m) => m.id === 'alpes-small')).toBe(false);
		});
	});

	// ── ResourceExhausted ───────────────────────────────────────
	describe('ResourceExhausted', () => {
		it('ResourceExhausted 503 activa fallback al siguiente modelo', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const resourceExhaustedBody = JSON.stringify({
				error: { message: 'ResourceExhausted: Worker local total request limit reached' },
			});
			const { calls } = installMockFetch([{ status: 503, body: resourceExhaustedBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(res.status).toBe(200);
		});

		it('ResourceExhausted 429 quota exhausted activa fallback', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const quotaBody = JSON.stringify({ error: { message: 'Quota exhausted for today' } });
			const { calls } = installMockFetch([{ status: 429, body: quotaBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(res.status).toBe(200);
		});

		it('ResourceExhausted no llega al usuario si el siguiente modelo responde 200', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const reBody = JSON.stringify({ error: { message: 'capacity exhausted' } });
			const { calls } = installMockFetch([{ status: 503, body: reBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).not.toContain('ResourceExhausted');
			expect(body).not.toContain('capacity exhausted');
		});

		it('markResourceExhausted activa cooldown de 15 min en el modelo', () => {
			clearAffinity('test', 'alpes-agent');
			markResourceExhausted('nvidia', 'test-model');
			const health = getModelHealth('nvidia', 'test-model');
			const now = Date.now();
			expect(health.cooldownUntil).toBeGreaterThan(now + 10 * 60 * 1000);
		});
	});

	// ── No duplicate attempts ──────────────────────────────────
	describe('No duplicate attempts', () => {
		it('el mismo modelo no se intenta dos veces en una solicitud', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch(Array(20).fill({ status: 503 }));
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const attemptedModels = calls.map((c) => c.model);
			const uniqueModels = new Set(attemptedModels);
			expect(uniqueModels.size).toBe(attemptedModels.length);
			expect(res.status).toBe(502);
		});

		it('máximo de intentos = número de modelos elegibles', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch(Array(20).fill({ status: 503 }));
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const eligibleCount = getAvailableModels(createMockEnv()).length;
			expect(calls.length).toBeLessThanOrEqual(eligibleCount);
		});
	});

	// ── Affinity ────────────────────────────────────────────────
	describe('Affinity', () => {
		beforeEach(() => {
			resetAllHealth();
			clearAffinity('test-session', 'alpes-agent');
			clearAffinity('test-session', 'alpes-small');
		});

		it('updateAffinity almacena modelo y proveedor correctos', () => {
			updateAffinity('test-session', 'alpes-agent', 'gemini-2.5-flash', 'gemini');
			const aff = getAffinity('test-session', 'alpes-agent');
			expect(aff).toBeDefined();
			expect(aff!.modelId).toBe('gemini-2.5-flash');
			expect(aff!.provider).toBe('gemini');
		});

		it('affinity de alpes-agent no afecta alpes-small', () => {
			updateAffinity('test-session', 'alpes-agent', 'gemini-2.5-flash', 'gemini');
			const agentAff = getAffinity('test-session', 'alpes-agent');
			const smallAff = getAffinity('test-session', 'alpes-small');
			expect(agentAff).toBeDefined();
			expect(smallAff).toBeUndefined();
		});

		it('affinity de diferentes sesiones no se mezcla', () => {
			updateAffinity('session-A', 'alpes-agent', 'model-a', 'gemini');
			updateAffinity('session-B', 'alpes-agent', 'model-b', 'nvidia');
			const affA = getAffinity('session-A', 'alpes-agent');
			const affB = getAffinity('session-B', 'alpes-agent');
			expect(affA!.modelId).toBe('model-a');
			expect(affB!.modelId).toBe('model-b');
		});

		it('selectModelForRoute respeta afinidad existente cuando el modelo está disponible', () => {
			updateAffinity('test-session', 'alpes-agent', 'gemini-2.5-flash', 'gemini');
			const result = selectModelForRoute(MODEL_POOL, 'alpes-agent', 'test-session', new Set<string>());
			expect(result).not.toBeNull();
			expect(result!.id).toBe('gemini-2.5-flash');
		});
	});

	// ── Virtual Model ───────────────────────────────────────────────
	describe('Virtual Model', () => {
		it('alpes-agent anuncia el contexto mínimo correcto', () => {
			const ctx = getVirtualContextWindow(MODEL_POOL, 'alpes-agent');
			expect(ctx).toBeGreaterThanOrEqual(1_000_000);
		});

		it('alpes-small anuncia el contexto mínimo correcto', () => {
			const ctx = getVirtualContextWindow(MODEL_POOL, 'alpes-small');
			expect(ctx).toBeLessThanOrEqual(131_072);
		});
	});

	// ── Nemotron Nano ──────────────────────────────────────────
	describe('Nemotron Nano', () => {
		it('Nano se habilita con NVIDIA_API_KEY', () => {
			const models = getAvailableModels(createMockEnv());
			expect(models.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(true);
		});

		it('Nano no se habilita sin NVIDIA_API_KEY', () => {
			const models = getAvailableModels(createMockEnv({ NVIDIA_API_KEY: '' }));
			expect(models.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(false);
		});

		it('Nano pertenece a alpes-small', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-small');
			expect(result.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(true);
		});

		it('Nano pertenece a alpes-auto', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-auto');
			expect(result.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(true);
		});

		it('Nano no pertenece a alpes-agent', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-agent');
			expect(result.some((m) => m.id === 'nvidia/nemotron-3-nano-30b-a3b')).toBe(false);
		});

		it('Nano envía chat_template_kwars y temperature 0.6 por defecto', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'nvidia/nemotron-3-nano-30b-a3b' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			const body = JSON.parse(calls[0].bodyRaw);
			expect(body.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
			expect(body.temperature).toBe(0.6);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		});

		it('Nano tiene ~66.7% del peso de alpes-small con ROUTE_WEIGHTS', () => {
			const weights = ROUTE_WEIGHTS['alpes-small']!;
			const total = Object.values(weights).reduce((a, b) => a + b, 0);
			expect(total).toBe(15);
			expect(weights['nvidia/nemotron-3-nano-30b-a3b'] / total).toBeCloseTo(0.667, 1);
			const smallModels = filterModelsByRoute(MODEL_POOL, 'alpes-small');
			vi.spyOn(Math, 'random').mockReturnValue(0);
			expect(selectWeightedModel(smallModels, weights)?.id).toBe('nvidia/nemotron-3-nano-30b-a3b');
			vi.spyOn(Math, 'random').mockReturnValue(10 / 15 - 0.001);
			expect(selectWeightedModel(smallModels, weights)?.id).toBe('nvidia/nemotron-3-nano-30b-a3b');
			vi.spyOn(Math, 'random').mockReturnValue(10 / 15 + 0.001);
			expect(selectWeightedModel(smallModels, weights)?.id).toBe('gpt-oss-120b');
		});

		it('Nano no desplaza modelos principales de alpes-agent', () => {
			const agentModels = filterModelsByRoute(MODEL_POOL, 'alpes-agent');
			const agentIds = agentModels.map((m) => m.id);
			expect(agentIds).toContain('gemini-2.5-flash');
			expect(agentIds).toContain('z-ai/glm-5.2');
			expect(agentIds).toContain('nvidia/nemotron-3-super-120b-a12b');
			expect(agentIds).not.toContain('nvidia/nemotron-3-nano-30b-a3b');
		});

		it('Cerebras gpt-oss-120b es el segundo modelo del failover de alpes-small', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 503 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			expect(calls.length).toBe(2);
			expect(calls[0].model).toBe('nvidia/nemotron-3-nano-30b-a3b');
			expect(calls[1].model).toBe('gpt-oss-120b');
		});

		it('Nano responde sin llamar a ningún respaldo', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			expect(calls[0].model).toBe('nvidia/nemotron-3-nano-30b-a3b');
			expect(res.status).toBe(200);
		});

		it('Nano falla y Cerebras gpt-oss-120b responde sin llegar a Groq', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 503 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(calls[1].model).toBe('gpt-oss-120b');
			expect(res.status).toBe(200);
		});
	});

	// ── Cerebras gpt-oss-120b ──────────────────────────────────
	describe('Cerebras gpt-oss-120b', () => {
		it('el modelo retirado llama-3.3-70b (Cerebras) ya no aparece en MODEL_POOL', () => {
			expect(MODEL_POOL.some((m) => m.id === 'llama-3.3-70b' && m.provider === 'cerebras')).toBe(false);
		});

		it('Cerebras gpt-oss-120b pertenece a alpes-small', () => {
			const result = filterModelsByRoute(MODEL_POOL, 'alpes-small');
			expect(result.some((m) => m.id === 'gpt-oss-120b' && m.provider === 'cerebras')).toBe(true);
		});

		it('Cerebras gpt-oss-120b conserva peso 3 en MODEL_POOL', () => {
			const entry = MODEL_POOL.find((m) => m.id === 'gpt-oss-120b' && m.provider === 'cerebras');
			expect(entry).toBeDefined();
			expect(entry!.weight).toBe(3);
		});

		it('Cerebras gpt-oss-120b conserva peso 3 en ROUTE_WEIGHTS alpes-small', () => {
			const weight = ROUTE_WEIGHTS['alpes-small']!['gpt-oss-120b'];
			expect(weight).toBe(3);
		});

		it('Cerebras gpt-oss-120b es el segundo modelo del failover de alpes-small', () => {
			const smallModels = filterModelsByRoute(MODEL_POOL, 'alpes-small');
			const idx = smallModels.findIndex((m) => m.id === 'gpt-oss-120b');
			expect(idx).toBe(1);
			expect(smallModels[0].id).toBe('nvidia/nemotron-3-nano-30b-a3b');
			expect(smallModels[idx].provider).toBe('cerebras');
		});

		it('Cerebras gpt-oss-120b recibe reasoning_effort: "low" por defecto', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'gpt-oss-120b' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			const body = JSON.parse(calls[0].bodyRaw);
			expect(body.model).toBe('gpt-oss-120b');
			expect(body.reasoning_effort).toBe('low');
		});

		it('Cerebras gpt-oss-120b respeta reasoning_effort enviado por el cliente', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'test' }],
					model: 'gpt-oss-120b',
					reasoning_effort: 'high',
				}),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			const body = JSON.parse(calls[0].bodyRaw);
			expect(body.reasoning_effort).toBe('high');
		});

		it('Cerebras gpt-oss-120b no altera el modelo openai/gpt-oss-120b de Groq', () => {
			const groqEntry = MODEL_POOL.find((m) => m.id === 'openai/gpt-oss-120b' && m.provider === 'groq');
			expect(groqEntry).toBeDefined();
			expect(groqEntry!.provider).toBe('groq');
			const cerebrasEntry = MODEL_POOL.find((m) => m.id === 'gpt-oss-120b' && m.provider === 'cerebras');
			expect(cerebrasEntry).toBeDefined();
			expect(cerebrasEntry!.id).not.toBe(groqEntry!.id);
			expect(cerebrasEntry!.provider).not.toBe(groqEntry!.provider);
		});

		it('gpt-oss-120b como modelo de Cerebras tiene envKey CEREBRAS_API_KEY', () => {
			const entry = MODEL_POOL.find((m) => m.id === 'gpt-oss-120b' && m.provider === 'cerebras');
			expect(entry).toBeDefined();
			expect(entry!.envKey).toBe('CEREBRAS_API_KEY');
		});
	});

	// ── X-Headers ──────────────────────────────────────────────
	describe('X-Headers', () => {
		it('X-Model-Used y X-Provider-Used identifican modelo exitoso tras fallback', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 500 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const modelUsed = res.headers.get('X-Model-Used');
			const providerUsed = res.headers.get('X-Provider-Used');
			expect(modelUsed).toBe(calls[1].model);
			expect(modelUsed).not.toBe(calls[0].model);
			expect(providerUsed).toBeTruthy();
		});
	});

	// ── Virtual Model alpes-auto ───────────────────────────────
	describe('Virtual Model alpes-auto', () => {
		it('alpes-auto no existe en MODEL_POOL', () => {
			expect(MODEL_POOL.some((m) => m.id === 'alpes-auto')).toBe(false);
		});

		it('alpes-auto resuelve a un modelo del pool real', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-auto' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			expect(calls[0].model).not.toBe('alpes-auto');
			expect(MODEL_POOL.some((m) => m.id === calls[0].model)).toBe(true);
			expect(res.status).toBe(200);
		});

		it('los pesos de alpes-auto permanecen sin cambios (iguales a MODEL_POOL)', () => {
			const autoModels = filterModelsByRoute(MODEL_POOL, 'alpes-auto');
			for (const m of autoModels) {
				const poolEntry = MODEL_POOL.find((p) => p.id === m.id)!;
				expect(m.weight).toBe(poolEntry.weight);
			}
		});

		it('alpes-auto no envía alpes-auto como modelo upstream', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-auto' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			for (const call of calls) {
				expect(call.model).not.toBe('alpes-auto');
			}
		});
	});

	// ── Failover Behavior ──────────────────────────────────────
	describe('Failover Behavior', () => {
		it('respuesta 200 detiene el failover (1 sola llamada)', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			expect(res.status).toBe(200);
		});

		it('respuesta 500 provoca segundo intento', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 500 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(calls[0].model).not.toBe(calls[1].model);
			expect(res.status).toBe(200);
		});

		it('429 provoca failover al siguiente modelo', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([{ status: 429 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(res.status).toBe(200);
		});

		it('400 context_length_exceeded provoca failover', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([
				{ status: 400, body: JSON.stringify({ error: { message: 'context_length_exceeded: max 131072' } }) },
				{ status: 200 },
			]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(res.status).toBe(200);
		});

		it('400 model_not_found provoca failover', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const { calls } = installMockFetch([
				{ status: 400, body: JSON.stringify({ error: { message: 'model not found: xyz' } }) },
				{ status: 200 },
			]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(res.status).toBe(200);
		});

		it('400 no-context retorna al cliente sin failover', async () => {
			const { calls } = installMockFetch([{ status: 400, body: JSON.stringify({ error: { message: 'invalid_request: bad parameter' } }) }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			expect(res.status).toBe(400);
		});

		it('modelo solicitado explícitamente es el primer intento', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'gemini-2.5-flash' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			expect(calls[0].model).toBe('gemini-2.5-flash');
		});

		it('todos los proveedores fallan → 502', async () => {
			const { calls } = installMockFetch(Array(20).fill({ status: 500 }));
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(502);
			expect(calls.length).toBeGreaterThanOrEqual(2);
			expect(calls.length).toBeLessThanOrEqual(getAvailableModels(createMockEnv()).length);
		});

		it('context overflow detectado antes de enviar retorna 400 sin llamadas upstream', async () => {
			const { calls } = installMockFetch([]);
			const longContent = 'x'.repeat(600_000);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: longContent }],
					model: 'llama-3.3-70b-versatile',
				}),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(0);
			expect(res.status).toBe(400);
			expect(res.headers.get('X-Reason')).toBe('context-too-large-for-model');
		});
	});

	// ── Failover Loop Fix ──────────────────────────────────────
	describe('Failover Loop Fix', () => {
		beforeEach(() => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			resetAllHealth();
		});

		it('si los dos primeros modelos fallan, se intenta el tercero', async () => {
			const { calls } = installMockFetch([{ status: 503 }, { status: 503 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(3);
		});

		it('si el tercero funciona, se devuelve su respuesta', async () => {
			const { calls } = installMockFetch([{ status: 503 }, { status: 503 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const modelUsed = res.headers.get('X-Model-Used');
			expect(modelUsed).toBe(calls[2].model);
		});

		it('si todos fallan, cada modelo se intentó una sola vez', async () => {
			const { calls } = installMockFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(502);
			expect(calls.length).toBe(4);
			const models = calls.map((c) => c.model);
			const uniqueModels = new Set(models);
			expect(uniqueModels.size).toBe(4);
		});

		it('varias claves para un modelo no terminan el bucle prematuramente', { timeout: 15000 }, async () => {
			const prev = ALT_KEYS['groq'];
			ALT_KEYS['groq'] = ['GROQ_ALT_KEY_1'];
			try {
				const { calls } = installMockFetch(Array(6).fill({ status: 503 }));
				const req = new IncomingRequest('http://example.com/v1/chat/completions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
					body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
				});
				const ctx = createExecutionContext();
				const res = await worker.fetch(
					req,
					createMockEnv({
						GROQ_ALT_KEY_1: 'test-groq-alt-1',
					}),
					ctx,
				);
				await waitOnExecutionContext(ctx);
				expect(res.status).toBe(502);
				// Nano (nvidia): 1 key → 1, gpt-oss-120b (cerebras): 1 key → 1, llama-3.3-70b-versatile (groq): 2 keys → 2, openai/gpt-oss-120b (groq): 2 keys → 2
				expect(calls.length).toBe(6);
				const models = calls.map((c) => c.model);
				const uniqueModels = new Set(models);
				expect(uniqueModels.size).toBe(4);
			} finally {
				if (prev) {
					ALT_KEYS['groq'] = prev;
				} else {
					delete ALT_KEYS['groq'];
				}
			}
		});

		it('ningún modelo se repite', async () => {
			const { calls } = installMockFetch(Array(20).fill({ status: 503 }));
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'alpes-small' }),
			});
			const ctx = createExecutionContext();
			await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const models = calls.map((c) => c.model);
			const uniqueModels = new Set(models);
			expect(uniqueModels.size).toBe(models.length);
		});
	});

	// ── Error Handling ─────────────────────────────────────────
	describe('Error Handling', () => {
		it('/health no expone claves', async () => {
			const req = new IncomingRequest('http://example.com/health');
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			const bodyStr = JSON.stringify(await res.json());
			expect(bodyStr).not.toContain('test-key');
			expect(bodyStr).not.toContain('test-google-key');
			expect(bodyStr).not.toContain('test-nvidia-key');
		});

		it('respuesta de error no contiene la API key del cliente', async () => {
			const realKey = 'super-secret-api-key-12345678';
			installMockFetch([{ status: 500 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realKey}` },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv({ CUSTOM_API_KEY: realKey }), ctx);
			await waitOnExecutionContext(ctx);
			const body = await res.text();
			expect(body).not.toContain(realKey);
		});

		it('401 con key inválida no expone key en body', async () => {
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer some-wrong-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			const body = await res.text();
			expect(body).not.toContain('some-wrong-key');
			expect(res.status).toBe(401);
		});
	});

	// ── Response Headers ───────────────────────────────────────
	describe('Response Headers', () => {
		it('X-Model-Used contiene el modelo real solicitado', async () => {
			installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'gemini-2.5-flash' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get('X-Model-Used')).toBe('gemini-2.5-flash');
		});

		it('X-Provider-Used contiene el proveedor real', async () => {
			installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'gemini-2.5-flash' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get('X-Provider-Used')).toBe('gemini');
		});

		it('X-Fallback-Count refleja el número de fallbacks', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			installMockFetch([{ status: 500 }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get('X-Fallback-Count')).toBe('1');
		});

		it('Authorization se envía al upstream pero no aparece en la respuesta', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], model: 'gemini-2.5-flash' }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls[0].auth).toContain('Bearer');
			expect(calls[0].auth.length).toBeGreaterThan(10);
			expect(res.headers.get('Authorization')).toBeNull();
		});
	});

	// ── normalizeMessagesForModel ───────────────────────────────
	describe('normalizeMessagesForModel', () => {
		it('elimina reasoning_content de TODOS los assistant, conserva content y tool_calls, no muta original', async () => {
			const { normalizeMessagesForModel } = await import('../src/transformer');

			const original = [
				{ role: 'user', content: 'Pregunta 1' },
				{ role: 'assistant', content: 'Respuesta 1', reasoning_content: 'razonamiento 1', extra: 'ignorado' },
				{ role: 'user', content: 'Pregunta 2' },
				{
					role: 'assistant',
					content: 'Respuesta 2',
					reasoning_content: 'razonamiento 2',
					tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
				},
				{ role: 'tool', content: 'Resultado tool', tool_call_id: 'call_1' },
				{ role: 'user', content: 'Pregunta 3' },
			];

			const normalized = normalizeMessagesForModel(original as any);

			// 1. Recorrió todos — misma cantidad
			expect(normalized.length).toBe(6);

			// 2. Ningún assistant envía reasoning_content
			for (const msg of normalized) {
				if (msg.role === 'assistant') {
					expect(msg).not.toHaveProperty('reasoning_content');
				}
			}

			// 3. Ambos content permanecen
			expect(normalized[1].content).toBe('Respuesta 1');
			expect(normalized[3].content).toBe('Respuesta 2');

			// 4. tool_calls permanece
			expect(normalized[3].tool_calls).toBeDefined();
			expect(Array.isArray(normalized[3].tool_calls)).toBe(true);

			// 5. tool_call_id permanece
			expect(normalized[4].tool_call_id).toBe('call_1');

			// 6. Número y orden de mensajes permanece
			expect(normalized[0].role).toBe('user');
			expect(normalized[1].role).toBe('assistant');
			expect(normalized[2].role).toBe('user');
			expect(normalized[3].role).toBe('assistant');
			expect(normalized[4].role).toBe('tool');
			expect(normalized[5].role).toBe('user');

			// 7. Objeto original no fue modificado
			expect(original[1]).toHaveProperty('reasoning_content');
			expect(original[3]).toHaveProperty('reasoning_content');
			expect(original[3]).toHaveProperty('tool_calls');
		});
	});

	// ── Failover: reasoning_content 400 ─────────────────────────
	describe('Failover: reasoning_content 400', () => {
		it('400 reasoning_content en primer modelo → failover al segundo con historial normalizado', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);

			const firstBody = JSON.stringify({
				error: { message: "property 'messages.2.assistant.reasoning_content' is unsupported" },
			});
			const { calls } = installMockFetch([{ status: 400, body: firstBody }, { status: 200 }]);

			const reasoningHistory = [
				{ role: 'user', content: 'q1' },
				{ role: 'assistant', content: 'a1', reasoning_content: 'r1' },
				{ role: 'user', content: 'q2' },
				{ role: 'assistant', content: 'a2', reasoning_content: 'r2' },
				{ role: 'user', content: 'q3' },
			];

			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: reasoningHistory }),
			});

			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);

			// 1. hubo exactamente dos intentos
			expect(calls.length).toBe(2);

			// 2. los modelos son diferentes (primer intento falló, segundo continuó)
			expect(calls[0].model).not.toBe(calls[1].model);

			// 3. Ningún intento envió reasoning_content upstream (normalización preventiva)
			for (let i = 0; i < calls.length; i++) {
				const parsed = JSON.parse(calls[i].bodyRaw);
				for (const m of parsed.messages) {
					if (m.role === 'assistant') {
						expect(m).not.toHaveProperty('reasoning_content');
					}
				}
			}

			// 4. X-Fallback-Count es 1
			expect(res.headers.get('X-Fallback-Count')).toBe('1');

			// 5. X-Model-Used identifica el segundo modelo (después de fallback)
			const modelUsed = res.headers.get('X-Model-Used');
			expect(modelUsed).not.toBe(calls[0].model);
			expect(modelUsed).toBeTruthy();

			// 6. el error 400 no llegó al usuario
			expect(res.status).toBe(200);
		});
	});

	// ── Three-turn conversation ─────────────────────────────────
	describe('Three-turn conversation', () => {
		it('tres turnos con alpes-auto: historia crece, normalización progresiva, failover en turno 3', async () => {
			vi.spyOn(Math, 'random').mockReturnValue(0);

			// Mock responses for all 4 upstream calls across 3 turns
			const turn1Response = JSON.stringify({
				id: 'chatcmpl-1',
				object: 'chat.completion',
				created: 1000,
				model: 'gemini-2.5-flash',
				choices: [
					{ index: 0, message: { role: 'assistant', content: 'Answer 1', reasoning_content: 'thinking...' }, finish_reason: 'stop' },
				],
			});
			const turn2Response = openAIResponse('gemini-2.5-flash', 'Answer 2');
			const reasoning400Body = JSON.stringify({ error: { message: "property 'messages.1.assistant.reasoning_content' is unsupported" } });
			const turn3Response = openAIResponse('z-ai/glm-5.2', 'Answer 3');

			const allCalls: Array<{ url: string; body: string }> = [];
			const mock = vi
				.fn()
				.mockImplementationOnce(async (input) => {
					const req = input instanceof Request ? input : new Request(input);
					allCalls.push({ url: req.url, body: await req.text() });
					return new Response(turn1Response, { status: 200, headers: { 'Content-Type': 'application/json' } });
				})
				.mockImplementationOnce(async (input) => {
					const req = input instanceof Request ? input : new Request(input);
					allCalls.push({ url: req.url, body: await req.text() });
					return new Response(turn2Response, { status: 200, headers: { 'Content-Type': 'application/json' } });
				})
				.mockImplementationOnce(async (input) => {
					const req = input instanceof Request ? input : new Request(input);
					allCalls.push({ url: req.url, body: await req.text() });
					return new Response(reasoning400Body, { status: 400, headers: { 'Content-Type': 'application/json' } });
				})
				.mockImplementationOnce(async (input) => {
					const req = input instanceof Request ? input : new Request(input);
					allCalls.push({ url: req.url, body: await req.text() });
					return new Response(turn3Response, { status: 200, headers: { 'Content-Type': 'application/json' } });
				});

			vi.stubGlobal('fetch', mock);

			// ── Turn 1 ──
			const res1 = await worker.fetch(
				new IncomingRequest('http://example.com/v1/chat/completions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
					body: JSON.stringify({
						model: 'alpes-auto',
						messages: [{ role: 'user', content: 'First question' }],
					}),
				}),
				createMockEnv(),
				createExecutionContext(),
			);
			await waitOnExecutionContext(createExecutionContext());
			expect(res1.status).toBe(200);

			// ── Turn 2: history includes assistant with reasoning_content (as returned by model A) ──
			const history2 = [
				{ role: 'user', content: 'First question' },
				{ role: 'assistant', content: 'Answer 1', reasoning_content: 'thinking...' },
				{ role: 'user', content: 'Second question' },
			];
			const res2 = await worker.fetch(
				new IncomingRequest('http://example.com/v1/chat/completions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
					body: JSON.stringify({ model: 'alpes-auto', messages: history2 }),
				}),
				createMockEnv(),
				createExecutionContext(),
			);
			await waitOnExecutionContext(createExecutionContext());
			expect(res2.status).toBe(200);

			// ── Turn 3: model A (gemini) returns 400 reasoning → model B (glm) returns 200 ──
			const history3 = [
				...history2,
				{ role: 'assistant', content: 'Answer 2', reasoning_content: 'more thinking...' },
				{ role: 'user', content: 'Third question' },
			];
			const res3 = await worker.fetch(
				new IncomingRequest('http://example.com/v1/chat/completions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
					body: JSON.stringify({ model: 'alpes-auto', messages: history3 }),
				}),
				createMockEnv(),
				createExecutionContext(),
			);
			await waitOnExecutionContext(createExecutionContext());
			expect(res3.status).toBe(200);

			// ── Assertions ──
			expect(allCalls.length).toBe(4);
			// Turn 3's second upstream call (index 3) must have normalized messages (no reasoning_content)
			const turn3Body = JSON.parse(allCalls[3].body);
			const turn3AssistantMsgs = turn3Body.messages.filter((m: any) => m.role === 'assistant');
			for (const m of turn3AssistantMsgs) {
				expect(m).not.toHaveProperty('reasoning_content');
			}
			// Model used in Turn 3 response must be model B
			expect(res3.headers.get('X-Model-Used')).toMatch(/glm/);
			// Fallback count in Turn 3 must be 1
			expect(res3.headers.get('X-Fallback-Count')).toBe('1');
		});
	});

	// ── Streaming Behavior ──────────────────────────────────────
	describe('Streaming Behavior', () => {
		beforeEach(() => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
		});

		it('stream:false devuelve JSON completo', async () => {
			const { calls } = installMockFetch([{ status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(1);
			const body = await res.json();
			expect(body).toHaveProperty('choices');
			expect(body.choices[0].message.content).toBe('OK');
		});

		it('stream:false registra éxito una sola vez (no duplicado)', async () => {
			resetAllHealth();
			installMockFetch([{ status: 200 }]);
			const healthBefore = getModelHealth('gemini', 'gemini-2.5-flash');
			expect(healthBefore.successCount).toBe(0);

			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);

			const healthAfter = getModelHealth('gemini', 'gemini-2.5-flash');
			// successCount should be exactly 1 (not 2)
			expect(healthAfter.successCount).toBe(1);
		});

		it('stream:true entrega el primer fragmento antes del segundo', async () => {
			const chunks = ['data: {"content":"first"}\n\n', 'data: {"content":"second"}\n\n', 'data: [DONE]\n\n'];
			const streamRes = createStreamResponse(chunks);
			installMockFetchStream([streamRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'stream me' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);

			expect(res.status).toBe(200);
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			const { value: firstValue } = await reader.read();
			const firstChunk = decoder.decode(firstValue!, { stream: true });
			expect(firstChunk).toBe(chunks[0]);

			// Read the rest
			let rest = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				rest += decoder.decode(value, { stream: true });
			}
			expect(firstChunk + rest).toBe(chunks.join(''));
		});

		it('los fragmentos SSE se conservan byte por byte', async () => {
			const chunks = ['data: {"delta":"hello"}\n\n', 'data: {"delta":" world"}\n\n', 'data: [DONE]\n\n'];
			const streamRes = createStreamResponse(chunks);
			installMockFetchStream([streamRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const body = await readStreamBody(res);
			expect(body).toBe(chunks.join(''));
		});

		it('tool_calls fragmentados se conservan', async () => {
			const chunks = [
				'data: {"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}\n\n',
				'data: {"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":\\"Madrid\\"}"}}]}}\n\n',
				'data: [DONE]\n\n',
			];
			const streamRes = createStreamResponse(chunks);
			installMockFetchStream([streamRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'weather' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const body = await readStreamBody(res);
			expect(body).toContain('tool_calls');
			expect(body).toContain('get_weather');
			expect(body).toContain('Madrid');
		});

		it('un 429 anterior al stream activa failover', async () => {
			const successChunks = ['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n'];
			const successRes = createStreamResponse(successChunks);
			const mock = vi
				.fn()
				.mockImplementationOnce(async () => new Response('rate limited', { status: 429, headers: { 'Content-Type': 'application/json' } }))
				.mockImplementationOnce(async () => successRes);
			vi.stubGlobal('fetch', mock);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const body = await readStreamBody(res);
			expect(body).toContain('ok');
			expect(mock.mock.calls.length).toBe(2);
		});

		it('un HTTP 200 con body null activa failover', async () => {
			const successChunks = ['data: {"content":"ok"}\n\n'];
			const successRes = createStreamResponse(successChunks);
			const nullBodyRes = new Response(null, { status: 200, headers: { 'Content-Type': 'text/plain' } });
			const mock = vi
				.fn()
				.mockImplementationOnce(async () => nullBodyRes)
				.mockImplementationOnce(async () => successRes);
			vi.stubGlobal('fetch', mock);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const body = await readStreamBody(res);
			expect(body).toContain('ok');
			expect(mock.mock.calls.length).toBe(2);
		});

		it('un error en el stream no provoca nueva llamada upstream', async () => {
			const encoder = new TextEncoder();
			const erroredStream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"content":"partial"}\n\n'));
					controller.error(new Error('simulated stream error'));
				},
			});
			const errorRes = new Response(erroredStream, {
				status: 200,
				statusText: 'OK',
				headers: { 'Content-Type': 'text/event-stream' },
			});
			const { calls } = installMockFetchStream([errorRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			// Only 1 upstream call despite stream error (no failover after streaming starts)
			expect(calls.length).toBe(1);
		});

		it('Content-Type y cabeceras X-* se conservan en stream', async () => {
			const streamRes = createStreamResponse(['data: {"content":"ok"}\n\n']);
			installMockFetchStream([streamRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get('Content-Type')).toBe('text/event-stream');
			expect(res.headers.get('X-Model-Used')).toBeTruthy();
			expect(res.headers.get('X-Provider-Used')).toBeTruthy();
			expect(res.headers.get('X-Fallback-Count')).toBe('0');
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		});

		it('el body upstream no se consume dos veces', async () => {
			const chunks = ['data: {"content":"single use"}\n\n', 'data: [DONE]\n\n'];
			const streamRes = createStreamResponse(chunks);
			installMockFetchStream([streamRes]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			// The response body should be a ReadableStream (not a string)
			expect(res.body).toBeInstanceOf(ReadableStream);
			// Reading the stream should return the exact content
			const body = await readStreamBody(res);
			expect(body).toBe(chunks.join(''));
		});
	});

	// ── HTTP 410 Gone (modelo retirado) ────────────────────────
	describe('HTTP 410 Gone (modelo retirado)', () => {
		beforeEach(() => {
			vi.spyOn(Math, 'random').mockReturnValue(0);
			resetAllHealth();
		});

		it('primer modelo devuelve 410 → se intenta otro', async () => {
			const goneBody = JSON.stringify({ error: { message: 'model has reached its end of life' } });
			const { calls } = installMockFetch([{ status: 410, body: goneBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(2);
			expect(calls[0].model).toBe('gemini-2.5-flash');
			expect(calls[1].model).not.toBe('gemini-2.5-flash');
		});

		it('segundo modelo responde 200 → el cliente recibe 200', async () => {
			const goneBody = JSON.stringify({ error: { message: 'Gone: end of life' } });
			const { calls } = installMockFetch([{ status: 410, body: goneBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			expect(res.headers.get('X-Model-Used')).toBe(calls[1].model);
			expect(res.headers.get('X-Fallback-Count')).toBe('1');
		});

		it('el modelo que devolvió 410 no vuelve a intentarse en ese recorrido', async () => {
			const goneBody = JSON.stringify({ error: { message: 'end of life' } });
			const { calls } = installMockFetch([{ status: 410, body: goneBody }, { status: 410, body: goneBody }, { status: 200 }]);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(calls.length).toBe(3);
			const models = calls.map((c) => c.model);
			expect(new Set(models).size).toBe(models.length);
			expect(models.filter((m) => m === 'gemini-2.5-flash').length).toBe(1);
			expect(res.status).toBe(200);
		});

		it('failover por 410 funciona también con stream:true', async () => {
			const goneBody = JSON.stringify({ error: { message: 'end of life' } });
			const successChunks = ['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n'];
			const streamRes = createStreamResponse(successChunks);
			const mock = vi
				.fn()
				.mockImplementationOnce(async () => new Response(goneBody, { status: 410, headers: { 'Content-Type': 'application/json' } }))
				.mockImplementationOnce(async () => streamRes);
			vi.stubGlobal('fetch', mock);
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			const body = await readStreamBody(res);
			expect(body).toBe(successChunks.join(''));
			expect(mock.mock.calls.length).toBe(2);
		});

		it('si todos los modelos disponibles fallan con 410, termina limpiamente sin bucle', async () => {
			const goneBody = JSON.stringify({ error: { message: 'end of life' } });
			const { calls } = installMockFetch(Array(20).fill({ status: 410, body: goneBody }));
			const req = new IncomingRequest('http://example.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);
			const eligible = getAvailableModels(createMockEnv()).length;
			expect(calls.length).toBe(eligible);
			const models = calls.map((c) => c.model);
			expect(new Set(models).size).toBe(models.length);
			expect(res.status).toBe(502);
		});

		it('un modelo retirado (410) no se vuelve a seleccionar en una solicitud posterior', async () => {
			const goneBody = JSON.stringify({ error: { message: 'end of life' } });
			const mkReq = () =>
				new IncomingRequest('http://example.com/v1/chat/completions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
					body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
				});

			const first = installMockFetch([{ status: 410, body: goneBody }, { status: 200 }]);
			const ctx1 = createExecutionContext();
			const res1 = await worker.fetch(mkReq(), createMockEnv(), ctx1);
			await waitOnExecutionContext(ctx1);
			expect(res1.status).toBe(200);
			expect(first.calls[0].model).toBe('gemini-2.5-flash');

			const { calls } = installMockFetch([{ status: 200 }]);
			const ctx2 = createExecutionContext();
			const res = await worker.fetch(mkReq(), createMockEnv(), ctx2);
			await waitOnExecutionContext(ctx2);
			expect(calls.length).toBe(1);
			expect(calls[0].model).not.toBe('gemini-2.5-flash');
			expect(res.status).toBe(200);
		});
	});
});
