import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkSelectionStore } from "@/entrypoints/content/selection/LinkSelectionStore";

function makeAnchor(href: string, text: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.textContent = text;

	for (const [ name, value ] of Object.entries(attributes)) {
		anchor.setAttribute(name, value);
	}

	document.body.appendChild(anchor);
	return anchor;
}

describe("LinkSelectionStore", () => {
	let store: LinkSelectionStore;

	beforeEach(() => {
		store = new LinkSelectionStore();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("captures absolute URL, title, visible text, and source document", () => {
		const anchor = makeAnchor("/article", "  Read   article  ", { title: "Article title" });
		const result = store.addElement(anchor);

		expect(result?.added).toBe(true);
		expect(result?.entry.url).toBe(new URL("/article", document.URL).href);
		expect(result?.entry.title).toBe("Article title");
		expect(result?.entry.text).toBe("Read article");
		expect(result?.entry.sourceUrl).toBe(document.URL);
	});

	it("prefers accessible name, then title, text, and URL", () => {
		const accessible = makeAnchor("https://example.com/a", "Visible", {
			"aria-label": "Accessible",
			title: "Tooltip"
		});
		const title = makeAnchor("https://example.com/b", "Visible", { title: "Tooltip" });
		const text = makeAnchor("https://example.com/c", "Visible");

		expect(store.addElement(accessible)?.entry.title).toBe("Accessible");
		expect(store.addElement(title)?.entry.title).toBe("Tooltip");
		expect(store.addElement(text)?.entry.title).toBe("Visible");
	});

	it("rejects missing, empty, hash-only, and javascript hrefs", () => {
		const missing = document.createElement("a");
		const empty = makeAnchor("", "empty");
		const hash = makeAnchor("#", "hash");
		const javascript = makeAnchor("javascript:alert(1)", "script");

		expect(store.addElement(missing)).toBeNull();
		expect(store.addElement(empty)).toBeNull();
		expect(store.addElement(hash)).toBeNull();
		expect(store.addElement(javascript)).toBeNull();
		expect(store.size).toBe(0);
	});

	it("keeps two elements with the same URL independently selectable", () => {
		const first = makeAnchor("https://example.com/shared", "First");
		const second = makeAnchor("https://example.com/shared", "Second");

		store.addElement(first);
		store.addElement(second);

		expect(store.size).toBe(2);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "First", "Second" ]);
	});

	it("does not move or duplicate an already selected element", () => {
		const first = makeAnchor("https://example.com/first", "First");
		const second = makeAnchor("https://example.com/second", "Second");
		store.addElement(first);
		store.addElement(second);

		expect(store.addElement(first)?.added).toBe(false);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "First", "Second" ]);
	});

	it("toggles by element identity rather than URL", () => {
		const first = makeAnchor("https://example.com/shared", "First");
		const second = makeAnchor("https://example.com/shared", "Second");

		expect(store.toggleElement(first).selected).toBe(true);
		expect(store.toggleElement(second).selected).toBe(true);
		expect(store.toggleElement(first).selected).toBe(false);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "Second" ]);
	});

	it("re-adding an element after removal creates a new id", () => {
		const anchor = makeAnchor("https://example.com/a", "A");
		const firstId = store.addElement(anchor)!.entry.id;
		store.remove(anchor);
		const secondId = store.addElement(anchor)!.entry.id;

		expect(secondId).not.toBe(firstId);
		expect(store.size).toBe(1);
	});

	it("adds a batch in supplied order and emits one change event", () => {
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);
		const links = [
			makeAnchor("https://example.com/3", "Third"),
			makeAnchor("https://example.com/1", "First"),
			makeAnchor("https://example.com/2", "Second")
		];

		const added = store.addElements(links);

		expect(added.map((entry) => entry.title)).toEqual([ "Third", "First", "Second" ]);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "Third", "First", "Second" ]);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("does not notify when a batch contains only selected elements", () => {
		const anchor = makeAnchor("https://example.com/a", "A");
		store.addElement(anchor);
		const listener = vi.fn();
		store.subscribe(listener);

		store.addElements([ anchor, anchor ]);

		expect(listener).not.toHaveBeenCalled();
	});

	it("uses image-map alt text for area links", () => {
		const area = document.createElement("area");
		area.href = "https://example.com/map";
		area.alt = "Map region";
		document.body.appendChild(area);

		expect(store.addElement(area)?.entry.title).toBe("Map region");
		expect(store.addElement(area)?.entry.text).toBe("Map region");
	});

	it("reorders only when ids form an exact permutation", () => {
		store.addElement(makeAnchor("https://example.com/1", "One"));
		store.addElement(makeAnchor("https://example.com/2", "Two"));
		store.addElement(makeAnchor("https://example.com/3", "Three"));
		const entries = store.getEntries();

		expect(store.reorder([ entries[2]!.id, entries[0]!.id, entries[1]!.id ])).toBe(true);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "Three", "One", "Two" ]);
		expect(store.reorder([ entries[0]!.id, entries[0]!.id, entries[2]!.id ])).toBe(false);
		expect(store.reorder([ entries[0]!.id, entries[1]!.id ])).toBe(false);
		expect(store.reorder([ "stale-id", entries[0]!.id, entries[1]!.id ])).toBe(false);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "Three", "One", "Two" ]);
	});

	it("preserves selection chronology across manual reordering", () => {
		const first = store.addElement(makeAnchor("https://example.com/1", "One"))!.entry;
		const second = store.addElement(makeAnchor("https://example.com/2", "Two"))!.entry;
		store.reorder([ second.id, first.id ]);

		expect(store.getEntries().map((entry) => entry.selectionOrder)).toEqual([ 2, 1 ]);
	});

	it("allows duplicate manually entered URLs and rejects javascript URLs", () => {
		store.addUrl("https://example.com/a", "A");
		store.addUrl(" https://example.com/a ", "A copy");

		expect(store.size).toBe(2);
		expect(store.getEntries().map((entry) => entry.title)).toEqual([ "A", "A copy" ]);
		expect(store.addUrl("javascript:alert(1)")).toBeNull();
	});

	it("updates editable row values without changing id or selection chronology", () => {
		const original = store.addElement(makeAnchor("https://example.com/a", "Original"))!.entry;

		expect(store.update(original.id, { url: "https://example.com/edited", title: "Edited" })).toBe(true);
		expect(store.findById(original.id)).toMatchObject({
			id: original.id,
			url: "https://example.com/edited",
			title: "Edited",
			selectionOrder: original.selectionOrder
		});
		expect(store.update(original.id, { url: "javascript:alert(1)" })).toBe(false);
		expect(store.update("missing", { title: "No row" })).toBe(false);
	});

	it("returns frozen snapshots, not mutable internal records", () => {
		store.addElement(makeAnchor("https://example.com/a", "A"));
		const snapshot = store.getEntries();

		expect(Object.isFrozen(snapshot[0])).toBe(true);
		expect(() => {
			(snapshot[0] as { url: string }).url = "https://attacker.example/";
		}).toThrow();
		expect(store.getEntries()[0]?.url).toBe("https://example.com/a");
	});

	it("exposes source elements only while their rows remain in the collection", () => {
		const anchor = makeAnchor("https://example.com/a", "A");
		const entry = store.addElement(anchor)!.entry;
		expect(store.getElement(entry.id)).toBe(anchor);
		store.remove(entry.id);
		expect(store.getElement(entry.id)).toBeUndefined();
	});

	it("removes by id or element and reports missing removals", () => {
		const anchor = makeAnchor("https://example.com/a", "A");
		const entry = store.addElement(anchor)!.entry;

		expect(store.remove(anchor)).toBe(true);
		expect(store.remove(entry.id)).toBe(false);
		expect(store.findByElement(anchor)).toBeUndefined();
	});

	it("clears idempotently and notifies subscribers only on change", () => {
		const listener = vi.fn();
		store.subscribe(listener);
		store.addElement(makeAnchor("https://example.com/a", "A"));

		expect(store.clear()).toBe(true);
		expect(store.clear()).toBe(false);
		expect(store.size).toBe(0);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("supports unsubscribe and sends snapshots to listeners", () => {
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);
		store.addElement(makeAnchor("https://example.com/a", "A"));

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0]?.[0]).toMatchObject([ { title: "A" } ]);
		unsubscribe();
		store.clear();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
