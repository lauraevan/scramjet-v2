import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import {
	Array_from,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
	_Map,
} from "../snapshot";

// eslint-disable-next-line scramjet-core/no-globals
Error.stackTraceLimit = 50;

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};

const CONSERVATIVE_FLAGS = {
	destructureRewrites: false,
	captureErrors: false,
	scramitize: false,
	sourcemaps: false,
};
const MAX_REWRITE_FAILURE_CACHE = 256;
const rewriteFailureCache = new _Map<string, true>();

function rewriteFailureKey(
	js: string | Uint8Array,
	url: string | null,
	isModule: boolean
): string | null {
	if (
		!url ||
		(!url.startsWith("http://") && !url.startsWith("https://"))
	) {
		return null;
	}
	const length = typeof js === "string" ? js.length : js.byteLength;
	return `${isModule ? "m" : "s"}:${length}:${url}`;
}

function rememberPrimaryRewriteFailure(key: string | null): void {
	if (!key) return;
	rewriteFailureCache.delete(key);
	rewriteFailureCache.set(key, true);
	while (rewriteFailureCache.size > MAX_REWRITE_FAILURE_CACHE) {
		const oldest = rewriteFailureCache.keys().next().value;
		if (oldest === undefined) break;
		rewriteFailureCache.delete(oldest);
	}
}

function conservativeRewrite(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	return rewriteJsWasm(
		js,
		url,
		context,
		meta,
		isModule,
		CONSERVATIVE_FLAGS
	);
}
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean,
	flagOverrides?: Record<string, boolean>
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}
	if (flagOverrides) {
		for (const flag of Object_keys(flagOverrides)) {
			flagsobj[flag] = flagOverrides[flag];
		}
	}

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): string | Uint8Array {
	const failureKey = rewriteFailureKey(js, url, isModule);

	if (failureKey && rewriteFailureCache.has(failureKey)) {
		try {
			return conservativeRewrite(js, url, context, meta, isModule).js;
		} catch (error) {
			if (flagEnabled("allowInvalidJs", context, meta.base)) {
				return js;
			}
			throw error;
		}
	}

	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base) && res.map) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${newjs}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		return newjs;
	} catch (err) {
		rememberPrimaryRewriteFailure(failureKey);
		const firstError = err as Error;
		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			firstError.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);

		// Compatibility retry: a number of large/minified applications trip
		// experimental transforms even though the underlying JS is valid.
		// Retry once with the highest-risk transforms disabled before falling
		// back to the original source.
		try {
			const retry = conservativeRewrite(js, url, context, meta, isModule);
			if (flagEnabled("rewriterLogs", context, meta.base)) {
				dbg.warn("compatibility rewrite succeeded for", url || "(unknown)");
			}
			return retry.js;
		} catch (retryErr) {
			const secondError = retryErr as Error;
			dbg.warn(
				"compatibility rewrite also failed for",
				url || "(unknown)",
				secondError.message
			);
		}

		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			return js;
		}
		throw firstError;
	}
}
