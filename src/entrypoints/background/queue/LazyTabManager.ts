import { browser } from "wxt/browser";

export const LAZY_TAB_ENTRY_PREFIX = "linkclumpLazyTabEntry:" as const;
export const LAZY_TAB_ID_PREFIX = "linkclumpLazyTabId:" as const;
const LAZY_TAB_PATH = "/lazyTab.html" as const;
const MAX_LAZY_TAB_DELAY_MS = 30_000;

export interface LazyTabInfo {
	readonly id?: number;
	readonly index: number;
	readonly windowId: number;
	readonly url?: string;
	readonly active?: boolean;
}

export interface LazyTabsAdapter {
	get(tabId: number): Promise<LazyTabInfo>;
	create(properties: {
		url: string;
		active: false;
		windowId: number;
		index: number;
		openerTabId: number;
	}): Promise<LazyTabInfo>;
	update(tabId: number, properties: { url: string }): Promise<LazyTabInfo>;
	query(): Promise<LazyTabInfo[]>;
	onActivated: {
		addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
	};
	onRemoved: {
		addListener(listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
	};
}

export interface LazyStorageAdapter {
	get(key: string | null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

export interface PendingLazyTab {
	readonly token: string;
	readonly url: string;
	readonly title: string;
	readonly tabId: number | null;
}

export class LazyTabManager {
	private readonly tabs: LazyTabsAdapter;
	private readonly storage: LazyStorageAdapter;
	private readonly lazyPageUrl: (token: string) => string;
	private readonly tokenFactory: () => string;
	private readonly openingTabs = new Set<number>();
	private listenerRegistered = false;

	constructor(
		tabs: LazyTabsAdapter,
		storage: LazyStorageAdapter,
		lazyPageUrl: (token: string) => string,
		tokenFactory: () => string = () => globalThis.crypto.randomUUID()
	) {
		this.tabs = tabs;
		this.storage = storage;
		this.lazyPageUrl = lazyPageUrl;
		this.tokenFactory = tokenFactory;
	}

	register(): void {
		if (this.listenerRegistered) {
			return;
		}
		this.listenerRegistered = true;

		this.tabs.onActivated.addListener((activeInfo) => {
			void this.handleTabActivation(activeInfo.tabId).catch((error: unknown) => {
				console.error("[background] Failed to load deferred tab:", error);
			});
		});

		this.tabs.onRemoved.addListener((tabId) => {
			void this.handleTabRemoved(tabId).catch((error: unknown) => {
				console.error("[background] Failed to clean deferred tab record:", error);
			});
		});
	}

	/**
	 * Creates extension-owned placeholders. Destination pages are not requested until
	 * the corresponding placeholder tab is activated. delayMs spaces out placeholder
	 * creation only; it does not control destination navigation.
	 */
	async create(
		urls: readonly { url: string; title: string }[],
		sourceTabId: number | undefined,
		delayMs = 0,
		blockDuplicates = true
	): Promise<number> {
		if (sourceTabId === undefined || !Number.isInteger(sourceTabId)) {
			return 0;
		}

		const sourceTab = await this.getTab(sourceTabId);
		if (!sourceTab || sourceTab.id === undefined) {
			return 0;
		}

		const normalizedUrls = normalizeLazyUrls(urls, blockDuplicates);
		if (normalizedUrls.length === 0) {
			return 0;
		}

		const spacing = Number.isFinite(delayMs)
			? Math.max(0, Math.min(Math.floor(delayMs), MAX_LAZY_TAB_DELAY_MS))
			: 0;
		let created = 0;

		for (let index = 0; index < normalizedUrls.length; index++) {
			const item = normalizedUrls[index];
			if (!item) {
				continue;
			}

			const token = this.tokenFactory();
			const entryKey = LAZY_TAB_ENTRY_PREFIX + token;
			const idKeyPrefix = LAZY_TAB_ID_PREFIX;
			const record: PendingLazyTab = {
				token,
				url: item.url,
				title: item.title,
				tabId: null
			};

			// Save the destination before creating the placeholder. The placeholder page
			// and activation listener can therefore read it immediately, even if the tab
			// is clicked before tabs.create() resolves.
			await this.storage.set({ [entryKey]: record });

			let tab: LazyTabInfo;
			try {
				tab = await this.tabs.create({
					url: this.lazyPageUrl(token),
					active: false,
					windowId: sourceTab.windowId,
					index: sourceTab.index + 1 + created,
					openerTabId: sourceTab.id
				});
			} catch (error) {
				await this.storage.remove(entryKey);
				throw error;
			}

			if (tab.id === undefined) {
				await this.storage.remove(entryKey);
				continue;
			}

			// Serialize activation against the post-create storage update.
			this.openingTabs.add(tab.id);
			let shouldNavigate = false;
			try {
				const stored = await this.storage.get(entryKey);
				if (isPendingLazyTab(stored[entryKey])) {
					const updatedRecord: PendingLazyTab = { ...record, tabId: tab.id };
					await this.storage.set({
						[entryKey]: updatedRecord,
						[idKeyPrefix + tab.id]: token
					});
					const currentTab = await this.getTab(tab.id);
					if (!currentTab) {
						await this.storage.remove([ entryKey, idKeyPrefix + tab.id ]);
					} else {
						shouldNavigate = currentTab.active === true && getTokenFromUrl(currentTab.url) === token;
					}
				}
			} finally {
				this.openingTabs.delete(tab.id);
			}

			if (shouldNavigate) {
				await this.navigateTab(tab.id, token);
			}

			created++;
			if (spacing > 0 && index < normalizedUrls.length - 1) {
				await wait(spacing);
			}
		}

		return created;
	}

	/**
	 * Called when the worker starts. It reconciles persisted records with actual tabs,
	 * loads a deferred page that is already active, and removes records for closed tabs.
	 */
	async recover(): Promise<void> {
		const allStored = await this.storage.get(null);
		const tabs = await this.tabs.query();
		const tabsById = new Map(tabs.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));

		for (const [ key, value ] of Object.entries(allStored)) {
			if (!key.startsWith(LAZY_TAB_ENTRY_PREFIX)) {
				continue;
			}

			if (!isPendingLazyTab(value)) {
				await this.storage.remove(key);
				continue;
			}

			const tab = value.tabId === null
				? tabs.find((item) => getTokenFromUrl(item.url) === value.token)
				: tabsById.get(value.tabId);

			if (!tab || tab.id === undefined) {
				await this.storage.remove([ key, ...(value.tabId === null ? [] : [ LAZY_TAB_ID_PREFIX + value.tabId ]) ]);
				continue;
			}

			// The tab has already navigated away from the placeholder. Clean stale state
			// left by a worker shutdown between tabs.update() and storage.remove().
			if (getTokenFromUrl(tab.url) !== value.token) {
				await this.storage.remove([ key, LAZY_TAB_ID_PREFIX + tab.id ]);
				continue;
			}

			if (value.tabId === null) {
				await this.storage.set({
					[key]: { ...value, tabId: tab.id },
					[LAZY_TAB_ID_PREFIX + tab.id]: value.token
				});
			}

			if (tab.active) {
				await this.navigateTab(tab.id, value.token);
			}
		}
	}

	/** Public event entry points keep listener behavior directly testable. */
	handleTabActivation(tabId: number): Promise<void> {
		return this.loadActivatedTab(tabId);
	}

	handleTabRemoved(tabId: number): Promise<void> {
		return this.removeTabRecord(tabId);
	}

	private async loadActivatedTab(tabId: number): Promise<void> {
		if (this.openingTabs.has(tabId)) {
			return;
		}

		const tab = await this.getTab(tabId);
		const token = getTokenFromUrl(tab?.url);
		if (!token) {
			return;
		}

		await this.navigateTab(tabId, token);
	}

	private async navigateTab(tabId: number, token: string): Promise<void> {
		if (this.openingTabs.has(tabId)) {
			return;
		}
		this.openingTabs.add(tabId);

		const entryKey = LAZY_TAB_ENTRY_PREFIX + token;
		const idKey = LAZY_TAB_ID_PREFIX + tabId;
		try {
			const stored = await this.storage.get(entryKey);
			const record = stored[entryKey];
			if (!isPendingLazyTab(record) || record.token !== token) {
				return;
			}

			await this.tabs.update(tabId, { url: record.url });
			await this.storage.remove([ entryKey, idKey ]);
		} finally {
			this.openingTabs.delete(tabId);
		}
	}

	private async removeTabRecord(tabId: number): Promise<void> {
		const idKey = LAZY_TAB_ID_PREFIX + tabId;
		const stored = await this.storage.get(idKey);
		const token = stored[idKey];
		if (typeof token !== "string") {
			return;
		}
		await this.storage.remove([ idKey, LAZY_TAB_ENTRY_PREFIX + token ]);
	}

	private async getTab(tabId: number): Promise<LazyTabInfo | null> {
		try {
			return await this.tabs.get(tabId);
		} catch {
			return null;
		}
	}
}

function isPendingLazyTab(value: unknown): value is PendingLazyTab {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	if (typeof item.token !== "string" || typeof item.url !== "string" || typeof item.title !== "string") {
		return false;
	}
	if (item.tabId !== null && !Number.isInteger(item.tabId)) {
		return false;
	}
	try {
		return new URL(item.url).protocol !== "javascript:";
	} catch {
		return false;
	}
}

function normalizeLazyUrls(
	urls: readonly { url: string; title: string }[],
	blockDuplicates: boolean
): { url: string; title: string }[] {
	const result: { url: string; title: string }[] = [];
	const seen = new Set<string>();

	for (const item of urls) {
		if (typeof item?.url !== "string" || typeof item.title !== "string") {
			continue;
		}

		const url = item.url.trim();
		try {
			if (new URL(url).protocol === "javascript:") {
				continue;
			}
			new URL(url);
		} catch {
			continue;
		}

		if (blockDuplicates && seen.has(url)) {
			continue;
		}
		seen.add(url);
		result.push({ url, title: item.title.trim() || url });
	}

	return result;
}

function getTokenFromUrl(url: string | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).searchParams.get("token");
	} catch {
		return null;
	}
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export const lazyTabManager = new LazyTabManager(
	browser.tabs as unknown as LazyTabsAdapter,
	browser.storage.local as unknown as LazyStorageAdapter,
	(token) => browser.runtime.getURL(LAZY_TAB_PATH + "?token=" + encodeURIComponent(token))
);
