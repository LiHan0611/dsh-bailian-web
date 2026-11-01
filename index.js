/**
 * @local/bailian-web — Aliyun BaiLian MCP backends for the harness web seam (`ctx.web`).
 *
 * Two MCP servers, one bundle:
 *   - EnhancedSearch (`search_pro`) → search provider `bailian-search`
 *   - WebFetch       (`web_fetch`)  → fetch provider  `bailian-fetch`
 *
 * Both speak MCP over streamable HTTP, authenticated with
 * `Authorization: Bearer $BAILIAN_API_KEY` (the credentials service first, the
 * launch environment second). Pinning the two provider ids in the `web` row
 * makes them the default backends behind the shipped `web_search` / `web_fetch`
 * tools, so the model-facing contract does not change.
 *
 * Deliberately has ZERO imports: a profile-installed bundle has no node_modules
 * chain up to the dsh installation, so bare specifiers cannot resolve. The web
 * seam only reads `id`, `available()`, `search()` / `fetch()` from a provider,
 * so a plain object literal is enough.
 *
 * @module @local/bailian-web
 */

/** Cordis plugin name. */
export const name = 'bailian-web';

/** The seam this plugin registers into. */
export const inject = ['web'];

/** Credential references, in resolution order. */
const CREDENTIAL_REFS = ['BAILIAN_API_KEY'];

/** Search provider id, pinned by the profile patch as `searchProvider`. */
const SEARCH_ID = 'bailian-search';
/** Fetch provider id, pinned by the profile patch as `fetchProvider`. */
const FETCH_ID = 'bailian-fetch';

/** The workspace-scoped BaiLian MCP endpoints. */
const SEARCH_ENDPOINT = 'https://ws-u0ho7scff8sgmt4e.cn-beijing.maas.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp';
const FETCH_ENDPOINT = 'https://ws-u0ho7scff8sgmt4e.cn-beijing.maas.aliyuncs.com/api/v1/mcps/WebFetch/mcp';

/** Upstream tool names, confirmed with `tools/list` on both servers. */
const SEARCH_TOOL = 'search_pro';
const FETCH_TOOL = 'web_fetch';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dsh-bailian-web', version: '1.0.0' };
const HANDSHAKE_TIMEOUT_MS = 15000;

/** Build a provider error that the tool layer renders as a structured failure. */
function webError(message, code, cause) {
	const error = new Error(message);
	error.name = 'WebError';
	error.code = code;
	if (cause !== undefined) error.cause = cause;
	return error;
}

/**
 * Resolve the bearer token: managed credential store first, process environment second.
 * @param ctx - plugin context.
 * @returns the credential value.
 */
async function resolveToken(ctx) {
	const credentials = ctx.get('credentials');
	if (credentials !== undefined) {
		for (const ref of CREDENTIAL_REFS) {
			try {
				const hit = await credentials.resolve(ref);
				if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') return hit.value;
			} catch {
				/* try the next reference */
			}
		}
	}
	for (const ref of CREDENTIAL_REFS) {
		const fromEnv = process.env[ref];
		if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
	}
	throw webError(
		`BaiLian web access has no API key for "${CREDENTIAL_REFS[0]}"; store it through the credentials service ` +
			'or export it in the launching environment',
		'WEB_PROVIDER_CREDENTIAL_MISSING',
	);
}

/**
 * Cheap local availability check: no network, no credential resolution.
 * @param ctx - plugin context.
 * @returns whether a credential source exists.
 */
function hasCredential(ctx) {
	if (ctx.get('credentials') !== undefined) return true;
	return CREDENTIAL_REFS.some((ref) => {
		const value = process.env[ref];
		return typeof value === 'string' && value !== '';
	});
}

/**
 * Parse one JSON-RPC reply, accepting either a JSON body or an SSE stream.
 * @param body - raw response text.
 * @returns the parsed message, or undefined for an empty/notification body.
 */
