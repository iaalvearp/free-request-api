import type { ModelEntry, ProviderName, IncomingRequest, Env } from './types';
import { PROVIDERS } from './providers';

export function buildUpstreamRequest(
	model: ModelEntry,
	envKey: string,
	incoming: IncomingRequest,
	env: Env,
	signal: AbortSignal,
): Request {
	const providerConfig = PROVIDERS[model.provider];
	const apiKey = env[envKey] as string;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${apiKey}`,
	};

	const body: Record<string, unknown> = {
		model: model.id,
		messages: incoming.messages,
		stream: incoming.stream ?? false,
		temperature: incoming.temperature ?? 0.7,
		max_tokens: incoming.max_tokens ?? 4096,
	};

	if (incoming.tools) body.tools = incoming.tools;
	if (incoming.tool_choice) body.tool_choice = incoming.tool_choice;

	return new Request(providerConfig.url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});
}

export function buildProxyResponse(
	upstreamResponse: Response,
	modelId: string,
	provider: ProviderName,
	contextWindow: number,
	retryReason: string | null,
	fallbackCount: number,
): Response {
	const headers = new Headers(upstreamResponse.headers);
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('X-Model-Used', modelId);
	headers.set('X-Provider-Used', provider);
	headers.set('X-Model-Context-Window', String(contextWindow));
	headers.set('X-Fallback-Count', String(fallbackCount));
	if (retryReason) {
		headers.set('X-Retry-Reason', retryReason);
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers,
	});
}
