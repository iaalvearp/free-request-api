import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('free-request-api Worker', () => {
	it('devuelve 401 sin Authorization', async () => {
		const request = new IncomingRequest('http://example.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('devuelve 404 para rutas no reconocidas', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('GET /health devuelve 200', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toHaveProperty('status', 'ok');
		expect(body).toHaveProperty('providers');
	});

	it('GET /stats sin auth devuelve 401', async () => {
		const request = new IncomingRequest('http://example.com/stats');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('OPTIONS devuelve CORS headers', async () => {
		const request = new IncomingRequest('http://example.com/v1/chat/completions', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});
