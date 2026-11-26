import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LINK_SELECTION_SETTINGS } from "@/assets/js/constants/setting";
import { OS_LINUX, OS_WIN } from "@/assets/js/constants/os";
import {
	cancelIndividualSelection,
	individualKeyDown,
	individualPointerDown,
	individualPointerMove,
	individualPointerUp,
	shouldSuppressIndividualContextMenu
} from "@/entrypoints/content/selection/individualLinkSelection";
import { resetContentWindow } from "../../../shared/support/contentWindow";

vi.mock("@/entrypoints/content/utils/isTrustedEvent", () => ({
	isTrustedEvent: () => true
}));

function makeLink(href = "https://example.com/"): HTMLAnchorElement {
	const link = document.createElement("a");
	link.href = href;
	link.textContent = "Example";
	document.body.appendChild(link);
	return link;
}

function makePointerEvent(type: string, target: Element, options: Record<string, number | boolean> = {}): PointerEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 2,
		shiftKey: true,
		clientX: 10,
		clientY: 10,
		...options
	});
	Object.defineProperties(event, {
		pointerId: { value: 1 },
		pointerType: { value: "mouse" },
		isPrimary: { value: true },
		pageX: { value: options.pageX ?? options.clientX ?? 10 },
		pageY: { value: options.pageY ?? options.clientY ?? 10 }
	});
	target.dispatchEvent(event);
	return event as PointerEvent;
}

function makeKeyEvent(type: string, target: Element, repeat = false): KeyboardEvent {
	const event = new KeyboardEvent(type, {
		bubbles: true,
		cancelable: true,
		keyCode: 84,
		repeat
	});
	target.dispatchEvent(event);
	return event;
}

describe("individualLinkSelection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetContentWindow();
		window.linkSelectionSettings = {
			...DEFAULT_LINK_SELECTION_SETTINGS,
			enabled: true
		};
	});

	afterEach(() => {
		cancelIndividualSelection();
		vi.clearAllTimers();
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	it("toggles a link only after the configured hold duration", () => {
		const link = makeLink();
		const down = makePointerEvent("pointerdown", link, { button: 2, shiftKey: true });
		expect(individualPointerDown(down)).toBe(true);
		expect(window.linkSelection.size).toBe(0);

		vi.advanceTimersByTime(window.linkSelectionSettings.holdDurationMs - 1);
		expect(window.linkSelection.size).toBe(0);

		vi.advanceTimersByTime(1);
		expect(window.linkSelection.size).toBe(1);
	});

	it("arms right-click context-menu suppression on Linux before the hold timer", () => {
		const link = makeLink();
		window.os = OS_LINUX;

		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }))).toBe(true);
		expect(window.stop_menu).toBe(true);
		expect(shouldSuppressIndividualContextMenu()).toBe(true);

		const up = makePointerEvent("pointerup", link, { button: 2, shiftKey: false });
		individualPointerUp(up);
		expect(window.stop_menu).toBe(false);
		expect(window.linkSelection.size).toBe(0);
	});

	it("does not suppress the Windows native menu for a short right-click", () => {
		const link = makeLink();
		window.os = OS_WIN;

		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }))).toBe(true);
		expect(window.stop_menu).toBe(false);
		expect(shouldSuppressIndividualContextMenu()).toBe(false);
	});

	it("keeps a short press as a normal click and does not select", () => {
		const link = makeLink();
		individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }));
		vi.advanceTimersByTime(100);

		const up = makePointerEvent("pointerup", link, { button: 2, shiftKey: false });
		individualPointerUp(up);

		expect(window.linkSelection.size).toBe(0);
		expect(up.defaultPrevented).toBe(false);
	});

	it("suppresses the trailing click only after a successful hold", () => {
		const link = makeLink();
		individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }));
		vi.advanceTimersByTime(window.linkSelectionSettings.holdDurationMs);

		const up = makePointerEvent("pointerup", link, { button: 2, shiftKey: false });
		individualPointerUp(up);

		expect(up.defaultPrevented).toBe(true);
		expect(window.linkSelection.size).toBe(1);
		expect(shouldSuppressIndividualContextMenu()).toBe(true);
		vi.runOnlyPendingTimers();
		expect(shouldSuppressIndividualContextMenu()).toBe(false);
	});

	it("cancels a hold when the pointer moves beyond the threshold", () => {
		const link = makeLink();
		individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }));
		individualPointerMove(makePointerEvent("pointermove", link, { button: 2, shiftKey: true, pageX: 40, pageY: 40 }));
		vi.advanceTimersByTime(window.linkSelectionSettings.holdDurationMs);

		expect(window.linkSelection.size).toBe(0);
	});

	it("does not arm on the wrong button or modifier", () => {
		const link = makeLink();
		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 0, shiftKey: true }))).toBe(false);
		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, ctrlKey: true, shiftKey: false }))).toBe(false);
		expect(window.linkSelection.size).toBe(0);
	});

	it("does not arm when targeting editable form controls", () => {
		const input = document.createElement("input");
		document.body.appendChild(input);
		expect(individualPointerDown(makePointerEvent("pointerdown", input, { button: 2, shiftKey: true }))).toBe(false);
	});

	it("keyboard-only mode toggles the focused link and ignores repeats and editable controls", () => {
		const link = makeLink();
		window.linkSelectionSettings = {
			...window.linkSelectionSettings,
			inputMode: "keyboard-only",
			key: 84
		};

		individualKeyDown(makeKeyEvent("keydown", link));
		expect(window.linkSelection.size).toBe(1);
		individualKeyDown(makeKeyEvent("keydown", link, true));
		expect(window.linkSelection.size).toBe(1);

		const input = document.createElement("input");
		document.body.appendChild(input);
		individualKeyDown(makeKeyEvent("keydown", input));
		expect(window.linkSelection.size).toBe(1);
	});

	it("mouse-only mode requires no held keyboard key", () => {
		const link = makeLink();
		window.linkSelectionSettings = {
			...window.linkSelectionSettings,
			inputMode: "mouse-only"
		};

		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: false }))).toBe(true);
		cancelIndividualSelection();
		window.key_pressed = 16;
		expect(individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }))).toBe(false);
	});

	it("does not toggle removed links after the hold timer", () => {
		const link = makeLink();
		individualPointerDown(makePointerEvent("pointerdown", link, { button: 2, shiftKey: true }));
		link.remove();
		vi.advanceTimersByTime(window.linkSelectionSettings.holdDurationMs);
		expect(window.linkSelection.size).toBe(0);
	});
});
