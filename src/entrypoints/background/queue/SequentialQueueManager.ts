import { browser } from "wxt/browser";

export const SEQUENTIAL_QUEUE_STORAGE_KEY = "linkclumpSequentialQueue" as const;

export interface SequentialQueueUrl {
	readonly url: string;
	readonly title: string;
}

export interface QueueTabInfo {
	readonly id?: number;
	readonly index: number;
	readonly windowId: number;
}

export interface QueueTabsAdapter {
	get(tabId: number): Promise<QueueTabInfo>;
	create(properties: {
		url: string;
		active: false;
		windowId: number;
		index: number;
		openerTabId: number;
	}): Promise<QueueTabInfo>;
	onRemoved: {
		addListener(listener: (tabId: number, removeInfo: { isWindowClosing: boolean }) => void): void;
	};
}

export interface QueueStorageAdapter {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

interface SequentialQueueState {
	readonly version: 1;
	readonly sourceTabId: number;
	readonly windowId: number;
	readonly urls: SequentialQueueUrl[];
	readonly nextIndex: number;
	readonly activeTabId: number | null;
}

function isQueueUrl(value: unknown): value is SequentialQueueUrl {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	if (typeof item.url !== "string" || item.url.trim() === "" || typeof item.title !== "string") {
		return false;
	}

	try {
		return new URL(item.url.trim()).protocol !== "javascript:";
	} catch {
		return false;
	}
}

function isQueueState(value: unknown): value is SequentialQueueState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const state = value as Record<string, unknown>;
	return state.version === 1
		&& Number.isInteger(state.sourceTabId)
		&& Number.isInteger(state.windowId)
		&& Array.isArray(state.urls)
		&& state.urls.every(isQueueUrl)
		&& Number.isInteger(state.nextIndex)
		&& (state.nextIndex as number) >= 0
		&& (state.nextIndex as number) <= state.urls.length
		&& (state.activeTabId === null || Number.isInteger(state.activeTabId));
}

/**
 * One-at-a-time tab queue. The next URL is opened only when the exact tab created for the
 * current queue item is removed. Unrelated tab closures are ignored.
 *
 * State is persisted because Manifest V3 background workers can be suspended between tabs.
 * All mutations are serialized to prevent duplicate advancement when browser events overlap.
 */
export class SequentialQueueManager {
	private readonly tabs: QueueTabsAdapter;
	private readonly storage: QueueStorageAdapter;
	private cachedState: SequentialQueueState | null | undefined;
	private operationChain: Promise<void> = Promise.resolve();
	private listenerRegistered = false;

	constructor(tabs: QueueTabsAdapter, storage: QueueStorageAdapter) {
		this.tabs = tabs;
		this.storage = storage;
	}

	register(): void {
		if (this.listenerRegistered) {
			return;
		}
		this.listenerRegistered = true;
		this.tabs.onRemoved.addListener((tabId, removeInfo) => {
			void this.advanceAfterTabRemoval(tabId, removeInfo).catch((error: unknown) => {
				console.error("[background] Failed to advance sequential queue:", error);
			});
		});
	}

	/**
	 * Starts or replaces the single active queue. The source tab is retained as the anchor
	 * for the queue; closing it cancels the queue rather than opening tabs in another window.
	 */
	start(urls: readonly SequentialQueueUrl[], sourceTabId: number | undefined, blockDuplicates = true): Promise<boolean> {
		return this.serialize(async () => {
			if (sourceTabId === undefined || !Number.isInteger(sourceTabId)) {
				return false;
			}

			const sourceTab = await this.getTab(sourceTabId);
			if (!sourceTab || sourceTab.id === undefined) {
				return false;
			}

			const normalizedUrls = normalizeQueueUrls(urls, blockDuplicates);
			if (normalizedUrls.length === 0) {
				return false;
			}

			await this.clearState();
			const state: SequentialQueueState = {
				version: 1,
				sourceTabId,
				windowId: sourceTab.windowId,
				urls: normalizedUrls,
				nextIndex: 0,
				activeTabId: null
			};

			await this.writeState(state);
			await this.openNext(state);
			return true;
		});
	}

	/** Serializes a tab-removal event; public to permit deterministic adapter-based tests. */
	advanceAfterTabRemoval(tabId: number, removeInfo: { isWindowClosing: boolean }): Promise<void> {
		return this.serialize(() => this.handleTabRemoved(tabId, removeInfo));
	}

