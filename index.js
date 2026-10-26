/**
 * Host half of the browser annotator: a pending-notes mailbox plus an
 * `agent/pre-step` waterfall listener.
 *
 * The client posts the annotation text at the send instant, then submits the
 * composer. The listener adds the stored text to the step's admitted messages
 * as a user-role message with `source.kind: "browser-annotate"` — the same
 * shape the shipped time-context plugin uses for its hidden injections. Chat
 * omits context rows whose source is not the user, so the notes never appear
 * in the conversation, while the model reads them as ordinary text. The
 * framework appends the event with real turn/step coordinates, which makes a
 * dangling out-of-turn event — and the resume-time log corruption it caused —
 * structurally impossible.
 *
 * @module dsh-browser-annotate
 */

import { randomUUID } from 'node:crypto';

export const name = 'browser-annotate';

/** Services this plugin needs before it may activate. */
export const inject = ['connection'];

/** Absolute host route the client half posts notes to. */
const INJECT_PATH = '/api/browser-annotate.inject';

/** Absolute host route the client half uses to discard queued notes. */
const CLEAR_PATH = '/api/browser-annotate.clear';

/** Notes older than this are dropped instead of riding an unrelated turn. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** sessionId -> pending notes texts, newest last. */
const pending = new Map();

/**
 * Register the routes and the per-step injection listener.
 * @param ctx - host context.
 */
export function apply(ctx) {
	connectionOf(ctx).fetch.register({
		path: INJECT_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let body;
			try {
				body = JSON.parse(await request.text());
			} catch {
				return json({ ok: false, code: 'bad-body' }, 400);
			}
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
			const text = typeof body?.text === 'string' ? body.text : '';
			if (sessionId === '' || text.trim() === '') return json({ ok: false, code: 'empty' }, 400);
			const queue = pending.get(sessionId) ?? [];
			queue.push({ text, at: Date.now() });
			pending.set(sessionId, queue);
			return json({ ok: true });
		},
	});
	connectionOf(ctx).fetch.register({
		path: CLEAR_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let body;
			try {
				body = JSON.parse(await request.text());
			} catch {
				return json({ ok: false, code: 'bad-body' }, 400);
			}
			if (typeof body?.sessionId === 'string') pending.delete(body.sessionId);
			return json({ ok: true });
		},
	});
	ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === 'reject' || signal.aborted) return decision;
		// Consume only at a turn's first step so notes align with the turn of the
		// message they annotate, never mid-turn of an earlier one.
		if (step !== 1) return decision;
		const queue = pending.get(agent.id);
		if (queue === undefined || queue.length === 0) return decision;
		pending.delete(agent.id);
		const now = Date.now();
		const messages = queue.filter((entry) => now - entry.at <= PENDING_TTL_MS).map((entry) => createContextMessage(entry.text));
		if (messages.length === 0) return decision;
		return { ...decision, messages: [...decision.messages, ...messages] };
	});
}

/**
 * Build the identified user-role message the loop admits. Mirrors
 * `createUserMessage` from `@deepseek-ai/dsh-llm` without importing it: the
 * plugin stays dependency-free so it resolves from any linked install root.
 * A non-"user" source kind is what keeps Chat from drawing a row.
 * @param text - the annotation block.
 * @returns a frozen detached message.
 */
function createContextMessage(text) {
	return freezeDeep({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'browser-annotate' },
	});
}

/** Recursively freeze one plain JSON value. */
function freezeDeep(value) {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

/** One JSON response with a no-store policy. */
function json(value, status) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/** Read `connection` without re-tracing the caller's context. */
function connectionOf(ctx) {
	return Reflect.get(ctx, 'connection');
}
