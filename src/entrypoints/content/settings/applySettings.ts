import {
	createBox,
	createCountLabel,
	createCustomElement
} from "../dom/selectionBox";
import {
	blur,
	keydown,
	keyup
} from "../keyboard/keyState";
import {
	contextmenu,
	pointerdown,
	touchmove
} from "../pointer/pointerEvents";
import { stop } from "../selection/lifecycle";
import {
	cancelIndividualSelection,
	individualKeyDown,
	individualPointerCancel,
	individualPointerMove,
	individualPointerUp
} from "../selection/individualLinkSelection";
import { createSelectionToolbar, destroySelectionToolbar } from "../selection/selectionToolbar";
import { LinkSelectionStore } from "../selection/LinkSelectionStore";
import { isBlockedUrl } from "./blocklist";

import { CUSTOM_TAG_LINKCLUMP } from "@/assets/js/constants/ui";
import { DEFAULT_LINK_SELECTION_SETTINGS } from "@/assets/js/constants/setting";

import type { ContentScriptContext } from "wxt/utils/content-script-context";
import type { Settings } from "@/assets/js/types/Settings";

/**
 * Content script context provided by WXT to detect extension reload and invalidation.
 */
let contentContext: ContentScriptContext | null = null;

/**
 * Aborts the listeners registered by enableContentScript() all at once. Null while the content script is
 * turned off for this frame (blocked URL, or settings not loaded yet).
 */
let listenerController: AbortController | null = null;

/**
 * Initializes the content script context to watch for extension reload/invalidation.
 *
 * @param {ContentScriptContext} ctx - Content script context provided by WXT.
 * @returns {void}
 */
export function initContentScriptContext(ctx: ContentScriptContext): void {
	contentContext = ctx;
	ctx.onInvalidated(() => {
		disableContentScript();
	});
}

/**
 * Wraps an event listener with a check for context invalidation. If the extension
 * context is invalidated, the listener drops the event.
 *
 * @template {Event} E
 * @param {(event: E) => void} listener - Event listener to wrap.
 * @returns {(event: E) => void} Guarded listener.
 */
function guarded<E extends Event>(listener: (event: E) => void): (event: E) => void {
	return (event: E): void => {
		if (contentContext?.isInvalid) {
			return;
		}
		listener(event);
	};
}

/**
 * Applies the settings received from the background script (on page load and whenever the
 * settings are updated): stores the actions, then turns this content script on or off for
 * this frame depending on whether the URL of the frame matches the blocklist. Calling it
 * again with changed settings therefore takes effect without reloading the page.
 *
 * @param {Pick<Settings, "actions" | "blocked" | "selection">} settings - Settings received from the background.
 * @returns {void}
 */
export function applySettings(settings: Pick<Settings, "actions" | "blocked" | "selection">): void {
	// Tests, future content entry points, and re-initialized frames can call this before
	// the normal entrypoint has created the per-document store.
	if (!window.linkSelection) {
		window.linkSelection = new LinkSelectionStore();
	}
	window.settings = settings.actions;
	window.linkSelectionSettings = {
		...DEFAULT_LINK_SELECTION_SETTINGS,
		...(settings.selection ?? {})
	};

	if (isBlockedUrl(settings.blocked ?? [], window.location.href)) {
		disableContentScript();
	} else {
		enableContentScript();
		if (window.linkSelectionSettings.enabled) {
			createSelectionToolbar(window.linkSelection);
		} else {
			destroySelectionToolbar();
			window.linkSelection?.clear();
		}
	}
}

/**
 * Turns the content script on for this frame: creates the selection box and count label,
 * appends them to the DOM, and registers the always-on event listeners. Does nothing if already enabled.
 *
 * @returns {void}
 */
function enableContentScript(): void {
	if (listenerController !== null) {
		return;
	}

	listenerController = new AbortController();
	const { signal } = listenerController;

	// setting up the box and count label
	window.linkclump = createCustomElement(CUSTOM_TAG_LINKCLUMP);
	window.linkclump.style.pointerEvents = "none";
	window.linkclump.style.touchAction = "none";
	window.box = createBox();
	window.count_label = createCountLabel();

	(window.linkclump).appendChild(window.box);
	(window.linkclump).appendChild(window.count_label);
	(document.body).appendChild(window.linkclump);

	// add event listeners (all of them are removed at once through the signal in disableContentScript())
	window.addEventListener("pointerdown", guarded(pointerdown), { capture: true, signal });
	window.addEventListener("keydown", guarded(keydown), { capture: true, signal });
	window.addEventListener("keydown", guarded(individualKeyDown), { capture: true, signal });
	window.addEventListener("keyup", guarded(keyup), { capture: true, signal });
	window.addEventListener("blur", guarded(blur), { capture: true, signal });
	window.addEventListener("blur", guarded(() => cancelIndividualSelection(true)), { capture: true, signal });
	window.addEventListener("pointermove", guarded(individualPointerMove), { capture: true, signal });
	window.addEventListener("pointerup", guarded(individualPointerUp), { capture: true, signal });
	window.addEventListener("pointercancel", guarded(individualPointerCancel), { capture: true, signal });
	window.addEventListener("contextmenu", guarded(contextmenu), { capture: true, signal });
	// non-passive: required to cancel native panning once the touch hold is confirmed
	window.addEventListener("touchmove", guarded(touchmove), { capture: true, passive: false, signal });
}

/**
 * Turns the content script off for this frame: removes the always-on event listeners,
 * ends any selection in progress, resets state, and removes the selection box from the page.
 * Does nothing if already disabled.
 *
 * @returns {void}
 */
function disableContentScript(): void {
	cancelIndividualSelection(true);
	destroySelectionToolbar();
	window.linkSelection?.clear();

	if (listenerController === null) {
		return;
	}

	listenerController.abort();
	listenerController = null;

	// end a selection in progress; this has to run before the box element is removed because
	// it also removes the link boxes from it
	stop();
	window.key_pressed = 0;
	window.stop_menu = false;

	window.linkclump.remove();
}
