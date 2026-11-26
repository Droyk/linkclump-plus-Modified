import { describe, expect, it, vi } from "vitest";
import {
	SEQUENTIAL_QUEUE_STORAGE_KEY,
	SequentialQueueManager,
	type QueueStorageAdapter,
	type QueueTabInfo,
	type QueueTabsAdapter,
	type SequentialQueueUrl
} from "@/entrypoints/background/queue/SequentialQueueManager";

interface FakeState {
	readonly tabs: Map<number, QueueTabInfo>;
	readonly storage: Record<string, unknown>;
	readonly creates: { url: string; index: number; windowId: number }[];
	readonly manager: SequentialQueueManager;
}

function createFakeState(): FakeState {
	const tabs = new Map<number, QueueTabInfo>([
		[ 10, { id: 10, index: 2, windowId: 9 } ]
	]);
	const storageValues: Record<string, unknown> = {};
	const creates: { url: string; index: number; windowId: number }[] = [];
	let nextTabId = 20;

	const tabsAdapter: QueueTabsAdapter = {
		get: vi.fn(async (tabId: number) => {
			const tab = tabs.get(tabId);
			if (!tab) {
				throw new Error("Tab not found");
			}
			return tab;
		}),
		create: vi.fn(async (properties) => {
			const tab: QueueTabInfo = {
				id: nextTabId++,
				index: properties.index,
				windowId: properties.windowId
			};
			tabs.set(tab.id!, tab);
			creates.push({
				url: properties.url,
				index: properties.index,
				windowId: properties.windowId
			});
			return tab;
		}),
		onRemoved: {
			addListener: vi.fn()
		}
	};

	const storageAdapter: QueueStorageAdapter = {
		get: vi.fn(async (key: string) => ({ [key]: storageValues[key] })),
		set: vi.fn(async (items: Record<string, unknown>) => {
			Object.assign(storageValues, items);
		}),
		remove: vi.fn(async (key: string) => {
			delete storageValues[key];
		})
	};

	return {
		tabs,
		storage: storageValues,
		creates,
		manager: new SequentialQueueManager(tabsAdapter, storageAdapter)
	};
}

const URLs: readonly SequentialQueueUrl[] = [
	{ url: "https://example.com/a", title: "A" },
	{ url: "https://example.com/b", title: "B" },
	{ url: "https://example.com/c", title: "C" }
];

function readState(state: FakeState): {
	activeTabId: number | null;
	nextIndex: number;
	urls: SequentialQueueUrl[];
	sourceTabId: number;
} {
	return state.storage[SEQUENTIAL_QUEUE_STORAGE_KEY] as {
		activeTabId: number | null;
		nextIndex: number;
		urls: SequentialQueueUrl[];
		sourceTabId: number;
	};
}

