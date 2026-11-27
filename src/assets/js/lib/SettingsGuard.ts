import type { LinkSelectionSettings, Settings } from "@/assets/js/types/Settings";

function isLinkSelectionSettings(value: unknown): value is LinkSelectionSettings {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.enabled === "boolean"
		&& (candidate.inputMode === "mouse-key" || candidate.inputMode === "mouse-only" || candidate.inputMode === "keyboard-only")
		&& (candidate.mouseButton === 0 || candidate.mouseButton === 1 || candidate.mouseButton === 2)
		&& typeof candidate.key === "number"
		&& Number.isInteger(candidate.key)
		&& candidate.key >= 1
		&& candidate.key <= 255
		&& typeof candidate.holdDurationMs === "number"
		&& Number.isInteger(candidate.holdDurationMs)
		&& candidate.holdDurationMs >= 100
		&& candidate.holdDurationMs <= 2000;
}

/**
 * Validates persisted settings while keeping the new collection block optional for older
 * exported settings files. A present-but-malformed selection block is rejected.
 */
export function isSettings(value: unknown): value is Settings {
	if (
		typeof value !== "object"
		|| value === null
		|| !("actions" in value)
		|| typeof (value as { actions: unknown }).actions !== "object"
		|| (value as { actions: unknown }).actions === null
		|| !("blocked" in value)
		|| !Array.isArray((value as { blocked: unknown }).blocked)
	) {
		return false;
	}

	if ("selection" in value) {
		return isLinkSelectionSettings((value as { selection: unknown }).selection);
	}

	return true;
}
