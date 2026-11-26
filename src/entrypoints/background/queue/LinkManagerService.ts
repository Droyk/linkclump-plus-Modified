import { browser } from "wxt/browser";
import {
	LAZY_TAB_ENTRY_PREFIX,
	LAZY_TAB_ID_PREFIX
} from "@/assets/js/constants/lazyTab";
import type {
	LinkManagerAddLinksRequest,
	LinkManagerItem,
	LinkManagerList,
	LinkManagerQueueMode,
	LinkManagerQueueStatus,
	LinkManagerReadStatus,
	LinkManagerState,
	LinkManagerTabDuplicate,
	LinkManagerViewMode
} from "@/assets/js/types/LinkManager";
import {
	isBatchDrained,
	planQueueWork,
	type QueuePolicyItem,
	type QueuePolicyState,
	type QueuePolicyTrigger
} from "./LinkManagerQueuePolicy";
import type { PendingLazyTab } from "@/assets/js/types/LazyTab";

export const LINK_MANAGER_STORAGE_KEY = "linkclumpManagerState" as const;
const DEFAULT_BATCH_SIZE = 4;
const MAX_BATCH_SIZE = 50;
const QUEUE_MODES: readonly LinkManagerQueueMode[] = [ "refill", "batch", "manual", "sequential" ];

export interface LinkManagerTabInfo {
	readonly id?: number;
	readonly index: number;
	readonly windowId: number;
	readonly url?: string;
	readonly title?: string;
	readonly active?: boolean;
}

export interface LinkManagerTabsAdapter {
	get(tabId: number): Promise<LinkManagerTabInfo>;
	query(): Promise<LinkManagerTabInfo[]>;
	create(properties: {
		url: string;
		active: false;
		windowId?: number;
		index?: number;
	}): Promise<LinkManagerTabInfo>;
	update(tabId: number, properties: { active?: boolean; url?: string }): Promise<LinkManagerTabInfo>;
	remove(tabIds: number | number[]): Promise<void>;
	onActivated: {
		addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
	};
	onRemoved: {
		addListener(listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
	};
	onUpdated: {
		addListener(listener: (tabId: number, changeInfo: { url?: string }, tab: LinkManagerTabInfo) => void): void;
	};
}

export interface LinkManagerStorageAdapter {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

interface ManagerOptions {
	readonly lazyPageUrl: (token: string) => string;
	readonly idFactory?: () => string;
	readonly now?: () => number;
}

function isQueueMode(value: unknown): value is LinkManagerQueueMode {
	return QUEUE_MODES.includes(value as LinkManagerQueueMode);
}

function isState(value: unknown): value is LinkManagerState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return item.version === 1
		&& typeof item.paused === "boolean"
		&& isQueueMode(item.mode)
		&& (item.viewMode === "combined" || item.viewMode === "collections")
		&& Number.isInteger(item.batchSize)
		&& Number(item.batchSize) >= 1
		&& Number(item.batchSize) <= MAX_BATCH_SIZE
		&& typeof item.openOnSingleClick === "boolean"
		&& typeof item.activeListId === "string"
		&& (item.activeBatchId === null || typeof item.activeBatchId === "string")
		&& Number.isInteger(item.nextBatchNumber)
		&& Array.isArray(item.lists)
		&& Array.isArray(item.items);
}


/** URL normalization retains query parameters and fragments because they can identify distinct content. */
export function normalizeManagerUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (![ "http:", "https:", "ftp:", "file:" ].includes(url.protocol)) {
			return null;
		}
		return url.href;
	} catch {
		return null;
	}
}

function createDefaultState(now: number): LinkManagerState {
	const inbox: LinkManagerList = { id: "inbox", name: "Inbox", createdAt: now };
	return {
		version: 1,
		paused: false,
		mode: "refill",
		viewMode: "combined",
		batchSize: DEFAULT_BATCH_SIZE,
		openOnSingleClick: false,
		activeListId: inbox.id,
		activeBatchId: null,
		nextBatchNumber: 1,
		lists: [ inbox ],
		items: []
	};
}

