import { describe, expect, it, vi } from "vitest";
import {
	LAZY_TAB_ENTRY_PREFIX,
	LAZY_TAB_ID_PREFIX,
	LazyTabManager,
	type LazyStorageAdapter,
	type LazyTabInfo,
	type LazyTabsAdapter
} from "@/entrypoints/background/queue/LazyTabManager";

interface FakeLazyState {
	readonly tabs: Map<number, LazyTabInfo>;
	readonly storage: Record<string, unknown>;
	readonly creates: { id: number; url: string; index: number; windowId: number }[];
	readonly updates: { id: number; url: string }[];
	readonly manager: LazyTabManager;
}

function createFakeState(): FakeLazyState {
	const tabs = new Map<number, LazyTabInfo>([
		[ 10, { id: 10, index: 2, windowId: 9, url: "https://source.example/", active: true } ]
	]);
	const storageValues: Record<string, unknown> = {};
	const creates: { id: number; url: string; index: number; windowId: number }[] = [];
	const updates: { id: number; url: string }[] = [];
	let nextTabId = 20;
	let nextToken = 0;

	const tabsAdapter: LazyTabsAdapter = {
		get: vi.fn(async (tabId: number) => {
			const tab = tabs.get(tabId);
			if (!tab) throw new Error("Tab not found");
			return tab;
		}),
		create: vi.fn(async (properties) => {
			const id = nextTabId++;
			const tab: LazyTabInfo = {
				id,
				index: properties.index,
				windowId: properties.windowId,
				url: properties.url,
				active: false
			};
			tabs.set(id, tab);
			creates.push({ id, url: properties.url, index: properties.index, windowId: properties.windowId });
			return tab;
		}),
		update: vi.fn(async (tabId: number, properties: { url: string }) => {
			const current = tabs.get(tabId);
			if (!current) throw new Error("Tab not found");
			const updated = { ...current, url: properties.url };
			tabs.set(tabId, updated);
			updates.push({ id: tabId, url: properties.url });
			return updated;
		}),
		query: vi.fn(async () => [ ...tabs.values() ]),
		onActivated: { addListener: vi.fn() },
		onRemoved: { addListener: vi.fn() }
	};

	const storageAdapter: LazyStorageAdapter = {
		get: vi.fn(async (key: string | null) => {
			if (key === null) return { ...storageValues };
			return { [key]: storageValues[key] };
		}),
		set: vi.fn(async (items: Record<string, unknown>) => {
			Object.assign(storageValues, items);
		}),
		remove: vi.fn(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [ keys ]) {
				delete storageValues[key];
			}
		})
	};

	return {
		tabs,
		storage: storageValues,
		creates,
		updates,
		manager: new LazyTabManager(
			tabsAdapter,
			storageAdapter,
			(token) => "moz-extension://test-id/lazyTab.html?token=" + token,
			() => "token-" + (++nextToken)
		)
	};
}

const URLS = [
	{ url: "https://example.com/a", title: "A" },
	{ url: "https://example.com/b", title: "B" }
];

describe("LazyTabManager", () => {
	it("creates extension placeholders without requesting destination pages", async () => {
		const state = createFakeState();
		const created = await state.manager.create(URLS, 10);

		expect(created).toBe(2);
		expect(state.creates.map((item) => item.url)).toEqual([
			"moz-extension://test-id/lazyTab.html?token=token-1",
			"moz-extension://test-id/lazyTab.html?token=token-2"
		]);
		expect(state.creates.some((item) => URLS.some((url) => item.url === url.url))).toBe(false);
		expect(state.updates).toHaveLength(0);
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toMatchObject({
			url: URLS[0]!.url,
			title: "A",
			tabId: 20
		});
		expect(state.storage[LAZY_TAB_ID_PREFIX + "20"]).toBe("token-1");
	});

	it("navigates only the exact placeholder tab when it becomes active", async () => {
		const state = createFakeState();
		await state.manager.create(URLS, 10);

		const first = state.tabs.get(20)!;
		state.tabs.set(20, { ...first, active: true });
		await state.manager.handleTabActivation(20);

		expect(state.updates).toEqual([ { id: 20, url: URLS[0]!.url } ]);
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ID_PREFIX + "20"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-2"]).toMatchObject({ url: URLS[1]!.url });
	});

	it("ignores activation of unrelated tabs", async () => {
		const state = createFakeState();
		await state.manager.create(URLS, 10);
		state.tabs.set(99, {
			id: 99,
			index: 8,
			windowId: 9,
			url: "https://unrelated.example/",
			active: true
		});

		await state.manager.handleTabActivation(99);

		expect(state.updates).toHaveLength(0);
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toBeDefined();
	});

	it("removes a pending destination when its placeholder tab is closed", async () => {
		const state = createFakeState();
		await state.manager.create(URLS, 10);

		await state.manager.handleTabRemoved(20);

		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ID_PREFIX + "20"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-2"]).toBeDefined();
	});

	it("recovers an already active placeholder after a worker restart", async () => {
		const state = createFakeState();
		await state.manager.create(URLS, 10);
		const first = state.tabs.get(20)!;
		state.tabs.set(20, { ...first, active: true });

		await state.manager.recover();

		expect(state.updates).toEqual([ { id: 20, url: URLS[0]!.url } ]);
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toBeUndefined();
	});

	it("cleans persisted records for placeholders that no longer exist", async () => {
		const state = createFakeState();
		await state.manager.create(URLS, 10);
		state.tabs.delete(20);

		await state.manager.recover();

		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-1"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ID_PREFIX + "20"]).toBeUndefined();
		expect(state.storage[LAZY_TAB_ENTRY_PREFIX + "token-2"]).toBeDefined();
	});

	it("blocks javascript and malformed URLs and de-duplicates by exact URL by default", async () => {
		const state = createFakeState();
		const created = await state.manager.create([
			{ url: "javascript:alert(1)", title: "Blocked" },
			{ url: "not a URL", title: "Invalid" },
			URLS[0]!,
			{ url: URLS[0]!.url, title: "Duplicate" }
		], 10);

		expect(created).toBe(1);
		expect(state.creates).toHaveLength(1);
	});

	it("returns zero when the source tab is unavailable", async () => {
		const state = createFakeState();
		expect(await state.manager.create(URLS, undefined)).toBe(0);
		expect(await state.manager.create(URLS, 999)).toBe(0);
		expect(state.creates).toHaveLength(0);
	});
});
