#!/usr/bin/env node
// ============================================================
// Cerebras Model Validation Script
// Tests gpt-oss-120b on Cerebras with local .dev.vars
// Usage: node scripts/check-cerebras-model.mjs
// ============================================================

import { readFileSync } from 'fs';
import { resolve } from 'path';

const DEV_VARS_PATH = resolve(process.cwd(), '.dev.vars');

function loadEnvFile() {
	const content = readFileSync(DEV_VARS_PATH, 'utf-8');
	const env = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const [key, ...rest] = trimmed.split('=');
		if (key && rest.length > 0) {
			env[key.trim()] = rest.join('=').trim();
		}
	}
	return env;
}

async function testModel(apiKey, modelId, maxTokens = 200) {
	const url = 'https://api.cerebras.ai/v1/chat/completions';
	const body = {
		model: modelId,
		messages: [{ role: 'user', content: 'Responde exactamente con: CEREBRAS_GPT_OSS_OK' }],
		stream: false,
		max_tokens: maxTokens,
		temperature: 0,
		reasoning_effort: 'low',
	};

	const start = Date.now();
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});

		const duration = Date.now() - start;
		const text = await response.text();
		let content = '';
		let errorMsg = '';
		let ok = false;

		if (response.ok) {
			try {
				const parsed = JSON.parse(text);
				content = parsed.choices?.[0]?.message?.content ?? '';
				ok = content.includes('CEREBRAS_GPT_OSS_OK');
			} catch {
				errorMsg = 'No se pudo parsear respuesta JSON';
			}
		} else if (response.status === 404) {
			errorMsg = '404 Modelo no encontrado o sin acceso';
		} else if (response.status === 401 || response.status === 403) {
			errorMsg = `${response.status} Error de autenticación (key inválida o sin permisos)`;
		} else if (response.status === 429) {
			errorMsg = '429 Rate limited';
		} else {
			errorMsg = `${response.status} ${response.statusText}`;
		}

		return {
			model: modelId,
			http: response.status,
			durationMs: duration,
			ok,
			content: ok ? content : '',
			error: errorMsg,
			raw: ok ? '' : text.slice(0, 300),
		};
	} catch (err) {
		return {
			model: modelId,
			http: 'ERR',
			durationMs: Date.now() - start,
			ok: false,
			content: '',
			error: String(err).slice(0, 200),
			raw: '',
		};
	}
}

async function main() {
	const env = loadEnvFile();
	const apiKey = env.CEREBRAS_API_KEY;

	if (!apiKey) {
		console.error('ERROR: CEREBRAS_API_KEY no encontrada en .dev.vars');
		process.exit(1);
	}

	console.log('┌─────────────────────────────────────────────────────────────┐');
	console.log('│ Cerebras Model Validation                                   │');
	console.log('├─────────────────────────────────────────────────────────────┤');
	console.log('│ Endpoint: https://api.cerebras.ai/v1/chat/completions       │');
	console.log('│ Test: "Responde exactamente con: CEREBRAS_GPT_OSS_OK"       │');
	console.log('│ Model: gpt-oss-120b | max_tokens=200 | reasoning_effort=low │');
	console.log('└─────────────────────────────────────────────────────────────┘');
	console.log('');

	const result = await testModel(apiKey, 'gpt-oss-120b', 200);

	const statusIcon = result.ok ? '✅' : '❌';
	const statusText = result.ok ? 'RESPUESTA CORRECTA' : 'FALLÓ';
	console.log(` ${statusIcon} Modelo: ${result.model}`);
	console.log(`    HTTP: ${result.http} | Latencia: ${result.durationMs}ms | ${statusText}`);
	if (result.content) {
		console.log(`    Contenido: "${result.content}"`);
	}
	if (result.error) {
		console.log(`    Error: ${result.error}`);
	}
	if (result.raw) {
		console.log(`    Respuesta cruda: ${result.raw}`);
	}
	console.log('');

	if (result.ok) {
		console.log('✅ Validación completada. Cerebras gpt-oss-120b responde correctamente.');
		process.exit(0);
	} else if (result.http === 'ERR') {
		console.log('❌ Error de conexión. Verifica tu conexión a internet.');
		process.exit(1);
	} else if (result.http === 401 || result.http === 403) {
		console.log('❌ Error de autenticación. Verifica CEREBRAS_API_KEY en .dev.vars.');
		process.exit(1);
	} else if (result.http === 404) {
		console.log('❌ Modelo no encontrado. Puede que gpt-oss-120b ya no esté disponible en Cerebras.');
		process.exit(1);
	} else {
		console.log(`❌ Validación falló (HTTP ${result.http}).`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error fatal:', err);
	process.exit(1);
});