function parseReply(body) {
	const text = body.trim();
	if (text === '') return undefined;
	if (!text.startsWith('event:') && !text.startsWith('data:') && !text.startsWith(':')) return JSON.parse(text);
	let last;
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith('data:')) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === '' || payload === '[DONE]') continue;
		try {
			last = JSON.parse(payload);
		} catch {
			/* keep scanning */
		}
	}
	if (last === undefined) throw webError('BaiLian MCP returned an unreadable event stream', 'WEB_PROVIDER_ERROR');
	return last;
}

/**
 * One JSON-RPC round trip against one MCP endpoint.
 * @param endpoint - MCP HTTP endpoint.
 * @param token - bearer token.
 * @param payload - JSON-RPC message.
 * @param options - optional session id and cancellation signal.
 * @returns the parsed reply (undefined for notifications) and the current session id.
 */
async function rpc(endpoint, token, payload, { session, signal } = {}) {
	const headers = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
	};
	if (session !== undefined) headers['Mcp-Session-Id'] = session;
	let response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		if (signal?.aborted === true) throw webError('BaiLian web request aborted', 'WEB_ABORTED', error);
		throw webError(`BaiLian MCP request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error);
	}
	const body = await response.text();
	const nextSession = response.headers.get('mcp-session-id') ?? session;
	if (!response.ok) {
		const error = webError(
			`BaiLian MCP returned HTTP ${response.status} from ${endpoint} — ${body.slice(0, 300)}`,
			'WEB_PROVIDER_ERROR',
		);
		if (response.status === 404 || response.status === 410) error.retryable = true;
		throw error;
	}
	let reply;
	try {
		reply = parseReply(body);
	} catch (error) {
		throw webError('BaiLian MCP returned an unreadable reply', 'WEB_PROVIDER_ERROR', error);
	}
	return { reply, session: nextSession };
}

/**
 * Complete one MCP handshake and remember any server-issued session id.
 * @param state - endpoint state shared by every call to this provider.
 * @param token - bearer token.
 * @returns the session id, if the server issued one.
 */
async function handshake(state, token) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
	try {
		const init = await rpc(
			state.endpoint,
			token,
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
			},
			{ signal: controller.signal },
		);
		if (init.reply?.error !== undefined) {
			throw webError(`BaiLian MCP initialize failed: ${JSON.stringify(init.reply.error).slice(0, 300)}`, 'WEB_PROVIDER_ERROR');
		}
		state.session = init.session;
		await rpc(
			state.endpoint,
			token,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ session: init.session, signal: controller.signal },
		);
		return init.session;
	} catch (error) {
		if (controller.signal.aborted === true) {
			throw webError('BaiLian MCP handshake timed out', 'WEB_PROVIDER_ERROR', error);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Return the cached handshake, starting one at most once per provider.
 * A failed handshake is forgotten so the next call can retry.
 * @param state - endpoint state.
 * @param token - bearer token.
 * @returns the session id, if any.
 */
function ensureHandshake(state, token) {
	if (state.ready === undefined) {
		state.ready = handshake(state, token).catch((error) => {
			state.ready = undefined;
			state.session = undefined;
			throw error;
		});
	}
	return state.ready;
}

/**
 * Run one upstream tool call on an already-initialized endpoint.
 * @param state - endpoint state.
 * @param token - bearer token.
 * @param session - session id from the handshake.
 * @param args - upstream tool arguments.
 * @param signal - optional cancellation signal.
 * @returns the upstream text payload.
 */
async function invoke(state, token, session, args, signal) {
	const { reply } = await rpc(
		state.endpoint,
		token,
		{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: state.tool, arguments: args } },
		{ session, signal },
	);
	if (reply === undefined) throw webError('BaiLian MCP returned no reply', 'WEB_PROVIDER_ERROR');
	if (reply.error !== undefined) {
		const error = webError(`BaiLian MCP error: ${JSON.stringify(reply.error).slice(0, 300)}`, 'WEB_PROVIDER_ERROR');
		if (reply.error.code === -32001) error.retryable = true;
		throw error;
	}
	const result = reply.result;
	const content = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
	if (result?.isError === true) throw webError(text.slice(0, 500) || 'BaiLian MCP tool call failed', 'WEB_PROVIDER_ERROR');
	if (text === '') throw webError('BaiLian MCP returned no text content', 'WEB_PROVIDER_ERROR');
	return text;
}

/**
 * Call an upstream tool, re-handshaking once if the server rejects the session.
 * @param state - endpoint state.
 * @param token - bearer token.
 * @param args - upstream tool arguments.
 * @param signal - optional cancellation signal.
 * @returns the upstream text payload.
 */
async function callTool(state, token, args, signal) {
	const session = await ensureHandshake(state, token);
	try {
		return await invoke(state, token, session, args, signal);
	} catch (error) {
		if (error?.retryable !== true || signal?.aborted === true) throw error;
		state.ready = undefined;
		state.session = undefined;
		const fresh = await ensureHandshake(state, token);
		return invoke(state, token, fresh, args, signal);
	}
}

/** Collapse whitespace in provider-controlled snippets. */
function oneLine(value) {
	return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/**
 * Project the EnhancedSearch `pages[]` payload onto the seam's source shape.
 * @param text - upstream text payload.
 * @param endpoint - endpoint used for diagnostics.
 * @returns sources in provider order.
 */
function toSources(text, endpoint) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw webError(
			`BaiLian EnhancedSearch returned an unreadable payload from ${endpoint} — ${text.slice(0, 200)}`,
			'WEB_PROVIDER_ERROR',
			error,
		);
	}
	const pages = Array.isArray(payload?.pages) ? payload.pages : [];
	if (pages.length === 0 && payload?.status !== undefined && payload.status !== 0) {
		throw webError(
			`BaiLian EnhancedSearch failed with status ${String(payload.status)} (request ${String(payload.request_id ?? 'unknown')})`,
			'WEB_PROVIDER_ERROR',
		);
	}
	const sources = [];
	for (const page of pages) {
		const url = typeof page?.url === 'string' ? page.url.trim() : '';
		if (url === '') continue;
		const title = oneLine(page.title);
		const snippet = oneLine(page.snippet);
		const date = oneLine(page.publish_time ?? page.published_at ?? page.date);
		sources.push({
			url,
			...(title === '' ? {} : { title }),
			...(snippet === '' ? {} : { snippet }),
			...(date === '' ? {} : { publishedAt: date }),
		});
	}
	return sources;
}

/**
 * Project the WebFetch payload onto the seam's fetch result.
 * @param url - requested URL.
 * @param text - upstream text payload.
 * @returns the fetch result.
 */
function toFetchResult(url, text) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		return { url, statusCode: 200, body: { kind: 'text', content: text }, truncated: false };
	}
	const content = typeof payload?.content === 'string' ? payload.content : text;
	const status = Number.isInteger(payload?.target_status_code) ? payload.target_status_code : 200;
	const finalUrl = typeof payload?.target_url === 'string' && payload.target_url !== '' ? payload.target_url : url;
	return {
		url: finalUrl,
		statusCode: status,
		body: { kind: 'text', content },
		truncated: false,
	};
}

/**
 * Register both BaiLian MCP providers.
 * @param ctx - context carrying the web seam.
 */
export function apply(ctx) {
	const searchState = { endpoint: SEARCH_ENDPOINT, tool: SEARCH_TOOL, ready: undefined, session: undefined };
	const fetchState = { endpoint: FETCH_ENDPOINT, tool: FETCH_TOOL, ready: undefined, session: undefined };

	ctx.web.registerSearchProvider({
		id: SEARCH_ID,
		available: () => hasCredential(ctx),
		async search(request, signal) {
			const token = await resolveToken(ctx);
			const text = await callTool(searchState, token, { query: request.query }, signal);
			return { sources: toSources(text, SEARCH_ENDPOINT), truncated: false };
		},
	});

	ctx.web.registerFetchProvider({
		id: FETCH_ID,
		available: () => hasCredential(ctx),
		async fetch(request, signal) {
			const token = await resolveToken(ctx);
			const text = await callTool(fetchState, token, { url: request.url }, signal);
			return toFetchResult(request.url, text);
		},
	});
}