	/** Cancels future queue advancement but deliberately leaves the already-open tab alone. */
	stop(): Promise<void> {
		return this.serialize(() => this.clearState());
	}

	/**
	 * Recovers a queue after a background worker restart. If its active tab still exists,
	 * it remains the sole open queue item. If it was closed before recovery, the next URL opens.
	 */
	recover(): Promise<void> {
		return this.serialize(async () => {
			const state = await this.readState();
			if (!state) {
				return;
			}

			const sourceTab = await this.getTab(state.sourceTabId);
			if (!sourceTab) {
				await this.clearState();
				return;
			}

			if (state.activeTabId !== null) {
				const activeTab = await this.getTab(state.activeTabId);
				if (activeTab) {
					return;
				}
			}

			const waitingState: SequentialQueueState = {
				...state,
				windowId: sourceTab.windowId,
				activeTabId: null
			};
			await this.writeState(waitingState);
			await this.openNext(waitingState);
		});
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationChain.then(operation, operation);
		this.operationChain = result.then(() => undefined, () => undefined);
		return result;
	}

	private async handleTabRemoved(tabId: number, removeInfo: { isWindowClosing: boolean }): Promise<void> {
		const state = await this.readState();
		if (!state) {
			return;
		}

		if (tabId === state.sourceTabId) {
			await this.clearState();
			return;
		}

		if (tabId !== state.activeTabId) {
			return;
		}

		// Closing the whole window is a cancellation, not a request to open the next item
		// in a different window.
		if (removeInfo.isWindowClosing) {
			await this.clearState();
			return;
		}

		const waitingState: SequentialQueueState = {
			...state,
			activeTabId: null
		};
		await this.writeState(waitingState);
		await this.openNext(waitingState);
	}

	private async openNext(state: SequentialQueueState): Promise<void> {
		const next = state.urls[state.nextIndex];
		if (!next) {
			await this.clearState();
			return;
		}

		const sourceTab = await this.getTab(state.sourceTabId);
		if (!sourceTab || sourceTab.id === undefined) {
			await this.clearState();
			return;
		}

		let tab: QueueTabInfo;
		try {
			tab = await this.tabs.create({
				url: next.url,
				active: false,
				windowId: sourceTab.windowId,
				index: sourceTab.index + 1,
				openerTabId: sourceTab.id
			});
		} catch (error) {
			await this.clearState();
			throw error;
		}

		if (tab.id === undefined) {
			await this.clearState();
			return;
		}

		await this.writeState({
			...state,
			windowId: sourceTab.windowId,
			nextIndex: state.nextIndex + 1,
			activeTabId: tab.id
		});
	}

	private async getTab(tabId: number): Promise<QueueTabInfo | null> {
		try {
			return await this.tabs.get(tabId);
		} catch {
			return null;
		}
	}

	private async readState(): Promise<SequentialQueueState | null> {
		if (this.cachedState !== undefined) {
			return this.cachedState;
		}

		const stored = await this.storage.get(SEQUENTIAL_QUEUE_STORAGE_KEY);
		const candidate = stored[SEQUENTIAL_QUEUE_STORAGE_KEY];
		this.cachedState = isQueueState(candidate) ? candidate : null;
		return this.cachedState;
	}

	private async writeState(state: SequentialQueueState): Promise<void> {
		// Update memory before awaiting storage so a concurrent event in this worker sees
		// the newest activeTabId. The serialized operation chain handles event ordering.
		this.cachedState = state;
		await this.storage.set({ [SEQUENTIAL_QUEUE_STORAGE_KEY]: state });
	}

	private async clearState(): Promise<void> {
		this.cachedState = null;
		await this.storage.remove(SEQUENTIAL_QUEUE_STORAGE_KEY);
	}
}

function normalizeQueueUrls(urls: readonly SequentialQueueUrl[], blockDuplicates: boolean): SequentialQueueUrl[] {
	const result: SequentialQueueUrl[] = [];
	const seen = new Set<string>();

	for (const item of urls) {
		if (!isQueueUrl(item)) {
			continue;
		}
		const url = item.url.trim();
		if (blockDuplicates && seen.has(url)) {
			continue;
		}
		seen.add(url);
		result.push({ url, title: item.title.trim() || url });
	}

	return result;
}

/** Production singleton; event listeners are registered synchronously from background main(). */
export const sequentialQueueManager = new SequentialQueueManager(
	browser.tabs as unknown as QueueTabsAdapter,
	browser.storage.local as unknown as QueueStorageAdapter
);
