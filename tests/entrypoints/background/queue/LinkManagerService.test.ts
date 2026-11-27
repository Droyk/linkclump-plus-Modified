import { describe, expect, it, vi } from "vitest";
import {
	LINK_MANAGER_STORAGE_KEY,
	LinkManagerService,
	type LinkManagerStorageAdapter,
	type LinkManagerTabInfo,
	type LinkManagerTabsAdapter,
	type LinkManagerWindowsAdapter
} from "@/entrypoints/background/queue/LinkManagerService";
import type { LinkManagerState } from "@/assets/js/types/LinkManager";

interface FakeEnvironment {
	readonly tabs: Map<number, LinkManagerTabInfo>;
	readonly created: { url: string; windowId: number; active: boolean }[];
	readonly removed: number[];
	readonly focusedWindows: number[];
	readonly service: LinkManagerService;
	readonly storageValues: Record<string, unknown>;
	readonly sessionValues: Record<string, unknown>;
	activate(tabId: number): Promise<void>;
	remove(tabId: number, isWindowClosing?: boolean): Promise<void>;
	closeWindow(windowId: number): Promise<void>;
	state(): Promise<LinkManagerState>;
}

function createEnvironment(initialTabs: LinkManagerTabInfo[] = []): Promise<FakeEnvironment> {
	const seed = initialTabs.length > 0
		? initialTabs
		: [ { id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true } ];
	const tabs = new Map<number, LinkManagerTabInfo>(seed.map((tab) => [ tab.id!, { ...tab } ]));
	const storageValues: Record<string, unknown> = {};
	const sessionValues: Record<string, unknown> = {};
	const created: FakeEnvironment["created"] = [];
	const removed: number[] = [];
	const focusedWindows: number[] = [];
	const activateListeners: ((info: { tabId: number; windowId: number }) => void)[] = [];
	const removeListeners: ((tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void)[] = [];
	const updateListeners: ((tabId: number, info: { url?: string }, tab: LinkManagerTabInfo) => void)[] = [];
	const attachListeners: ((tabId: number, info: { newWindowId: number }) => void)[] = [];
	let nextId = Math.max(10, ...tabs.keys()) + 1;

	function activateInternal(tabId: number): void {
		const target = tabs.get(tabId);
		if (!target) {
			throw new Error("No tab");
		}
		for (const [ id, tab ] of tabs) {
			if (tab.windowId === target.windowId) {
				tabs.set(id, { ...tab, active: id === tabId });
			}
		}
		activateListeners.forEach((listener) => listener({ tabId, windowId: target.windowId }));
	}

	function removeInternal(tabId: number, isWindowClosing = false): void {
		const tab = tabs.get(tabId);
		if (!tab) {
			return;
		}
		tabs.delete(tabId);
		removed.push(tabId);
		if (tab.active && !isWindowClosing) {
			const successor = [ ...tabs.values() ]
				.filter((candidate) => candidate.windowId === tab.windowId)
				.sort((a, b) => a.index - b.index)[0];
			if (successor?.id !== undefined) {
				activateInternal(successor.id);
			}
		}
		removeListeners.forEach((listener) => listener(tabId, {
			windowId: tab.windowId,
			isWindowClosing
		}));
	}

	const tabsAdapter: LinkManagerTabsAdapter = {
		get: vi.fn(async (tabId) => {
			const tab = tabs.get(tabId);
			if (!tab) {
				throw new Error("No tab");
			}
			return tab;
		}),
		query: vi.fn(async () => [ ...tabs.values() ]),
		create: vi.fn(async (properties) => {
			const tab: LinkManagerTabInfo = {
				id: nextId++,
				index: tabs.size,
				windowId: properties.windowId ?? 1,
				url: properties.url,
				title: properties.url,
				active: properties.active
			};
			tabs.set(tab.id!, tab);
			created.push({ url: properties.url, windowId: tab.windowId, active: properties.active });
			if (properties.active) {
				activateInternal(tab.id!);
			}
			return tabs.get(tab.id!)!;
		}),
		update: vi.fn(async (tabId, properties) => {
			const current = tabs.get(tabId);
			if (!current) {
				throw new Error("No tab");
			}
			const next = { ...current, ...properties };
			tabs.set(tabId, next);
			if (properties.active === true) {
				activateInternal(tabId);
			}
			if (properties.url !== undefined) {
				updateListeners.forEach((listener) => listener(tabId, { url: properties.url }, tabs.get(tabId)!));
			}
			return tabs.get(tabId)!;
		}),
		remove: vi.fn(async (ids) => {
			for (const id of (Array.isArray(ids) ? ids : [ ids ])) {
				removeInternal(id);
			}
		}),
		onActivated: { addListener: (listener) => activateListeners.push(listener) },
		onRemoved: { addListener: (listener) => removeListeners.push(listener) },
		onUpdated: { addListener: (listener) => updateListeners.push(listener) },
		onAttached: { addListener: (listener) => attachListeners.push(listener) }
	};

	const localStorage: LinkManagerStorageAdapter = {
		get: vi.fn(async (key) => ({ [key]: storageValues[key] })),
		set: vi.fn(async (items) => { Object.assign(storageValues, items); })
	};
	const sessionStorage: LinkManagerStorageAdapter = {
		get: vi.fn(async (key) => ({ [key]: sessionValues[key] })),
		set: vi.fn(async (items) => { Object.assign(sessionValues, items); })
	};
	const windowsAdapter: LinkManagerWindowsAdapter = {
		update: vi.fn(async (windowId) => {
			focusedWindows.push(windowId);
		})
	};
	const service = new LinkManagerService(tabsAdapter, localStorage, {
		windows: windowsAdapter,
		sessionStorage,
		idFactory: (() => {
			let id = 0;
			return () => "item-" + (++id);
		})(),
		now: () => 100
	});
	service.register();

	return service.recover().then(() => ({
		tabs,
		created,
		removed,
		focusedWindows,
		service,
		storageValues,
		sessionValues,
		async activate(tabId) {
			activateInternal(tabId);
			await service.getState();
		},
		async remove(tabId, isWindowClosing = false) {
			removeInternal(tabId, isWindowClosing);
			await service.getState();
		},
		async closeWindow(windowId) {
			for (const tab of [ ...tabs.values() ].filter((candidate) => candidate.windowId === windowId)) {
				removeInternal(tab.id!, true);
			}
			await service.getState();
		},
		state: () => service.getState()
	}));
}

function url(path: string): string {
	return "https://example.com/" + path;
}

describe("LinkManagerService — direct sequential queue", () => {
	it("saves selected page links persistently without starting the queue or collapsing same-URL elements", async () => {
		const env = await createEnvironment();
		const state = await env.service.saveSelection([
			{ url: url("same"), title: "First anchor" },
			{ url: url("same"), title: "Second anchor" }
		], 1);
		expect(state.items).toHaveLength(2);
		expect(state.items.map((item) => item.title)).toEqual([ "First anchor", "Second anchor" ]);
		expect(state.items.map((item) => item.status)).toEqual([ "queued", "queued" ]);
		expect(env.created).toHaveLength(0);
		expect(env.storageValues[LINK_MANAGER_STORAGE_KEY]).toEqual(state);
	});

	it("creates one direct destination tab and keeps later links pending", async () => {
		const env = await createEnvironment();
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("a"), title: "A" },
				{ url: url("b"), title: "B" }
			]
		});

		expect(env.created).toEqual([{ url: url("a"), windowId: 1, active: true }]);
		expect(state.items.map((item) => item.status)).toEqual([ "open", "queued" ]);
		expect(state.items[0]).toMatchObject({ ownership: "managed", readStatus: "read" });
		expect(state.items[1]).toMatchObject({ tabId: null, ownership: null, readStatus: "unread" });
		expect(JSON.stringify(state)).not.toMatch(/placeholder|batch|viewed|staged/i);
	});

	it("does not advance when an inactive queue tab closes", async () => {
		const env = await createEnvironment();
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [ "a", "b", "c" ].map((part) => ({ url: url(part), title: part }))
		});
		const firstId = state.items[0]!.id;
		state = await env.service.openSelected(state.items.map((item) => item.id), 1);
		const firstTab = state.items.find((item) => item.id === firstId)!.tabId!;
		const secondTab = state.items[1]!.tabId!;
		expect(env.created).toHaveLength(3);
		await env.remove(secondTab);
		state = await env.state();
		expect(env.created).toHaveLength(3);
		expect(tabsActive(env.tabs, firstTab)).toBe(true);
		expect(state.items[1]!.status).toBe("closed");
	});

	it("activates the next already-open queue tab before creating another tab", async () => {
		const env = await createEnvironment();
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [ "a", "b", "c" ].map((part) => ({ url: url(part), title: part }))
		});
		state = await env.service.openSelected(state.items.map((item) => item.id), 1);
		const firstTab = state.items[0]!.tabId!;
		const secondTab = state.items[1]!.tabId!;
		await env.remove(firstTab);
		state = await env.state();
		expect(env.created).toHaveLength(3);
		expect(tabsActive(env.tabs, secondTab)).toBe(true);
		expect(state.items[0]!.status).toBe("closed");
		expect(state.items[1]!.status).toBe("open");
	});

	it("opens the next pending URL directly when no other queue tab is open", async () => {
		const env = await createEnvironment();
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("first"), title: "First" },
				{ url: url("next"), title: "Next" }
			]
		});
		await env.remove(state.items[0]!.tabId!);
		const after = await env.state();
		expect(env.created.map((entry) => entry.url)).toEqual([ url("first"), url("next") ]);
		expect(after.items[1]).toMatchObject({ status: "open", readStatus: "read" });
	});

	it("does not advance when the user switches away and later closes the inactive queue tab", async () => {
		const env = await createEnvironment();
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("first"), title: "First" },
				{ url: url("second"), title: "Second" }
			]
		});
		const queueTab = state.items[0]!.tabId!;
		await env.activate(1);
		await env.remove(queueTab);
		const after = await env.state();
		expect(env.created).toHaveLength(1);
		expect(after.items[1]).toMatchObject({ status: "queued", tabId: null });
	});

	it("opens selected links in selection order with only the first in the foreground", async () => {
		const env = await createEnvironment();
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [ "one", "two", "three" ].map((part) => ({ url: url(part), title: part }))
		});
		state = await env.service.openSelected(state.items.map((item) => item.id), 1);
		expect(env.created.map((entry) => entry.url)).toEqual([ url("one"), url("two"), url("three") ]);
		expect(env.created.map((entry) => entry.active)).toEqual([ true, false, false ]);
		const active = [ ...env.tabs.values() ].find((tab) => tab.active && tab.windowId === 1);
		expect(active?.url).toBe(url("one"));
		expect(state.items.map((item) => item.readStatus)).toEqual([ "read", "unread", "unread" ]);
	});

	it("reuses one selected duplicate, closes only checked copies, and leaves the rest untouched", async () => {
		const duplicates: LinkManagerTabInfo[] = [ 10, 11, 12, 13, 14, 15 ].map((id, index) => ({
			id,
			index: index + 1,
			windowId: 1,
			url: url("same"),
			title: "Duplicate " + id,
			active: id === 10
		}));
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: false },
			...duplicates
		]);
		const inspected = await env.service.inspectDuplicates([{ url: url("same"), title: "Same" }], 1);
		expect(inspected.duplicates[url("same")]).toHaveLength(6);

		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("same"), title: "Same" }],
			duplicateActions: [{
				url: url("same"),
				action: "custom",
				activateTabId: 12,
				closeTabIds: [ 14, 15 ],
				ownership: "borrowed"
			}]
		});
		state = await env.state();
		expect(env.tabs.has(14)).toBe(false);
		expect(env.tabs.has(15)).toBe(false);
		expect([ 10, 11, 12, 13 ].every((id) => env.tabs.has(id))).toBe(true);
		expect(tabsActive(env.tabs, 12)).toBe(true);
		expect(state.items[0]).toMatchObject({ tabId: 12, ownership: "borrowed", status: "open" });
	});

	it("rejects a duplicate tab selected for both activation and closure", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 10, index: 1, windowId: 1, url: url("same"), title: "Duplicate", active: false }
		]);
		await expect(env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("same"), title: "Same" }],
			duplicateActions: [{
				url: url("same"),
				action: "custom",
				activateTabId: 10,
				closeTabIds: [ 10 ]
			}]
		})).rejects.toThrow("cannot be selected for both");
		expect(env.tabs.has(10)).toBe(true);
	});

	it("defaults reused tabs to Borrowed and newly created tabs to Managed", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 10, index: 1, windowId: 1, url: url("existing"), title: "Existing", active: false }
		]);
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("existing"), title: "Existing" },
				{ url: url("new"), title: "New" }
			],
			duplicateActions: [{ url: url("existing"), action: "activate", activateTabId: 10 }]
		});
		expect(state.items[0]).toMatchObject({ tabId: 10, ownership: "borrowed" });
		expect(state.items[1]).toMatchObject({ tabId: null, status: "queued" });
	});

	it("closes managed tabs on Pause, leaves borrowed tabs open, and restores managed URLs on Resume", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 1, windowId: 1, url: url("borrowed"), title: "Borrowed", active: false }
		]);
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("managed"), title: "Managed" },
				{ url: url("borrowed"), title: "Borrowed" }
			],
			duplicateActions: [{ url: url("borrowed"), action: "activate", activateTabId: 20 }]
		});
		state = await env.service.openSelected(state.items.map((item) => item.id), 1);
		const managedId = state.items[0]!.tabId!;
		expect(state.items[1]!.ownership).toBe("borrowed");
		state = await env.service.togglePause();
		expect(state.paused).toBe(true);
		expect(env.tabs.has(managedId)).toBe(false);
		expect(env.tabs.has(20)).toBe(true);
		state = await env.service.togglePause();
		expect(state.paused).toBe(false);
		expect(state.items[0]!.tabId).not.toBeNull();
		expect(env.tabs.has(20)).toBe(true);
		expect(env.created.some((entry) => entry.url === url("managed"))).toBe(true);
	});


	it("reorders links within their collection without changing tab associations", async () => {
		const env = await createEnvironment();
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [ "first", "second", "third" ].map((part) => ({ url: url(part), title: part }))
		});
		const ids = state.items.map((item) => item.id);
		state = await env.service.moveItem(ids[2]!, -1);
		expect([ ...state.items ].sort((a, b) => a.order - b.order).map((item) => item.title))
			.toEqual([ "first", "third", "second" ]);
		expect(state.items[0]!.tabId).not.toBeNull();
	});

	it("removes later duplicate URLs but keeps the first saved item and borrowed browser tab", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 1, windowId: 1, url: url("same"), title: "Borrowed existing", active: false }
		]);
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("same"), title: "First" }],
			duplicateActions: [{ url: url("same"), action: "activate", activateTabId: 20, ownership: "borrowed" }]
		});
		state = await env.service.saveSelection([{ url: url("same"), title: "Repeated" }], 1);
		expect(state.items).toHaveLength(2);
		state = await env.service.removeDuplicateUrls(1, "inbox");
		expect(state.items).toHaveLength(1);
		expect(state.items[0]!.title).toBe("First");
		expect(env.tabs.has(20)).toBe(true);
	});

	it("clears a collection, closing managed tabs but preserving borrowed tabs", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 1, windowId: 1, url: url("borrowed"), title: "Borrowed", active: false }
		]);
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("managed"), title: "Managed" },
				{ url: url("borrowed"), title: "Borrowed" }
			],
			duplicateActions: [{ url: url("borrowed"), action: "activate", activateTabId: 20 }]
		});
		state = await env.service.openSelected(state.items.map((item) => item.id), 1);
		const managedTabId = state.items.find((item) => item.url === url("managed"))!.tabId!;
		state = await env.service.clearCollection(1, "inbox");
		expect(state.items).toHaveLength(0);
		expect(env.tabs.has(managedTabId)).toBe(false);
		expect(env.tabs.has(20)).toBe(true);
	});

	it("removing a Borrowed item leaves its browser tab open", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 1, windowId: 1, url: url("borrowed"), title: "Borrowed", active: false }
		]);
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("borrowed"), title: "Borrowed" }],
			duplicateActions: [{ url: url("borrowed"), action: "activate", activateTabId: 20 }]
		});
		await env.service.removeItem(state.items[0]!.id);
		expect(env.tabs.has(20)).toBe(true);
		expect((await env.state()).items).toHaveLength(0);
	});

	it("marks a tab Read when activated and restores Read after a manual Unread choice on next activation", async () => {
		const env = await createEnvironment();
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("read"), title: "Read test" }]
		});
		const item = state.items[0]!;
		await env.service.setReadStatus(item.id, "unread");
		await env.activate(1);
		await env.activate(item.tabId!);
		expect((await env.state()).items[0]!.readStatus).toBe("read");
	});

	it("ignores matching tabs in other windows under Current window only", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 0, windowId: 2, url: url("external"), title: "Other window", active: true }
		]);
		const inspected = await env.service.inspectDuplicates([{ url: url("external"), title: "External" }], 1);
		expect(inspected.duplicates).toEqual({});
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("external"), title: "External" }]
		});
		expect(state.items[0]!.tabWindowId).toBe(1);
		expect(env.tabs.has(20)).toBe(true);
	});

	it("follows a matching tab into another window when Follow across windows is enabled", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source.example/", title: "Source", active: true },
			{ id: 20, index: 0, windowId: 2, url: url("external"), title: "Other window", active: true }
		]);
		await env.service.setWindowPolicy("follow");
		const inspected = await env.service.inspectDuplicates([{ url: url("external"), title: "External" }], 1);
		expect(inspected.duplicates[url("external")]).toHaveLength(1);
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("external"), title: "External" }],
			duplicateActions: [{ url: url("external"), action: "activate", activateTabId: 20 }]
		});
		expect(state.items[0]).toMatchObject({ tabId: 20, tabWindowId: 2, ownership: "borrowed" });
		expect(env.focusedWindows).toContain(2);
	});


	it("pauses and resumes each browser window independently", async () => {
		const env = await createEnvironment([
			{ id: 1, index: 0, windowId: 1, url: "https://source-one.example/", title: "Source one", active: true },
			{ id: 2, index: 0, windowId: 2, url: "https://source-two.example/", title: "Source two", active: true }
		]);
		let state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [{ url: url("one"), title: "Window one" }]
		});
		const firstTabId = state.items[0]!.tabId!;
		state = await env.service.addLinks({
			queueWindowId: 2,
			urls: [{ url: url("two"), title: "Window two" }]
		});
		const secondTabId = state.items.find((item) => item.queueWindowId === 2)!.tabId!;

		state = await env.service.togglePause(1);
		expect(state.pausedWindowIds).toContain(1);
		expect(state.pausedWindowIds).not.toContain(2);
		expect(env.tabs.has(firstTabId)).toBe(false);
		expect(env.tabs.has(secondTabId)).toBe(true);

		state = await env.service.addLinks({
			queueWindowId: 2,
			urls: [{ url: url("two-more"), title: "Window two remains active" }]
		});
		expect(state.items.find((item) => item.url === url("two-more"))?.status).toBe("queued");

		state = await env.service.togglePause(1);
		expect(state.pausedWindowIds).not.toContain(1);
		expect(state.items.find((item) => item.url === url("one"))?.status).toBe("open");
		expect(env.created.filter((tab) => tab.url === url("one"))).toHaveLength(2);
	});

	it("does not open replacement tabs when an entire queue window closes", async () => {
		const env = await createEnvironment();
		const state = await env.service.addLinks({
			queueWindowId: 1,
			urls: [
				{ url: url("a"), title: "A" },
				{ url: url("b"), title: "B" }
			]
		});
		await env.closeWindow(1);
		expect(env.created).toHaveLength(1);
		expect((await env.state()).items[1]!.status).toBe("queued");
		expect(state.items[0]!.tabId).not.toBeNull();
	});
});

function tabsActive(tabs: Map<number, LinkManagerTabInfo>, tabId: number): boolean {
	return tabs.get(tabId)?.active === true;
}
