import { HostPlatform } from "./types/host-platform.type";
import {
	LegacyPromptScope,
	globalScopeFor,
	PromptScope,
} from "./types/prompt-scope.type";

/**
 * Short labels shown in the modals, the widget, and the built prompt. The keys
 * are the strings parseOption sees in an option line like "[omp] name.md".
 */
export const SCOPE_BY_LABEL = {
	local: PromptScope.Local,
	omp: PromptScope.GlobalOmp,
	pi: PromptScope.GlobalPi,
} as const satisfies Record<string, PromptScope>;

const LABEL_BY_SCOPE: Record<PromptScope, string> = {
	[PromptScope.Local]: "local",
	[PromptScope.GlobalOmp]: "omp",
	[PromptScope.GlobalPi]: "pi",
};

/**
 * Render a scope the way the UI shows it. Accepts a string because this runs at
 * the parse boundary, where the value came from stored JSON.
 */
export function formatScope(scope: PromptScope | LegacyPromptScope | string): string {
	return LABEL_BY_SCOPE[scope as PromptScope] ?? String(scope);
}

/**
 * Map a scope read from persisted JSON onto a host-explicit one. Anything that
 * is not already explicit — including the bare legacy "global" older sessions
 * wrote — resolves to the detected host.
 */
export function resolveScope(
	scope: PromptScope | LegacyPromptScope | string | undefined,
	host: HostPlatform,
): PromptScope {
	if (scope === PromptScope.GlobalOmp || scope === PromptScope.GlobalPi) {
		return scope;
	}
	if (scope === PromptScope.Local) {
		return PromptScope.Local;
	}
	return globalScopeFor(host);
}
