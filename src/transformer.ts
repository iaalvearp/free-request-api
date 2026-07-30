import type { ModelEntry, ProviderName, IncomingRequest, Env, ChatMessage } from './types';
import { PROVIDERS } from './providers';

export function normalizeMessagesForModel(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((msg) => {
		if (msg.role !== 'assistant') return { ...msg };
		const normalized: Record<string, unknown> = {
			role: 'assistant',
			content: msg.content,
		};
		if (msg.tool_calls) normalized.tool_calls = msg.tool_calls;
		if (msg.function_call) normalized.function_call = msg.function_call;
		if (msg.tool_call_id) normalized.tool_call_id = msg.tool_call_id;
		return normalized as ChatMessage;
	});
}

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

	// Nemotron-specific defaults when client doesn't provide them
	const isNemotronSuper = model.id === 'nvidia/nemotron-3-super-120b-a12b';
	const isNemotronNano = model.id === 'nvidia/nemotron-3-nano-30b-a3b';
	const temperature = incoming.temperature ?? (isNemotronNano ? 0.6 : isNemotronSuper ? 1.0 : 0.7);
	const top_p = incoming.top_p ?? (isNemotronNano || isNemotronSuper ? 0.95 : undefined);

	const body: Record<string, unknown> = {
		model: model.id,
		messages: incoming.messages,
		stream: incoming.stream ?? false,
		temperature,
		max_tokens: incoming.max_tokens ?? 4096,
	};

	if (top_p !== undefined) body.top_p = top_p;
	if (isNemotronNano) body.chat_template_kwargs = { enable_thinking: false };
	if (incoming.tools) body.tools = incoming.tools;
	if (incoming.tool_choice) body.tool_choice = incoming.tool_choice;

	const isCerebrasGPTOSS = model.id === 'gpt-oss-120b' && model.provider === 'cerebras';
	if (isCerebrasGPTOSS) {
		body.reasoning_effort = incoming.reasoning_effort ?? 'low';
	}

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
	isStreaming = false,
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

	// For streaming responses, we need to preserve the original Content-Type
	// For non-streaming, if the upstream did not return JSON, we force it to JSON.
	if (!isStreaming && !headers.get('Content-Type')?.includes('json')) {
		headers.set('Content-Type', 'application/json');
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers,
	});
}