function isActiveQueueStatus(status: LinkManagerQueueStatus): boolean {
	return status === "opening" || status === "staged" || status === "opened" || status === "suspended";
}

/**
 * Owns persisted collections and the browser tabs created from their queue.
 * It never adopts a duplicate tab unless that tab was already Link Manager-owned.
 * State is written before destructive tab operations so MV3 worker suspension cannot
 * accidentally turn a pause-close into a normal queue-advancement event.
 */
export class LinkManagerService {
	private readonly tabs: LinkManagerTabsAdapter;
	private readonly storage: LinkManagerStorageAdapter;
	private readonly lazyPageUrl: (token: string) => string;
	private readonly idFactory: () => string;
	private readonly now: () => number;
	private operationChain: Promise<void> = Promise.resolve();
	private listenerRegistered = false;

	constructor(
		tabs: LinkManagerTabsAdapter,
		storage: LinkManagerStorageAdapter,
		options: ManagerOptions
	) {
		this.tabs = tabs;
		this.storage = storage;
		this.lazyPageUrl = options.lazyPageUrl;
		this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
		this.now = options.now ?? (() => Date.now());
	}

	register(): void {
		if (this.listenerRegistered) {
			return;
		}
		this.listenerRegistered = true;
		this.tabs.onActivated.addListener(({ tabId }) => {
			void this.serialize(() => this.handleTabActivated(tabId)).catch(reportManagerError);
		});
		this.tabs.onRemoved.addListener((tabId) => {
			void this.serialize(() => this.handleTabRemoved(tabId)).catch(reportManagerError);
		});
		this.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.url !== undefined) {
				void this.serialize(() => this.handleTabUpdated(tabId, changeInfo.url!, tab)).catch(reportManagerError);
			}
		});
	}

	getState(): Promise<LinkManagerState> {
		return this.serialize(async () => structuredClone(await this.readState()));
	}

	inspectDuplicates(urls: readonly { url: string; title: string }[]): Promise<Record<string, LinkManagerTabDuplicate[]>> {
		return this.serialize(async () => {
			const tabs = await this.tabs.query();
			const state = await this.readState();
			const managedIds = new Set(state.items
				.filter((item) => item.managed && item.tabId !== null)
				.map((item) => item.tabId!));
			const result: Record<string, LinkManagerTabDuplicate[]> = {};

			for (const entry of urls) {
				if (typeof entry?.url !== "string" || typeof entry.title !== "string") {
					continue;
				}
				const normalized = normalizeManagerUrl(entry.url);
				if (!normalized) {
					continue;
				}
				const matches = tabs.filter((tab) => normalizeManagerUrl(tab.url ?? "") === normalized && tab.id !== undefined);
				if (matches.length > 0) {
					result[normalized] = matches.map((tab) => ({
						id: tab.id!,
						title: tab.title || tab.url || normalized,
						url: tab.url || normalized,
						windowId: tab.windowId,
						active: tab.active === true,
						managed: managedIds.has(tab.id!)
					}));
				}
			}
			return result;
		});
	}

	addList(name: string): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			const cleanName = name.trim().slice(0, 80);
			if (!cleanName) {
				throw new Error("Enter a name for the collection.");
			}
			if (state.lists.some((list) => list.name.toLowerCase() === cleanName.toLowerCase())) {
				throw new Error("A collection with that name already exists.");
			}
			const list: LinkManagerList = { id: this.idFactory(), name: cleanName, createdAt: this.now() };
			const next: LinkManagerState = {
				...state,
				activeListId: list.id,
				lists: [ ...state.lists, list ]
			};
			await this.writeState(next);
			return next;
		});
	}

	setActiveList(listId: string): Promise<LinkManagerState> {
		return this.updateState((state) => {
			if (!state.lists.some((list) => list.id === listId)) {
				throw new Error("Collection not found.");
			}
			return { ...state, activeListId: listId };
		});
	}

	setViewMode(viewMode: LinkManagerViewMode): Promise<LinkManagerState> {
		if (viewMode !== "combined" && viewMode !== "collections") {
			return Promise.reject(new Error("Unsupported sidebar view."));
		}
		return this.updateState((state) => ({ ...state, viewMode }));
	}

	setBatchSize(batchSize: number): Promise<LinkManagerState> {
		if (!Number.isFinite(batchSize)) {
			return Promise.reject(new Error("Batch size must be a finite number."));
		}
		const size = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(batchSize)));
		return this.updateState((state) => ({ ...state, batchSize: size }));
	}

	setOpenOnSingleClick(enabled: boolean): Promise<LinkManagerState> {
		if (typeof enabled !== "boolean") {
			return Promise.reject(new Error("The single-click setting must be true or false."));
		}
		return this.updateState((state) => ({ ...state, openOnSingleClick: enabled }));
	}

	setMode(mode: LinkManagerQueueMode): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			if (!isQueueMode(mode)) {
				throw new Error("Unsupported queue mode.");
			}
			let next: LinkManagerState = { ...state, mode };
			if (mode === "batch" || mode === "sequential") {
				const active = next.items.filter((item) => item.managed && item.tabId !== null && isActiveQueueStatus(item.queueStatus));
				if (active.length > 0) {
					const retainedBatchId = active[0]?.batchId ?? "batch-" + next.nextBatchNumber;
					next = {
						...next,
						activeBatchId: retainedBatchId,
						items: next.items.map((item) => active.some((activeItem) => activeItem.id === item.id)
							? { ...item, batchId: retainedBatchId }
							: item)
					};
				}
			}
			await this.writeState(next);
			if (mode !== "manual") {
				await this.stageQueued(next, "automatic");
			}
			return structuredClone(await this.readState());
		});
	}

	cycleMode(): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			const index = QUEUE_MODES.indexOf(state.mode);
			const mode = QUEUE_MODES[(index + 1) % QUEUE_MODES.length]!;
			let next: LinkManagerState = { ...state, mode };
			if (mode === "batch" || mode === "sequential") {
				const active = next.items.filter((item) => item.managed && item.tabId !== null && isActiveQueueStatus(item.queueStatus));
				if (active.length > 0) {
					const batchId = active[0]?.batchId ?? "batch-" + next.nextBatchNumber;
					next = {
						...next,
						activeBatchId: batchId,
						items: next.items.map((item) => active.some((activeItem) => activeItem.id === item.id)
							? { ...item, batchId }
							: item)
					};
				}
			}
			await this.writeState(next);
			if (mode !== "manual") {
				await this.stageQueued(next, "automatic");
			}
			return structuredClone(await this.readState());
		});
	}

	addLinks(request: LinkManagerAddLinksRequest): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			const listId = request.listId ?? state.activeListId;
			if (!state.lists.some((list) => list.id === listId)) {
				throw new Error("The selected collection no longer exists.");
			}
			const duplicateActions = new Map((request.duplicateActions ?? []).map((action) => [ normalizeManagerUrl(action.url) ?? action.url, action ]));
			const openTabs = await this.tabs.query();
			const nextItems: LinkManagerItem[] = [];
			const seenInput = new Set<string>();
			let nextOrder = state.items.reduce((max, item) => Math.max(max, item.order), -1) + 1;

			for (const raw of request.urls) {
				if (typeof raw?.url !== "string" || typeof raw.title !== "string") {
					continue;
				}
				const normalized = normalizeManagerUrl(raw.url);
				if (!normalized || seenInput.has(normalized)) {
					continue;
				}
				seenInput.add(normalized);
				const title = raw.title.trim().slice(0, 300) || normalized;
				const matches = openTabs.filter((tab) => normalizeManagerUrl(tab.url ?? "") === normalized && tab.id !== undefined);
				const decision = duplicateActions.get(normalized);

				let externalTab: LinkManagerTabInfo | undefined;
				if (matches.length > 0) {
					if (!decision) {
						throw new Error("A matching browser tab appeared. Review the duplicate-tab prompt and try again.");
					}
					externalTab = matches.find((tab) => tab.id === decision.tabId);
					if (!externalTab) {
						throw new Error("The selected duplicate tab is no longer open. Review duplicates again.");
					}
					if (decision.action === "activate") {
						await this.tabs.update(decision.tabId, { active: true });
					} else {
						await this.tabs.remove(decision.tabId);
						externalTab = undefined;
					}
				}

				const item: LinkManagerItem = {
					id: this.idFactory(),
					listId,
					url: normalized,
					title,
					order: nextOrder++,
					batchId: null,
					readStatus: externalTab ? "viewed" : "unread",
					queueStatus: externalTab ? "external" : "queued",
					tabKind: externalTab ? "external" : null,
					tabId: externalTab?.id ?? null,
					managed: false,
					addedAt: this.now(),
					viewedAt: externalTab ? this.now() : null
				};
				nextItems.push(item);
			}

			if (nextItems.length === 0) {
				throw new Error("No valid HTTP, HTTPS, FTP, or file URLs were supplied.");
			}

			let next: LinkManagerState = {
				...state,
				items: [ ...state.items, ...nextItems ]
			};
			await this.writeState(next);
			if (next.mode !== "manual") {
				await this.stageQueued(next, "automatic");
				next = await this.readState();
			}
			return structuredClone(next);
		});
	}

	stageNext(): Promise<LinkManagerState> {
		return this.serialize(async () => {
			let state = await this.readState();
			await this.stageQueued(state, "manual");
			state = await this.readState();
			return structuredClone(state);
		});
	}

	togglePause(): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			if (state.paused) {
				return this.resume(state);
			}
			const tabIds = state.items
				.filter((item) => item.managed && item.tabId !== null)
				.map((item) => item.tabId!);
			const pausedState: LinkManagerState = {
				...state,
				paused: true,
				items: state.items.map((item) => item.managed && item.tabId !== null
					? { ...item, queueStatus: "suspended" }
					: item)
			};
			// Persist pause intent before tabs.remove(). Keep IDs until removal is confirmed so
			// recovery can close any tabs left behind if the worker is terminated mid-pause.
			await this.writeState(pausedState);
			if (tabIds.length > 0) {
				await this.tabs.remove(tabIds).catch(() => undefined);
			}
			const remaining = await this.tabs.query();
			const remainingIds = new Set(remaining.filter((tab) => tab.id !== undefined).map((tab) => tab.id!));
			const reconciled: LinkManagerState = {
				...pausedState,
				items: pausedState.items.map((item) => item.managed && item.tabId !== null && !remainingIds.has(item.tabId)
					? { ...item, tabId: null }
					: item)
			};
			await this.writeState(reconciled);
			return structuredClone(reconciled);
		});
	}

	setReadStatus(itemId: string, readStatus: LinkManagerReadStatus): Promise<LinkManagerState> {
		if (readStatus !== "unread" && readStatus !== "viewed" && readStatus !== "read") {
			return Promise.reject(new Error("Unsupported reading status."));
		}
		return this.updateState((state) => ({
			...state,
			items: state.items.map((item) => item.id === itemId ? { ...item, readStatus } : item)
		}));
	}

	removeItem(itemId: string): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			const item = state.items.find((candidate) => candidate.id === itemId);
			if (!item) {
				return structuredClone(state);
			}
			// Removing an owned live item also closes its browser tab so Pause cannot
			// later lose track of a tab that the manager no longer lists.
			const next: LinkManagerState = {
				...state,
				items: state.items.filter((candidate) => candidate.id !== itemId)
			};
			await this.writeState(next);
			if (item.managed && item.tabId !== null) {
				await this.tabs.remove(item.tabId).catch(reportManagerError);
			}
			if (!next.paused && next.mode !== "manual") {
				await this.stageQueued(next, "automatic");
			}
			return structuredClone(await this.readState());
		});
	}

	openItem(itemId: string): Promise<LinkManagerState> {
		return this.serialize(async () => {
			let state = await this.readState();
			const item = state.items.find((candidate) => candidate.id === itemId);
			if (!item) {
				throw new Error("Link not found.");
			}
			if (state.paused) {
				throw new Error("Resume Link Manager before opening links.");
			}
			if (item.tabId !== null) {
				await this.tabs.update(item.tabId, { active: true });
				return structuredClone(await this.readState());
			}
			state = {
				...state,
				items: state.items.map((candidate) => candidate.id === itemId
					? { ...candidate, queueStatus: "queued", managed: true, tabKind: "destination", tabToken: undefined }
					: candidate)
			};
			await this.writeState(state);
			await this.stageQueued(state, state.mode === "manual" ? "manual" : "automatic");
			return structuredClone(await this.readState());
		});
	}

	recover(): Promise<void> {
		return this.serialize(async () => {
			let state = await this.readState();
			const allTabs = await this.tabs.query();
			const byId = new Map(allTabs.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));

			if (state.paused) {
				const tokenSet = new Set(state.items
					.filter((item) => item.managed && item.tabToken)
					.map((item) => item.tabToken!));
				const staleIds = new Set(state.items
					.filter((item) => item.managed && item.tabId !== null)
					.map((item) => item.tabId!));
				for (const tab of allTabs) {
					if (tab.id !== undefined && getLazyToken(tab.url) && tokenSet.has(getLazyToken(tab.url)!)) {
						staleIds.add(tab.id);
					}
				}
				if (staleIds.size > 0) {
					await this.tabs.remove([ ...staleIds ]).catch(() => undefined);
				}
				const remaining = await this.tabs.query();
				const remainingIds = new Set(remaining.filter((tab) => tab.id !== undefined).map((tab) => tab.id!));
				state = {
					...state,
					items: state.items.map((item) => item.managed && item.tabId !== null && !remainingIds.has(item.tabId)
						? { ...item, tabId: null }
						: item)
				};
				await this.writeState(state);
				return;
			}

			let changed = false;
			const items = state.items.map((item) => {
				if (!item.managed) {
					return item;
				}

				if (item.tabId === null && item.tabToken) {
					const recoveredTab = allTabs.find((tab) => getLazyToken(tab.url) === item.tabToken);
					if (recoveredTab?.id !== undefined) {
						changed = true;
						return {
							...item,
							tabId: recoveredTab.id,
							queueStatus: "staged" as const
						};
					}
				}

				if (item.tabId === null && item.queueStatus === "opening") {
					changed = true;
					return { ...item, queueStatus: "queued" as const, tabKind: null, tabToken: undefined };
				}
				if (item.tabId === null || !isActiveQueueStatus(item.queueStatus)) {
					return item;
				}

				const tab = byId.get(item.tabId);
				if (!tab) {
					changed = true;
					return { ...item, tabId: null, queueStatus: "closed" as const, tabKind: null, tabToken: undefined };
				}
				if (item.tabKind === "placeholder" && normalizeManagerUrl(tab.url ?? "") === normalizeManagerUrl(item.url)) {
					changed = true;
					return { ...item, tabKind: "destination" as const, queueStatus: "opened" as const, tabToken: undefined };
				}
				return item;
			});
			state = { ...state, items };
			if (changed) {
				await this.writeState(state);
			}
			if (state.mode !== "manual") {
				await this.stageQueued(state, "automatic");
			}
		});
	}

	private async resume(state: LinkManagerState): Promise<LinkManagerState> {
		const restoreItems = state.items
			.filter((item) => item.managed && item.queueStatus === "suspended" && item.tabId === null)
			.sort((a, b) => a.order - b.order);
		let windowId: number | undefined;
		try {
			const activeTabs = await this.tabs.query();
			windowId = activeTabs.find((tab) => tab.active)?.windowId;
		} catch {
			windowId = undefined;
		}

		let next: LinkManagerState = {
			...state,
			paused: false,
			items: state.items.map((item) => {
				if (!restoreItems.some((restore) => restore.id === item.id)) {
					return item;
				}
				return {
					...item,
					tabId: null,
					queueStatus: "opening",
					tabToken: item.tabKind === "placeholder" ? this.idFactory() : undefined
				};
			})
		};
		await this.writeState(next);

		for (const restoreItem of restoreItems) {
			const item = next.items.find((candidate) => candidate.id === restoreItem.id);
			if (!item) {
				continue;
			}
			try {
				const tab = item.tabKind === "placeholder"
					? await this.createPlaceholder(item, windowId, item.tabToken)
					: await this.tabs.create({ url: item.url, active: false, windowId });
				const createdTabId = tab.id;
				if (createdTabId === undefined) {
					throw new Error("The browser did not return a tab ID.");
				}
				next = {
					...next,
					items: next.items.map((candidate) => candidate.id === item.id
						? {
							...candidate,
							tabId: createdTabId,
							queueStatus: candidate.tabKind === "placeholder" ? "staged" : "opened"
						}
						: candidate)
				};
				await this.writeState(next);
			} catch (error) {
				next = {
					...next,
					items: next.items.map((candidate) => candidate.id === item.id
						? { ...candidate, queueStatus: "queued", tabId: null, tabToken: undefined }
						: candidate)
				};
				await this.writeState(next);
				reportManagerError(error);
			}
		}

		if (next.mode !== "manual") {
			await this.stageQueued(next, "automatic");
		}
		return structuredClone(await this.readState());
	}

	private async stageQueued(state: LinkManagerState, trigger: QueuePolicyTrigger): Promise<void> {
		if (state.paused) {
			return;
		}
		const queueItems = state.items
			.filter((item) => item.queueStatus === "queued")
			.sort((a, b) => a.order - b.order);
		const policyItems: QueuePolicyItem[] = state.items.map((item) => ({
			id: item.id,
			batchId: item.batchId,
			queueStatus: item.queueStatus,
			managed: item.managed
		}));
		const policyState: QueuePolicyState = {
			mode: state.mode,
			paused: state.paused,
			batchSize: state.batchSize,
			activeBatchId: state.activeBatchId,
			nextBatchNumber: state.nextBatchNumber,
			items: policyItems
		};
		const plan = planQueueWork(policyState, queueItems.map((item) => item.id), trigger);
		if (!plan) {
			return;
		}

		let next: LinkManagerState = {
			...state,
			activeBatchId: plan.batchId,
			nextBatchNumber: plan.nextBatchNumber,
			items: state.items.map((item) => plan.itemIds.includes(item.id)
				? {
					...item,
					batchId: plan.batchId,
					queueStatus: "opening",
					tabKind: plan.tabKind,
					managed: true,
					tabToken: plan.tabKind === "placeholder" ? this.idFactory() : undefined
				}
				: item)
		};
		await this.writeState(next);

		const activeTab = (await this.tabs.query()).find((tab) => tab.active);
		// Omit index so newly created managed tabs are appended instead of reusing the
		// position of a duplicate tab the user explicitly chose to replace.
		const windowId = activeTab?.windowId;

		for (const itemId of plan.itemIds) {
			const item = next.items.find((candidate) => candidate.id === itemId);
			if (!item) {
				continue;
			}
			try {
				const tab = plan.tabKind === "placeholder"
					? await this.createPlaceholder(item, windowId, item.tabToken)
					: await this.tabs.create({ url: item.url, active: false, windowId });
				const createdTabId = tab.id;
				if (createdTabId === undefined) {
					throw new Error("The browser did not return a tab ID.");
				}
				next = {
					...next,
					items: next.items.map((candidate) => candidate.id === itemId
						? { ...candidate, tabId: createdTabId, queueStatus: plan.tabKind === "placeholder" ? "staged" : "opened" }
						: candidate)
				};
				await this.writeState(next);
			} catch (error) {
				next = {
					...next,
					items: next.items.map((candidate) => candidate.id === itemId
						? { ...candidate, tabId: null, queueStatus: "queued", tabKind: null, tabToken: undefined, managed: false }
						: candidate)
				};
				await this.writeState(next);
				reportManagerError(error);
			}
		}
	}

	private async createPlaceholder(
		item: Pick<LinkManagerItem, "url" | "title" | "tabToken">,
		windowId?: number,
		token = item.tabToken ?? this.idFactory()
	): Promise<LinkManagerTabInfo> {
		const entryKey = LAZY_TAB_ENTRY_PREFIX + token;
		const pending: PendingLazyTab = { token, url: item.url, title: item.title, tabId: null };
		await this.storage.set({ [entryKey]: pending });
		try {
			const tab = await this.tabs.create({
				url: this.lazyPageUrl(token),
				active: false,
				windowId
			});
			if (tab.id === undefined) {
				throw new Error("The browser did not return a tab ID.");
			}
			await this.storage.set({
				[entryKey]: { ...pending, tabId: tab.id },
				[LAZY_TAB_ID_PREFIX + tab.id]: token
			});
			return tab;
		} catch (error) {
			await this.storage.remove(entryKey);
			throw error;
		}
	}

	private async handleTabActivated(tabId: number): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item || item.readStatus === "read") {
			return;
		}
		const updated: LinkManagerItem = {
			...item,
			readStatus: "viewed",
			viewedAt: item.viewedAt ?? this.now()
		};
		await this.writeState({
			...state,
			items: state.items.map((candidate) => candidate.id === item.id ? updated : candidate)
		});
	}

	private async handleTabUpdated(tabId: number, url: string, tab: LinkManagerTabInfo): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId && candidate.managed);
		if (!item) {
			return;
		}
		if (item.tabKind === "placeholder" && normalizeManagerUrl(url) === normalizeManagerUrl(item.url)) {
			await this.writeState({
				...state,
				items: state.items.map((candidate) => candidate.id === item.id
					? { ...candidate, tabKind: "destination", tabToken: undefined, queueStatus: "opened", title: tab.title || candidate.title }
					: candidate)
			});
		}
	}

	private async handleTabRemoved(tabId: number): Promise<void> {
		let state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item) {
			return;
		}
		state = {
			...state,
			items: state.items.map((candidate) => candidate.id === item.id
				? (state.paused
					? { ...candidate, tabId: null, queueStatus: "suspended" }
					: { ...candidate, tabId: null, tabKind: null, tabToken: undefined, queueStatus: "closed" })
				: candidate)
		};
		if (state.paused) {
			await this.writeState(state);
			return;
		}
		if (item.managed) {
			if ((state.mode === "batch" || state.mode === "sequential")
				&& isBatchDrained(state.items as readonly QueuePolicyItem[], state.activeBatchId)) {
				state = { ...state, activeBatchId: null };
			}
		}
		await this.writeState(state);
		if (item.managed && state.mode !== "manual") {
			await this.stageQueued(state, "automatic");
		}
	}

	private updateState(transform: (state: LinkManagerState) => LinkManagerState): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const next = transform(await this.readState());
			await this.writeState(next);
			return structuredClone(next);
		});
	}

	private async readState(): Promise<LinkManagerState> {
		const stored = await this.storage.get(LINK_MANAGER_STORAGE_KEY);
		const value = stored[LINK_MANAGER_STORAGE_KEY];
		if (isState(value)) {
			return value;
		}
		const state = createDefaultState(this.now());
		await this.writeState(state);
		return state;
	}

	private writeState(state: LinkManagerState): Promise<void> {
		return this.storage.set({ [LINK_MANAGER_STORAGE_KEY]: state });
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationChain.then(operation, operation);
		this.operationChain = result.then(() => undefined, () => undefined);
		return result;
	}
}

function reportManagerError(error: unknown): void {
	console.error("[LinkManager] Operation failed:", error);
}

export const linkManagerService = new LinkManagerService(
	browser.tabs as unknown as LinkManagerTabsAdapter,
	browser.storage.local as unknown as LinkManagerStorageAdapter,
	{
		lazyPageUrl: (token) => browser.runtime.getURL(`/lazyTab.html?token=${encodeURIComponent(token)}`)
	}
);


function getLazyToken(url: string | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).searchParams.get("token");
	} catch {
		return null;
	}
}
