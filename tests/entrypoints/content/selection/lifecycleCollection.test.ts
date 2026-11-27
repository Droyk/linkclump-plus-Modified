import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "@/entrypoints/content/selection/lifecycle";
import type { LinkItem } from "@/assets/js/types/Content";
import { resetContentWindow } from "../../../shared/support/contentWindow";

describe("rectangle collection mode", () => {
	beforeEach(() => {
		resetContentWindow();
	});

	afterEach(() => {
		if (window.scroll_id) {
			window.clearInterval(window.scroll_id);
			window.scroll_id = 0;
		}
		document.body.replaceChildren();
	});

	it("adds intersecting rectangle-selected links to the persistent collection", () => {
		const anchor = document.createElement("a");
		anchor.href = "https://example.com/rectangle";
		anchor.textContent = "Rectangle result";
		document.body.appendChild(anchor);

		const item = Object.assign(anchor, {
			x1: 10,
			y1: 10,
			x2: 80,
			y2: 40,
			width: 70,
			height: 30,
			box: null,
			important: false
		}) as LinkItem;

		window.linkSelectionSettings.enabled = true;
		window.box_on = true;
		window.box.x1 = 0;
		window.box.y1 = 0;
		window.box.x2 = 100;
		window.box.y2 = 100;
		window.links = [ item ];

		expect(detect(100, 100, true)).toBe(true);
		expect(window.linkSelection.getEntries()).toMatchObject([
			{
				url: "https://example.com/rectangle",
				title: "Rectangle result"
			}
		]);
	});

});
