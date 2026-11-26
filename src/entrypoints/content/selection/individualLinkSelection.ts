import { MOUSE_BUTTON_NONE } from "@/assets/js/constants/mouseButton";
import { KEY_CODE_META, KEY_CODE_CTRL, KEY_CODE_SHIFT, KEY_CODE_ALT } from "@/assets/js/constants/keyboard";
import { OS_WIN } from "@/assets/js/constants/os";
import { DEFAULT_LINK_SELECTION_SETTINGS } from "@/assets/js/constants/setting";
import { isTrustedEvent } from "../utils/isTrustedEvent";
import { DRAG_THRESHOLD_MIN_PX } from "@/assets/js/constants/ui";
import { pointermove, suppressNextClick, startSelection } from "./lifecycle";
import type { LinkElement } from "@/assets/js/types/Content";

interface PendingIndividualSelection {
	readonly pointerId: number;
	readonly element: LinkElement;
	readonly downEvent: PointerEvent;
	readonly startX: number;
	readonly startY: number;
	readonly button: number;
	timerId: number;
	activated: boolean;
}

let pending: PendingIndividualSelection | null = null;
let suppressContextMenuForNextTask = false;

/**
 * Begins a hold-to-toggle gesture when the configured activation combination is used
 * directly on a link. Returning true tells the normal rectangle handler not to consume
 * this pointerdown. If the user moves far enough before the hold completes, we fall back
 * to the existing rectangle-selection path when its own trigger matches.
 */
export function individualPointerDown(event: PointerEvent): boolean {
	const config = window.linkSelectionSettings ?? DEFAULT_LINK_SELECTION_SETTINGS;

	if (
		!config.enabled
		|| config.inputMode === "keyboard-only"
		|| event.pointerType === "touch"
		|| !event.isPrimary
		|| event.button !== config.mouseButton
		|| !matchesConfiguredKey(event)
	) {
		return false;
	}

	const element = findLinkElement(event);
	if (!element || isInsideEditableControl(event.target)) {
		return false;
	}

	cancelPending(false);

	const gesture: PendingIndividualSelection = {
		pointerId: event.pointerId,
		element,
		downEvent: event,
		startX: event.pageX,
		startY: event.pageY,
		button: event.button,
		timerId: 0,
		activated: false
	};
	pending = gesture;

	gesture.timerId = window.setTimeout(() => {
		if (pending !== gesture || !gesture.element.isConnected) {
			return;
		}

		gesture.activated = true;
		window.linkSelection?.toggleElement(gesture.element);
	}, config.holdDurationMs);

	return true;
}

/** Cancels a pending hold on movement, or hands the gesture to rectangle selection. */
export function individualPointerMove(event: PointerEvent): void {
	if (!isTrustedEvent(event)) {
		return;
	}
	const gesture = pending;
	if (!gesture || gesture.pointerId !== event.pointerId || gesture.activated) {
		return;
	}

	const dx = event.pageX - gesture.startX;
	const dy = event.pageY - gesture.startY;
	if ((dx * dx) + (dy * dy) <= DRAG_THRESHOLD_MIN_PX * DRAG_THRESHOLD_MIN_PX) {
		return;
	}

	cancelPending(false);

	// Reuse the exact rectangle-selection path and its existing configured trigger.
	if (startSelection(gesture.downEvent, gesture.startX, gesture.startY)) {
		pointermove(event);
	} else {
		window.stop_menu = false;
		window.mouse_button = MOUSE_BUTTON_NONE;
		window.pointer_type = null;
	}
}

/** Finishes a hold and suppresses the trailing native click only if the hold activated. */
export function individualPointerUp(event: PointerEvent): void {
	if (!isTrustedEvent(event)) {
		return;
	}
	const gesture = pending;
	if (!gesture || gesture.pointerId !== event.pointerId) {
		return;
	}

	window.clearTimeout(gesture.timerId);
	pending = null;

	if (gesture.activated) {
		event.preventDefault();
		event.stopPropagation();
		suppressNextClick();

		// On some platforms the contextmenu event is dispatched after pointerup.
		suppressContextMenuForNextTask = gesture.button === 2;
		if (suppressContextMenuForNextTask) {
			window.stop_menu = true;
			window.setTimeout(() => {
				suppressContextMenuForNextTask = false;
				window.stop_menu = false;
			}, 0);
		}
	} else if (gesture.button === 2) {
		// A short right-click remains a native right-click on platforms where the
		// contextmenu event is dispatched after pointerup.
		window.stop_menu = false;
	}

	if (!(gesture.activated && gesture.button === 2)) {
		window.stop_menu = false;
	}
	window.mouse_button = MOUSE_BUTTON_NONE;
	window.pointer_type = null;
}

/** Cancels a pending gesture when the OS/browser cancels the pointer. */
export function individualPointerCancel(event: PointerEvent): void {
	if (!isTrustedEvent(event)) {
		return;
	}
	if (pending?.pointerId === event.pointerId) {
		cancelPending(true);
	}
}

/**
 * Keyboard-only mode toggles the currently focused link. It deliberately does not act on
 * hovered links, and never intercepts typing in editable controls.
 */
export function individualKeyDown(event: KeyboardEvent): void {
	if (!isTrustedEvent(event)) {
		return;
	}
	const config = window.linkSelectionSettings ?? DEFAULT_LINK_SELECTION_SETTINGS;
	if (
		!config.enabled
		|| config.inputMode !== "keyboard-only"
		|| event.repeat
		|| event.keyCode !== config.key
		|| isInsideEditableControl(event.target)
	) {
		return;
	}

	const element = findLinkElement(event);
	if (!element) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	window.linkSelection?.toggleElement(element);
}

/** Clear any armed hold if the frame loses focus or the content script is disabled. */
export function cancelIndividualSelection(resetPointerState = true): void {
	cancelPending(resetPointerState);
}

export function shouldSuppressIndividualContextMenu(): boolean {
	return suppressContextMenuForNextTask || (pending?.button === 2 && window.os !== OS_WIN);
}

function cancelPending(resetPointerState: boolean): void {
	if (pending) {
		window.clearTimeout(pending.timerId);
		pending = null;
	}

	if (resetPointerState) {
		window.stop_menu = false;
		window.mouse_button = MOUSE_BUTTON_NONE;
		window.pointer_type = null;
	}
}

function matchesConfiguredKey(event: PointerEvent): boolean {
	const config = window.linkSelectionSettings;
	let pressedKey = window.key_pressed;
	if (event.metaKey) {
		pressedKey = KEY_CODE_META;
	} else if (event.ctrlKey) {
		pressedKey = KEY_CODE_CTRL;
	} else if (event.shiftKey) {
		pressedKey = KEY_CODE_SHIFT;
	} else if (event.altKey) {
		pressedKey = KEY_CODE_ALT;
	}

	if (config.inputMode === "mouse-only") {
		return pressedKey === 0;
	}

	return pressedKey === config.key;
}

function findLinkElement(event: Event): LinkElement | null {
	for (const item of event.composedPath()) {
		if (item instanceof HTMLAnchorElement || item instanceof HTMLAreaElement) {
			return item;
		}
	}

	const target = event.target;
	if (target instanceof Element) {
		const closest = target.closest("a[href], area[href]");
		if (closest instanceof HTMLAnchorElement || closest instanceof HTMLAreaElement) {
			return closest;
		}
	}

	return null;
}

function isInsideEditableControl(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}

	return target.closest("input, textarea, select, button, [contenteditable=''], [contenteditable='true'], [role='textbox']") !== null
		|| (target instanceof HTMLElement && target.isContentEditable);
}
