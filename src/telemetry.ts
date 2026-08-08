import type { Env, ProviderName, VirtualRoute } from './types';

interface ModelHealthEvent {
	model: string;
	provider: ProviderName;
	route: VirtualRoute | 'direct';
	result: 'success' | 'failure';
	errorType?: string;
	httpStatus?: number;
	durationMs: number;
	fallbackIndex: number;
	streaming: boolean;
}

export function logModelHealthEvent(env: Env, event: ModelHealthEvent): void {
	// Telemetry should be completely secondary; if Analytics Engine fails, the AI request should continue normally.
	try {
		if (env.MODEL_ANALYTICS) {
			env.MODEL_ANALYTICS.writeDataPoint({
				indexes: [event.model],
				blobs: [
					event.provider,
					event.model,
					event.route,
					event.result,
					event.errorType ?? '',
					event.streaming ? 'true' : 'false',
				],
				doubles: [event.httpStatus ?? 0, event.durationMs, event.fallbackIndex],
			});
		}
	} catch (err) {
		console.error('Error logging to Analytics Engine:', err);
	}
}
