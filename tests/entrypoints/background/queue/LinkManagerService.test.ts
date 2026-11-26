import { describe, expect, it, vi } from "vitest";
import {
	LINK_MANAGER_STORAGE_KEY,
	LinkManagerService,
	type LinkManagerStorageAdapter,
	type LinkManagerTabInfo,
	type LinkManagerTabsAdapter
} from "@/entrypoints/background/queue/LinkManagerService";
import type { LinkManagerState } from "@/assets/js/types/LinkManager";

interface FakeEnvironment {
	readonly tabs: Map<number, LinkManagerTabInfo>;
	readonly creates: { url: string; windowId?: number; index?: number }[];
	readonly service: LinkManagerService;
	readonly storageValues: Record<string, unknown>;
	readonly removeListeners: ((tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void)[];
	activate(tabId: number): Promise<void>;
	remove(tabId: number): Promise<void>;
	state(): Promise<LinkManagerState>;
}

function createEnvironment(initialTabs: LinkManagerTabInfo[] = []): FakeEnvironment {
	const tabs = new Map<number, LinkManagerTabInfo>([
		[ 1, { id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true } ],
		...initialTabs.map((tab) => [ tab.id!, tab ] as [number, LinkManagerTabInfo])
	]);
	const storageValues: Record<string, unknown> = {};
	const creates: { url: string; windowId?: number; index?: number }[] = [];
	const removeListeners: FakeEnvironment["removeListeners"] = [];
	const activateListeners: ((info: { tabId: number; windowId: number }) => void)[] = [];
	const updatedListeners: ((tabId: number, changes: { url?: string }, tab: LinkManagerTabInfo) => void)[] = [];
	let nextId = Math.max(10, ...tabs.keys()) + 1;

	const tabsAdapter: LinkManagerTabsAdapter = {
		get: vi.fn(async (id) => {
			const tab = tabs.get(id);
			if (!tab) throw new Error("No tab");
			return tab;
		}),
		query: vi.fn(async () => [ ...tabs.values() ]),
		create: vi.fn(async (properties) => {
			const tab: LinkManagerTabInfo = {
				id: nextId++,
				index: properties.index ?? tabs.size,
				windowId: properties.windowId ?? 1,
				url: properties.url,
				title: properties.url,
				active: properties.active
			};
			tabs.set(tab.id!, tab);
			creates.push({ url: properties.url, windowId: properties.windowId, index: properties.index });
			return tab;
		}),
		update: vi.fn(async (id, properties) => {
			const current = tabs.get(id);
			if (!current) throw new Error("No tab");
			const next = { ...current, ...properties };
			tabs.set(id, next);
			if (properties.active) {
				activateListeners.forEach((listener) => listener({ tabId: id, windowId: next.windowId }));
			}
			if (properties.url) {
				updatedListeners.forEach((listener) => listener(id, { url: properties.url }, next));
			}
			return next;
		}),
		remove: vi.fn(async (ids) => {
			for (const id of (Array.isArray(ids) ? ids : [ ids ])) {
				const tab = tabs.get(id);
				if (tab) {
					tabs.delete(id);
					removeListeners.forEach((listener) => listener(id, { windowId: tab.windowId, isWindowClosing: false }));
				}
			}
		}),
		onActivated: { addListener: (listener) => activateListeners.push(listener) },
		onRemoved: { addListener: (listener) => removeListeners.push(listener) },
		onUpdated: { addListener: (listener) => updatedListeners.push(listener) }
	};

	const storageAdapter: LinkManagerStorageAdapter = {
		get: vi.fn(async (key) => ({ [key]: storageValues[key] })),
		set: vi.fn(async (items) => { Object.assign(storageValues, items); }),
		remove: vi.fn(async (keys) => {
			for (const key of (Array.isArray(keys) ? keys : [ keys ])) {
				delete storageValues[key];
			}
		})
	};
	const service = new LinkManagerService(tabsAdapter, storageAdapter, {
		lazyPageUrl: (token) => "extension://lazyTab.html?token=" + token,
		idFactory: (() => {
			let id = 0;
			return () => "id-" + (++id);
		})(),
		now: () => 100
	});

	return {
		tabs,
		creates,
		service,
		storageValues,
		removeListeners,
		async activate(tabId) {
			const tab = tabs.get(tabId);
			if (!tab) throw new Error("No tab");
			activateListeners.forEach((listener) => listener({ tabId, windowId: tab.windowId }));
			await service.getState();
		},
		async remove(tabId) {
			const tab = tabs.get(tabId);
			if (!tab) return;
			tabs.delete(tabId);
			removeListeners.forEach((listener) => listener(tabId, { windowId: tab.windowId, isWindowClosing: false }));
			await service.getState();
		},
		state: () => service.getState()
	};
}

describe("LinkManagerService", () => {
	it("initializes an Inbox collection and persists the same list state", async () => {
		const env = createEnvironment();
		const state = await env.state();
		expect(state.lists).toHaveLength(1);
		expect(state.lists[0]).toMatchObject({ id: "inbox", name: "Inbox" });
		expect(env.storageValues[LINK_MANAGER_STORAGE_KEY]).toEqual(state);
	});

	it("stages a default batch of deferred tabs and records tab ownership", async () => {
		const env = createEnvironment();
		const state = await env.service.addLinks({
			urls: [
				{ url: "https://example.com/a", title: "A" },
				{ url: "https://example.com/b", title: "B" }
			]
		});
		expect(env.creates.map((entry) => entry.url)).toEqual([
			"extension://lazyTab.html?token=id-2",
			"extension://lazyTab.html?token=id-4"
		]);
		expect(state.items.map((item) => item.queueStatus)).toEqual([ "staged", "staged" ]);
		expect(state.items.every((item) => item.managed && item.tabId !== null)).toBe(true);
	});

	it("marks a managed link Viewed only after its tab becomes active", async () => {
		const env = createEnvironment();
		const state = await env.service.addLinks({ urls: [{ url: "https://example.com/a", title: "A" }] });
		const tabId = state.items[0]!.tabId!;
		expect(state.items[0]!.readStatus).toBe("unread");
		await env.activate(tabId);
		expect((await env.state()).items[0]!.readStatus).toBe("viewed");
	});

	it("A/refill creates one replacement when one of several managed tabs closes", async () => {
		const env = createEnvironment();
		await env.service.addLinks({
			urls: [ "a", "b", "c", "d", "e" ].map((letter) => ({
				url: "https://example.com/" + letter,
				title: letter.toUpperCase()
			}))
		});
		const before = await env.state();
		expect(before.items.filter((item) => item.tabId !== null)).toHaveLength(4);
		await env.remove(before.items[0]!.tabId!);
		const after = await env.state();
		expect(after.items.filter((item) => item.tabId !== null)).toHaveLength(4);
		expect(after.items.find((item) => item.url.endsWith("/e"))?.tabId).not.toBeNull();
	});

	it("B/batch does not replenish until every original batch tab has closed", async () => {
		const env = createEnvironment();
		await env.service.setMode("batch");
		await env.service.addLinks({
			urls: [ "a", "b", "c", "d", "e" ].map((letter) => ({
				url: "https://example.com/" + letter,
				title: letter
			}))
		});
		let state = await env.state();
		const originalTabIds = state.items.slice(0, 4).map((item) => item.tabId!);
		await env.remove(originalTabIds[0]!);
		expect(env.creates).toHaveLength(4);
		for (const tabId of originalTabIds.slice(1)) {
			await env.remove(tabId);
		}
		state = await env.state();
		expect(env.creates).toHaveLength(5);
		expect(state.items.find((item) => item.url.endsWith("/e"))?.tabId).not.toBeNull();
	});

	it("C/manual leaves queue items waiting after tab close until Stage next is pressed", async () => {
		const env = createEnvironment();
		await env.service.setMode("manual");
		await env.service.addLinks({
			urls: [ "a", "b", "c", "d", "e" ].map((letter) => ({
				url: "https://example.com/" + letter,
				title: letter
			}))
		});
		expect(env.creates).toHaveLength(0);
		await env.service.stageNext();
		const state = await env.state();
		expect(env.creates).toHaveLength(4);
		await env.remove(state.items[0]!.tabId!);
		expect(env.creates).toHaveLength(4);
		await env.service.stageNext();
		expect(env.creates).toHaveLength(5);
	});

	it("D/sequential opens direct destination tabs one at a time", async () => {
		const env = createEnvironment();
		await env.service.setMode("sequential");
		await env.service.addLinks({
			urls: [
				{ url: "https://example.com/a", title: "A" },
				{ url: "https://example.com/b", title: "B" }
			]
		});
		expect(env.creates).toHaveLength(1);
		expect(env.creates[0]!.url).toBe("https://example.com/a");
		const state = await env.state();
		await env.remove(state.items[0]!.tabId!);
		expect(env.creates).toHaveLength(2);
		expect(env.creates[1]!.url).toBe("https://example.com/b");
	});

	it("Pause closes managed tabs, keeps external tabs untouched, and Resume restores URLs in order", async () => {
		const external = { id: 9, index: 8, windowId: 1, url: "https://outside.example/", title: "External" };
		const env = createEnvironment([ external ]);
		const inspected = await env.service.inspectDuplicates([{ url: external.url!, title: external.title! }]);
		const duplicate = inspected[external.url!]![0]!;
		await env.service.addLinks({
			urls: [
				{ url: "https://example.com/a", title: "A" },
				{ url: external.url!, title: "External" },
				{ url: "https://example.com/b", title: "B" }
			],
			duplicateActions: [{ url: external.url!, tabId: duplicate.id, action: "activate" }]
		});
		let state = await env.service.getState();
		const managedBefore = state.items.filter((item) => item.managed && item.tabId !== null);
		expect(managedBefore).toHaveLength(2);
		state = await env.service.togglePause();
		expect(state.paused).toBe(true);
		expect(state.items.filter((item) => item.queueStatus === "suspended")).toHaveLength(2);
		expect(env.tabs.has(external.id!)).toBe(true);
		state = await env.service.togglePause();
		expect(state.paused).toBe(false);
		expect(state.items.filter((item) => item.managed && item.tabId !== null).map((item) => item.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b"
		]);
		expect(env.tabs.has(external.id!)).toBe(true);
	});

	it("rejects opening while paused and keeps manual read status after tab activation", async () => {
		const env = createEnvironment();
		const state = await env.service.addLinks({ urls: [{ url: "https://example.com/a", title: "A" }] });
		await env.service.setReadStatus(state.items[0]!.id, "read");
		const paused = await env.service.togglePause();
		expect(paused.paused).toBe(true);
		await expect(env.service.openItem(state.items[0]!.id)).rejects.toThrow("Resume Link Manager");
	});

	it("detects and activates existing duplicates without taking ownership", async () => {
		const existing = { id: 50, index: 5, windowId: 1, url: "https://example.com/already", title: "Already open" };
		const env = createEnvironment([ existing ]);
		const duplicates = await env.service.inspectDuplicates([{ url: existing.url!, title: existing.title! }]);
		expect(duplicates[existing.url!]![0]).toMatchObject({ id: 50, managed: false });
		const state = await env.service.addLinks({
			urls: [{ url: existing.url!, title: existing.title! }],
			duplicateActions: [{ url: existing.url!, tabId: 50, action: "activate" }]
		});
		expect(state.items[0]).toMatchObject({ managed: false, queueStatus: "external", tabId: 50, readStatus: "viewed" });
		expect(env.creates).toHaveLength(0);
	});

	it("keeps URL query strings and fragments significant during duplicate matching", async () => {
		const existing = { id: 50, index: 5, windowId: 1, url: "https://example.com/page?q=1#one", title: "Already open" };
		const env = createEnvironment([ existing ]);
		const different = await env.service.inspectDuplicates([
			{ url: "https://example.com/page?q=2#one", title: "Different query" }
		]);
		expect(different).toEqual({});
	});
	it("reconnects a placeholder created just before a worker restart using its persisted token", async () => {
		const env = createEnvironment();
		let state = await env.service.addLinks({
			urls: [{ url: "https://example.com/recover", title: "Recover me" }]
		});
		const item = state.items[0]!;
		const originalTabId = item.tabId!;
		state = {
			...state,
			items: state.items.map((candidate) => candidate.id === item.id
				? { ...candidate, tabId: null, queueStatus: "opening" }
				: candidate)
		};
		env.storageValues[LINK_MANAGER_STORAGE_KEY] = state;

		await env.service.recover();
		state = await env.state();
		expect(state.items[0]!.tabId).toBe(originalTabId);
		expect(state.items[0]!.queueStatus).toBe("staged");
	});

	it("removes an orphan placeholder by token when recovery finds Link Manager already paused", async () => {
		const env = createEnvironment();
		let state = await env.service.addLinks({
			urls: [{ url: "https://example.com/paused-recovery", title: "Paused" }]
		});
		const item = state.items[0]!;
		const originalTabId = item.tabId!;
		state = {
			...state,
			paused: true,
			items: state.items.map((candidate) => candidate.id === item.id
				? { ...candidate, tabId: null, queueStatus: "suspended" }
				: candidate)
		};
		env.storageValues[LINK_MANAGER_STORAGE_KEY] = state;

		await env.service.recover();
		expect(env.tabs.has(originalTabId)).toBe(false);
		expect((await env.state()).paused).toBe(true);
	});

	it("closes a managed browser tab when its link is removed from the manager", async () => {
		const env = createEnvironment();
		const state = await env.service.addLinks({
			urls: [{ url: "https://example.com/remove", title: "Remove me" }]
		});
		const tabId = state.items[0]!.tabId!;
		await env.service.removeItem(state.items[0]!.id);
		expect(env.tabs.has(tabId)).toBe(false);
		expect((await env.state()).items).toHaveLength(0);
	});

});