describe("SequentialQueueManager", () => {
	it("opens exactly one queue tab and advances only after that exact tab is removed", async () => {
		const state = createFakeState();
		expect(await state.manager.start(URLs, 10)).toBe(true);
		expect(state.creates.map((item) => item.url)).toEqual([ URLs[0]!.url ]);
		expect(readState(state)).toMatchObject({ activeTabId: 20, nextIndex: 1, sourceTabId: 10 });

		await state.manager.advanceAfterTabRemoval(999, { isWindowClosing: false });
		expect(state.creates).toHaveLength(1);

		state.tabs.delete(20);
		await state.manager.advanceAfterTabRemoval(20, { isWindowClosing: false });
		expect(state.creates.map((item) => item.url)).toEqual([ URLs[0]!.url, URLs[1]!.url ]);
		expect(readState(state)).toMatchObject({ activeTabId: 21, nextIndex: 2 });

		state.tabs.delete(21);
		await state.manager.advanceAfterTabRemoval(21, { isWindowClosing: false });
		expect(state.creates.map((item) => item.url)).toEqual(URLs.map((item) => item.url));
		expect(readState(state)).toMatchObject({ activeTabId: 22, nextIndex: 3 });

		state.tabs.delete(22);
		await state.manager.advanceAfterTabRemoval(22, { isWindowClosing: false });
		expect(state.storage[SEQUENTIAL_QUEUE_STORAGE_KEY]).toBeUndefined();
		expect(state.creates).toHaveLength(3);
	});

	it("blocks exact duplicate URLs by default while retaining selection order", async () => {
		const state = createFakeState();
		const urls = [
			URLs[1]!,
			{ url: URLs[1]!.url, title: "Duplicate B" },
			URLs[0]!
		];

		await state.manager.start(urls, 10);
		expect(readState(state).urls.map((item) => item.title)).toEqual([ "B", "A" ]);
	});

	it("does not block duplicates when explicitly disabled", async () => {
		const state = createFakeState();
		const urls = [ URLs[0]!, { url: URLs[0]!.url, title: "A duplicate" } ];

		await state.manager.start(urls, 10, false);
		expect(readState(state).urls).toHaveLength(2);
	});

	it("cancels instead of advancing when the active tab's window is closing", async () => {
		const state = createFakeState();
		await state.manager.start(URLs, 10);

		state.tabs.delete(20);
		await state.manager.advanceAfterTabRemoval(20, { isWindowClosing: true });

		expect(state.creates).toHaveLength(1);
		expect(state.storage[SEQUENTIAL_QUEUE_STORAGE_KEY]).toBeUndefined();
	});

	it("cancels if the source tab is closed", async () => {
		const state = createFakeState();
		await state.manager.start(URLs, 10);

		state.tabs.delete(10);
		await state.manager.advanceAfterTabRemoval(10, { isWindowClosing: false });

		expect(state.creates).toHaveLength(1);
		expect(state.storage[SEQUENTIAL_QUEUE_STORAGE_KEY]).toBeUndefined();
	});

	it("leaves an existing active queue tab alone during recovery", async () => {
		const state = createFakeState();
		await state.manager.start(URLs, 10);

		const recovered = new SequentialQueueManager(
			{
				get: async (id) => {
					const tab = state.tabs.get(id);
					if (!tab) throw new Error("Tab not found");
					return tab;
				},
				create: async () => {
					throw new Error("Unexpected second tab");
				},
				onRemoved: { addListener: vi.fn() }
			},
			{
				get: async (key) => ({ [key]: state.storage[key] }),
				set: async (items) => { Object.assign(state.storage, items); },
				remove: async (key) => { delete state.storage[key]; }
			}
		);

		await recovered.recover();
		expect(state.creates).toHaveLength(1);
		expect(readState(state).activeTabId).toBe(20);
	});

	it("opens the next URL when recovery finds that the previous queue tab is gone", async () => {
		const state = createFakeState();
		await state.manager.start(URLs, 10);
		state.tabs.delete(20);

		let nextId = 30;
		const recovered = new SequentialQueueManager(
			{
				get: async (id) => {
					const tab = state.tabs.get(id);
					if (!tab) throw new Error("Tab not found");
					return tab;
				},
				create: async (properties) => {
					const tab = { id: nextId++, index: properties.index, windowId: properties.windowId };
					state.tabs.set(tab.id!, tab);
					state.creates.push({ url: properties.url, index: properties.index, windowId: properties.windowId });
					return tab;
				},
				onRemoved: { addListener: vi.fn() }
			},
			{
				get: async (key) => ({ [key]: state.storage[key] }),
				set: async (items) => { Object.assign(state.storage, items); },
				remove: async (key) => { delete state.storage[key]; }
			}
		);

		await recovered.recover();
		expect(state.creates.map((item) => item.url)).toEqual([ URLs[0]!.url, URLs[1]!.url ]);
		expect(readState(state)).toMatchObject({ activeTabId: 30, nextIndex: 2 });
	});

	it("stop cancels future advancement without closing the current tab", async () => {
		const state = createFakeState();
		await state.manager.start(URLs, 10);

		await state.manager.stop();
		expect(state.tabs.has(20)).toBe(true);
		expect(state.storage[SEQUENTIAL_QUEUE_STORAGE_KEY]).toBeUndefined();

		state.tabs.delete(20);
		await state.manager.advanceAfterTabRemoval(20, { isWindowClosing: false });
		expect(state.creates).toHaveLength(1);
	});

	it("rejects a missing source tab and javascript URLs", async () => {
		const state = createFakeState();
		expect(await state.manager.start(URLs, undefined)).toBe(false);
		expect(await state.manager.start(URLs, 999)).toBe(false);
		expect(await state.manager.start([
			{ url: "javascript:alert(1)", title: "Blocked" },
			{ url: "not a URL", title: "Malformed" }
		], 10)).toBe(false);
		expect(state.creates).toHaveLength(0);
	});
});
