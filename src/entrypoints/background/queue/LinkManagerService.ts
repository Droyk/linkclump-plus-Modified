import { browser } from "wxt/browser";
import type {
	LinkManagerAddLinksRequest,
	LinkManagerDuplicateAction,
	LinkManagerItem,
	LinkManagerList,
	LinkManagerOwnership,
	LinkManagerReadStatus,
	LinkManagerSessionPreferences,
	LinkManagerState,
	LinkManagerTabDuplicate,
	LinkManagerViewMode,
	LinkManagerWindowPolicy
} from "@/assets/js/types/LinkManager";

export const LINK_MANAGER_STORAGE_KEY = "linkclumpManagerState" as const;
export const LINK_MANAGER_SESSION_KEY = "linkclumpManagerSession" as const;

const DEFAULT_SESSION_PREFERENCES: LinkManagerSessionPreferences = {
	duplicateResolution: null,
	ownership: null
};

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
	create(properties: { url: string; active: boolean; windowId?: number }): Promise<LinkManagerTabInfo>;
	update(tabId: number, properties: { active?: boolean; url?: string }): Promise<LinkManagerTabInfo>;
	remove(tabIds: number | number[]): Promise<void>;
	onActivated: { addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void };
	onRemoved: { addListener(listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void };
	onUpdated: { addListener(listener: (tabId: number, changeInfo: { url?: string }, tab: LinkManagerTabInfo) => void): void };
	onAttached: { addListener(listener: (tabId: number, attachInfo: { newWindowId: number }) => void): void };
}

export interface LinkManagerWindowsAdapter {
	update(windowId: number, updateInfo: { focused?: boolean }): Promise<unknown>;
}

export interface LinkManagerStorageAdapter {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

interface ManagerOptions {
	readonly windows?: LinkManagerWindowsAdapter;
	readonly sessionStorage?: LinkManagerStorageAdapter;
	readonly idFactory?: () => string;
	readonly now?: () => number;
}

function isOwnership(value: unknown): value is LinkManagerOwnership {
	return value === "managed" || value === "borrowed";
}

function isState(value: unknown): value is LinkManagerState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.version === 3
		&& Array.isArray(candidate.pausedWindowIds)
		&& (candidate.viewMode === "combined" || candidate.viewMode === "collections")
		&& typeof candidate.openOnSingleClick === "boolean"
		&& isOwnership(candidate.defaultOwnership)
		&& (candidate.windowPolicy === "current-window" || candidate.windowPolicy === "follow")
		&& typeof candidate.activeListId === "string"
		&& Array.isArray(candidate.lists)
		&& Array.isArray(candidate.items);
}

/** Normalize exact navigable URLs; query strings and fragments remain significant. */
export function normalizeManagerUrl(value: string): string | null {
	try {
		const parsed = new URL(value.trim());
		if (![ "http:", "https:", "ftp:", "file:" ].includes(parsed.protocol)) {
			return null;
		}
		return parsed.href;
	} catch {
		return null;
	}
}

function createDefaultState(now: number): LinkManagerState {
	const inbox: LinkManagerList = { id: "inbox", name: "Inbox", createdAt: now };
	return {
		version: 3,
		pausedWindowIds: [],
		viewMode: "combined",
		openOnSingleClick: false,
		defaultOwnership: "borrowed",
		windowPolicy: "current-window",
		activeListId: inbox.id,
		lists: [ inbox ],
		items: []
	};
}

function sortByOrder(items: readonly LinkManagerItem[]): LinkManagerItem[] {
	return [ ...items ].sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);
}

function isWindowPaused(state: LinkManagerState, windowId: number): boolean {
	return state.pausedWindowIds.includes(windowId);
}

function migrateVersionTwoState(value: unknown): LinkManagerState | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 2
		|| typeof candidate.paused !== "boolean"
		|| !Array.isArray(candidate.lists)
		|| !Array.isArray(candidate.items)
		|| typeof candidate.activeListId !== "string"
		|| (candidate.viewMode !== "combined" && candidate.viewMode !== "collections")
		|| typeof candidate.openOnSingleClick !== "boolean"
		|| !isOwnership(candidate.defaultOwnership)
		|| (candidate.windowPolicy !== "current-window" && candidate.windowPolicy !== "follow")) {
		return null;
	}
	const lists = candidate.lists as LinkManagerList[];
	const items = candidate.items as LinkManagerItem[];
	const pausedWindowIds = candidate.paused
		? [ ...new Set(items.map((item) => item.queueWindowId).filter(Number.isInteger)) ]
		: [];
	return {
		version: 3,
		pausedWindowIds,
		viewMode: candidate.viewMode,
		openOnSingleClick: candidate.openOnSingleClick,
		defaultOwnership: candidate.defaultOwnership,
		windowPolicy: candidate.windowPolicy,
		activeListId: candidate.activeListId,
		lists,
		items
	};
}

/**
 * The Link Manager owns one direct-URL queue per originating browser window.
 * It never creates placeholders. Managed tabs may be closed on Pause/removal;
 * Borrowed tabs are tracked and activated but are never closed by the manager.
 */
export class LinkManagerService {
	private readonly tabs: LinkManagerTabsAdapter;
	private readonly storage: LinkManagerStorageAdapter;
	private readonly windows?: LinkManagerWindowsAdapter;
	private readonly sessionStorage?: LinkManagerStorageAdapter;
	private readonly idFactory: () => string;
	private readonly now: () => number;
	private operationChain: Promise<void> = Promise.resolve();
	private listenerRegistered = false;
	private readonly activeTabByWindow = new Map<number, number>();

	constructor(
		tabs: LinkManagerTabsAdapter,
		storage: LinkManagerStorageAdapter,
		options: ManagerOptions = {}
	) {
		this.tabs = tabs;
		this.storage = storage;
		this.windows = options.windows;
		this.sessionStorage = options.sessionStorage;
		this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
		this.now = options.now ?? (() => Date.now());
	}

	register(): void {
		if (this.listenerRegistered) {
			return;
		}
		this.listenerRegistered = true;
		this.tabs.onActivated.addListener(({ tabId, windowId }) => {
			const previousTabId = this.activeTabByWindow.get(windowId);
			this.activeTabByWindow.set(windowId, tabId);
			void this.serialize(async () => {
				// A tab-close can dispatch onActivated before onRemoved. Confirm that the
				// previous tab disappeared; an ordinary switch-away must not advance.
				if (previousTabId !== undefined && previousTabId !== tabId) {
					try {
						await this.tabs.get(previousTabId);
					} catch {
						await this.handleTabRemoved(previousTabId, {
							windowId,
							isWindowClosing: false
						}, true);
					}
				}
				await this.handleTabActivated(tabId);
			}).catch(reportManagerError);
		});
		this.tabs.onRemoved.addListener((tabId, removeInfo) => {
			void this.serialize(() => this.handleTabRemoved(tabId, removeInfo)).catch(reportManagerError);
		});
		this.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.url !== undefined || tab.title !== undefined) {
				void this.serialize(() => this.handleTabUpdated(tabId, changeInfo.url, tab)).catch(reportManagerError);
			}
		});
		this.tabs.onAttached.addListener((tabId, attachInfo) => {
			void this.serialize(() => this.handleTabAttached(tabId, attachInfo.newWindowId)).catch(reportManagerError);
		});
	}

	getState(): Promise<LinkManagerState> {
		return this.serialize(async () => structuredClone(await this.readState()));
	}

	getSessionPreferences(): Promise<LinkManagerSessionPreferences> {
		return this.serialize(() => this.readSessionPreferences());
	}

	inspectDuplicates(
		urls: readonly { readonly url: string; readonly title: string }[],
		queueWindowId: number
	): Promise<{
		duplicates: Record<string, LinkManagerTabDuplicate[]>;
		sessionPreferences: LinkManagerSessionPreferences;
	}> {
		return this.serialize(async () => {
			const state = await this.readState();
			const tabs = await this.tabs.query();
			const trackedIds = new Set(state.items.filter((item) => item.tabId !== null).map((item) => item.tabId!));
			const managedIds = new Set(state.items
				.filter((item) => item.ownership === "managed" && item.tabId !== null)
				.map((item) => item.tabId!));
			const duplicates: Record<string, LinkManagerTabDuplicate[]> = {};

			for (const entry of urls) {
				const normalized = normalizeManagerUrl(entry.url);
				if (!normalized) {
					continue;
				}
				const matches = tabs.filter((tab) =>
					tab.id !== undefined
					&& normalizeManagerUrl(tab.url ?? "") === normalized
					&& (state.windowPolicy === "follow" || tab.windowId === queueWindowId)
				);
				if (matches.length > 0) {
					duplicates[normalized] = matches.map((tab) => ({
						id: tab.id!,
						title: tab.title || tab.url || normalized,
						url: tab.url || normalized,
						windowId: tab.windowId,
						index: tab.index,
						active: tab.active === true,
						managed: managedIds.has(tab.id!),
						tracked: trackedIds.has(tab.id!)
					}));
				}
			}
			return { duplicates, sessionPreferences: await this.readSessionPreferences() };
		});
	}


	saveSelection(
		urls: readonly { readonly url: string; readonly title: string }[],
		queueWindowId: number | undefined
	): Promise<LinkManagerState> {
		return this.serialize(async () => {
			if (queueWindowId === undefined || !Number.isInteger(queueWindowId) || queueWindowId < 0) {
				throw new Error("The source browser window could not be identified.");
			}
			const state = await this.readState();
			const listId = state.activeListId;
			let order = state.items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
			const addedAt = this.now();
			const added: LinkManagerItem[] = [];
			for (const entry of urls) {
				const normalized = normalizeManagerUrl(entry.url);
				if (!normalized || typeof entry.title !== "string") {
					continue;
				}
				added.push({
					id: this.idFactory(),
					listId,
					url: normalized,
					title: entry.title.trim().slice(0, 300) || normalized,
					order: order++,
					queueWindowId,
					status: "queued",
					tabId: null,
					tabWindowId: null,
					ownership: null,
					readStatus: "unread",
					addedAt,
					openedAt: null,
					resumeOnResume: false
				});
			}
			if (added.length === 0) {
				throw new Error("The selection contains no valid navigable URLs.");
			}
			const next = { ...state, items: [ ...state.items, ...added ] };
			await this.writeState(next);
			return structuredClone(next);
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
			const next = { ...state, activeListId: list.id, lists: [ ...state.lists, list ] };
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

	setOpenOnSingleClick(enabled: boolean): Promise<LinkManagerState> {
		if (typeof enabled !== "boolean") {
			return Promise.reject(new Error("The single-click setting must be true or false."));
		}
		return this.updateState((state) => ({ ...state, openOnSingleClick: enabled }));
	}

	setDefaultOwnership(ownership: LinkManagerOwnership): Promise<LinkManagerState> {
		if (!isOwnership(ownership)) {
			return Promise.reject(new Error("Unsupported tab ownership setting."));
		}
		return this.updateState((state) => ({ ...state, defaultOwnership: ownership }));
	}

	setWindowPolicy(policy: LinkManagerWindowPolicy): Promise<LinkManagerState> {
		if (policy !== "current-window" && policy !== "follow") {
			return Promise.reject(new Error("Unsupported window policy."));
		}
		return this.serialize(async () => {
			const state = await this.readState();
			if (policy === "current-window") {
				const next = {
					...state,
					windowPolicy: policy,
					items: state.items.map((item) => item.tabId !== null
						&& item.tabWindowId !== item.queueWindowId
						? { ...item, status: "closed" as const, tabId: null, tabWindowId: null, ownership: null }
						: item)
				};
				await this.writeState(next);
				return structuredClone(next);
			}
			const next = { ...state, windowPolicy: policy };
			await this.writeState(next);
			return structuredClone(next);
		});
	}

	addLinks(request: LinkManagerAddLinksRequest): Promise<LinkManagerState> {
		return this.serialize(async () => {
			let state = await this.readState();
			const queueWindowId = request.queueWindowId;
			if (!Number.isInteger(queueWindowId) || queueWindowId < 0) {
				throw new Error("A valid originating browser window is required.");
			}
			const listId = request.listId ?? state.activeListId;
			if (!state.lists.some((list) => list.id === listId)) {
				throw new Error("The selected collection no longer exists.");
			}

			const tabs = await this.tabs.query();
			const preferences = await this.readSessionPreferences();
			const openTabIds = new Set(tabs.filter((tab) => tab.id !== undefined).map((tab) => tab.id!));
			const hadOpenQueueItem = state.items.some((item) =>
				item.queueWindowId === queueWindowId
				&& item.status === "open"
				&& item.tabId !== null
				&& openTabIds.has(item.tabId)
			);
			const decisions = new Map((request.duplicateActions ?? [])
				.map((decision) => [ normalizeManagerUrl(decision.url) ?? decision.url, decision ]));
			const added: LinkManagerItem[] = [];
			const seen = new Set<string>();
			let order = state.items.reduce((max, item) => Math.max(max, item.order), -1) + 1;

			for (const raw of request.urls) {
				if (typeof raw?.url !== "string" || typeof raw.title !== "string") {
					continue;
				}
				const normalized = normalizeManagerUrl(raw.url);
				if (!normalized || seen.has(normalized)) {
					continue;
				}
				seen.add(normalized);
				const matches = tabs.filter((tab) =>
					tab.id !== undefined
					&& normalizeManagerUrl(tab.url ?? "") === normalized
					&& (state.windowPolicy === "follow" || tab.windowId === queueWindowId)
				);
				let decision = decisions.get(normalized);

				if (matches.length > 0 && !decision) {
					if (preferences.duplicateResolution === "activate") {
						const match = preferredMatch(matches);
						if (match?.id !== undefined) {
							decision = { url: normalized, action: "activate", activateTabId: match.id, ownership: preferences.ownership ?? state.defaultOwnership };
						}
					} else if (preferences.duplicateResolution === "replace") {
						decision = { url: normalized, action: "replace", closeTabIds: matches.map((tab) => tab.id!).filter(Number.isInteger) };
					} else if (preferences.duplicateResolution === "duplicate") {
						decision = { url: normalized, action: "duplicate" };
					} else {
						throw new Error("A matching browser tab appeared. Review the duplicate-tab prompt and try again.");
					}
				}

				let activateTab: LinkManagerTabInfo | undefined;
				let closeTabIds: number[] = [];
				if (matches.length > 0) {
					if (!decision) {
						throw new Error("A matching browser tab appeared. Review duplicates again.");
					}
					const matchById = new Map(matches.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));
					if (decision.action === "activate" || decision.action === "custom") {
						activateTab = matchById.get(decision.activateTabId);
						if (!activateTab) {
							throw new Error("The selected activation tab is no longer available. Review duplicates again.");
						}
						closeTabIds = [ ...(decision.closeTabIds ?? []) ];
						if (closeTabIds.includes(decision.activateTabId)) {
							throw new Error("A tab cannot be selected for both activation and closure.");
						}
					} else if (decision.action === "replace") {
						closeTabIds = decision.closeTabIds?.length
							? [ ...decision.closeTabIds ]
							: [ ...matchById.keys() ];
					} else {
						closeTabIds = [ ...(decision.closeTabIds ?? []) ];
					}
					for (const id of closeTabIds) {
						if (!matchById.has(id)) {
							throw new Error("A selected duplicate tab is no longer available. Review duplicates again.");
						}
					}
				}

				const selectedTrackedItem = activateTab
					? state.items.find((item) => item.tabId === activateTab!.id)
					: undefined;
				if (selectedTrackedItem && selectedTrackedItem.queueWindowId !== queueWindowId) {
					throw new Error("This tab already belongs to a different window's Link Manager queue.");
				}

				if (closeTabIds.length > 0) {
					const closing = new Set(closeTabIds);
					state = {
						...state,
						items: state.items.map((item) => closing.has(item.tabId ?? -1)
							? { ...item, tabId: null, tabWindowId: null, ownership: null, status: "closed" }
							: item)
					};
					await this.writeState(state);
					await this.tabs.remove(closeTabIds);
				}

				const trackedItem = activateTab
					? state.items.find((item) => item.tabId === activateTab!.id)
					: undefined;
				const reused = activateTab && !trackedItem ? activateTab : undefined;
				if (activateTab && trackedItem) {
					const ownership = decision && (decision.action === "activate" || decision.action === "custom")
						? (decision.ownership ?? preferences.ownership ?? state.defaultOwnership)
						: trackedItem.ownership;
					state = {
						...state,
						items: state.items.map((item) => item.id === trackedItem.id
							? { ...item, ownership }
							: item)
					};
					await this.writeState(state);
					await this.activateTab(activateTab.id!, activateTab.windowId, queueWindowId, state.windowPolicy);
					if (decision?.rememberResolution) {
						await this.saveSessionPreferences({ ...(await this.readSessionPreferences()), duplicateResolution: "activate" });
					}
					if ((decision?.action === "activate" || decision?.action === "custom") && decision.rememberOwnership && ownership) {
						await this.saveSessionPreferences({ ...(await this.readSessionPreferences()), ownership });
					}
					continue;
				}
				const ownership = decision && (decision.action === "activate" || decision.action === "custom")
					? (decision.ownership ?? preferences.ownership ?? state.defaultOwnership)
					: null;
				const item: LinkManagerItem = {
					id: this.idFactory(),
					listId,
					url: normalized,
					title: raw.title.trim().slice(0, 300) || normalized,
					order: order++,
					queueWindowId,
					status: reused ? "open" : "queued",
					tabId: reused?.id ?? null,
					tabWindowId: reused?.windowId ?? null,
					ownership: reused ? ownership : null,
					readStatus: reused?.active ? "read" : "unread",
					addedAt: this.now(),
					openedAt: reused ? this.now() : null,
					resumeOnResume: false
				};
				added.push(item);

				if (decision?.rememberResolution) {
					const duplicateResolution = decision.action === "replace"
						? "replace"
						: decision.action === "duplicate" ? "duplicate" : "activate";
					await this.saveSessionPreferences({ ...preferences, duplicateResolution });
				}
				if ((decision?.action === "activate" || decision?.action === "custom") && decision.rememberOwnership && ownership) {
					await this.saveSessionPreferences({
						...(await this.readSessionPreferences()),
						ownership
					});
				}
			}

			if (added.length === 0) {
				if (seen.size > 0) {
					return structuredClone(state);
				}
				throw new Error("No valid HTTP, HTTPS, FTP, or file URLs were supplied.");
			}
			state = { ...state, items: [ ...state.items, ...added ] };
			await this.writeState(state);
			if (!isWindowPaused(state, queueWindowId)) {
				const hasOpenQueueItem = state.items.some((item) =>
					item.queueWindowId === queueWindowId
					&& item.status === "open"
					&& item.tabId !== null
					&& openTabIds.has(item.tabId)
				);
				if (!hadOpenQueueItem || !hasOpenQueueItem) {
					const firstReused = sortByOrder(added).find((item) => item.status === "open" && item.tabId !== null);
					if (firstReused?.tabId !== null && firstReused?.tabId !== undefined) {
						await this.activateTab(firstReused.tabId, firstReused.tabWindowId ?? queueWindowId, queueWindowId, state.windowPolicy);
					} else if (!hasOpenQueueItem) {
						await this.openNextQueued(queueWindowId);
					}
				}
			}
			return structuredClone(await this.readState());
		});
	}

	openSelected(
		itemIds: readonly string[],
		queueWindowId: number,
		duplicateActions: readonly LinkManagerDuplicateAction[] = []
	): Promise<LinkManagerState> {
		return this.serialize(async () => {
			let state = await this.readState();
			if (isWindowPaused(state, queueWindowId)) {
				throw new Error("Resume this window's Link Manager queue before opening links.");
			}
			const uniqueIds = [ ...new Set(itemIds) ];
			const items = uniqueIds.map((id) => state.items.find((item) => item.id === id))
				.filter((item): item is LinkManagerItem => item !== undefined);
			if (items.length === 0) {
				return structuredClone(state);
			}
			if (items.some((item) => item.queueWindowId !== queueWindowId)) {
				throw new Error("Select links from one browser window at a time.");
			}

			let liveTabs = await this.tabs.query();
			const preferences = await this.readSessionPreferences();
			const decisions = new Map(duplicateActions.map((decision) => [
				normalizeManagerUrl(decision.url) ?? decision.url,
				decision
			]));
			let first = true;

			for (const original of items) {
				let item = state.items.find((candidate) => candidate.id === original.id)!;
				let tab = item.tabId === null ? undefined : liveTabs.find((candidate) => candidate.id === item.tabId);
				let ownership = item.ownership;
				if (!tab) {
					const matches = liveTabs.filter((candidate) =>
						candidate.id !== undefined
						&& normalizeManagerUrl(candidate.url ?? "") === item.url
						&& this.isEligibleWindow(candidate.windowId, queueWindowId, state.windowPolicy)
						&& !state.items.some((known) => known.id !== item.id && known.tabId === candidate.id)
					);
					let decision = decisions.get(item.url);

					if (matches.length > 0 && !decision) {
						if (preferences.duplicateResolution === "activate") {
							const preferred = preferredMatch(matches);
							if (preferred?.id !== undefined) {
								decision = {
									url: item.url,
									action: "activate",
									activateTabId: preferred.id,
									ownership: preferences.ownership ?? state.defaultOwnership
								};
							}
						} else if (preferences.duplicateResolution === "replace") {
							decision = { url: item.url, action: "replace", closeTabIds: matches.map((match) => match.id!).filter(Number.isInteger) };
						} else if (preferences.duplicateResolution === "duplicate") {
							decision = { url: item.url, action: "duplicate" };
						} else {
							throw new Error("A matching browser tab appeared. Review the duplicate-tab prompt and try again.");
						}
					}

					let closeTabIds: number[] = [];
					if (matches.length > 0) {
						if (!decision) {
							throw new Error("A matching browser tab appeared. Review duplicates again.");
						}
						const byId = new Map(matches.filter((candidate) => candidate.id !== undefined)
							.map((candidate) => [ candidate.id!, candidate ]));
						if (decision.action === "activate" || decision.action === "custom") {
							tab = byId.get(decision.activateTabId);
							if (!tab) {
								throw new Error("The selected activation tab is no longer available. Review duplicates again.");
							}
							closeTabIds = [ ...(decision.closeTabIds ?? []) ];
							if (closeTabIds.includes(decision.activateTabId)) {
								throw new Error("A tab cannot be selected for both activation and closure.");
							}
							ownership = decision.ownership ?? preferences.ownership ?? state.defaultOwnership;
						} else if (decision.action === "replace") {
							closeTabIds = decision.closeTabIds?.length
								? [ ...decision.closeTabIds ]
								: [ ...byId.keys() ];
							tab = undefined;
						} else {
							closeTabIds = [ ...(decision.closeTabIds ?? []) ];
							tab = undefined;
						}
						if (closeTabIds.some((id) => !byId.has(id))) {
							throw new Error("A selected duplicate tab is no longer available. Review duplicates again.");
						}
					}

					if (closeTabIds.length > 0) {
						const closing = new Set(closeTabIds);
						state = {
							...state,
							items: state.items.map((candidate) => closing.has(candidate.tabId ?? -1)
								? { ...candidate, status: "closed", tabId: null, tabWindowId: null, ownership: null, resumeOnResume: false }
								: candidate)
						};
						await this.writeState(state);
						await this.tabs.remove(closeTabIds);
						liveTabs = liveTabs.filter((candidate) => !closing.has(candidate.id ?? -1));
					}

					if (decision?.rememberResolution) {
						const duplicateResolution = decision.action === "replace"
							? "replace"
							: decision.action === "duplicate" ? "duplicate" : "activate";
						await this.saveSessionPreferences({ ...(await this.readSessionPreferences()), duplicateResolution });
					}
					if ((decision?.action === "activate" || decision?.action === "custom")
						&& decision.rememberOwnership && ownership) {
						await this.saveSessionPreferences({ ...(await this.readSessionPreferences()), ownership });
					}
				}

				if (tab?.id !== undefined) {
					if (first) {
						await this.activateTab(tab.id, tab.windowId, queueWindowId, state.windowPolicy);
					}
					item = {
						...item,
						status: "open",
						tabId: tab.id,
						tabWindowId: tab.windowId,
						ownership: item.tabId === tab.id ? item.ownership : ownership ?? state.defaultOwnership,
						readStatus: first ? "read" : item.readStatus,
						openedAt: item.openedAt ?? this.now(),
						resumeOnResume: false
					};
				} else {
					const created = await this.tabs.create({
						url: item.url,
						active: first,
						windowId: queueWindowId
					});
					if (created.id === undefined) {
						throw new Error("The browser did not return a tab ID.");
					}
					item = {
						...item,
						status: "open",
						tabId: created.id,
						tabWindowId: created.windowId,
						ownership: "managed",
						readStatus: first ? "read" : item.readStatus,
						openedAt: this.now(),
						resumeOnResume: false
					};
					liveTabs.push(created);
				}
				state = {
					...state,
					items: state.items.map((candidate) => candidate.id === item.id ? item : candidate)
				};
				await this.writeState(state);
				if (first && item.tabId !== null) {
					this.activeTabByWindow.set(item.tabWindowId ?? queueWindowId, item.tabId);
				}
				first = false;
			}
			return structuredClone(state);
		});
	}
	openItem(itemId: string): Promise<LinkManagerState> {
		return this.getState().then((state) => {
			const item = state.items.find((candidate) => candidate.id === itemId);
			if (!item) {
				throw new Error("Link not found.");
			}
			return this.openSelected([ itemId ], item.queueWindowId);
		});
	}

	togglePause(queueWindowId: number): Promise<LinkManagerState> {
		return this.serialize(async () => {
			if (!Number.isInteger(queueWindowId) || queueWindowId < 0) {
				throw new Error("A valid browser window is required to pause its queue.");
			}
			let state = await this.readState();
			const currentlyPaused = isWindowPaused(state, queueWindowId);
			if (!currentlyPaused) {
				const managedItems = state.items.filter((item) =>
					item.queueWindowId === queueWindowId && item.ownership === "managed" && item.tabId !== null
				);
				state = {
					...state,
					pausedWindowIds: [ ...state.pausedWindowIds, queueWindowId ],
					items: state.items.map((item) =>
						item.queueWindowId === queueWindowId && item.ownership === "managed" && item.tabId !== null
							? { ...item, status: "queued", tabId: null, tabWindowId: null, resumeOnResume: true }
							: item)
				};
				await this.writeState(state);
				for (const item of managedItems) {
					if (item.tabId !== null && item.tabWindowId !== null
						&& this.activeTabByWindow.get(item.tabWindowId) === item.tabId) {
						this.activeTabByWindow.delete(item.tabWindowId);
					}
				}
				const ids = managedItems.map((item) => item.tabId!).filter(Number.isInteger);
				if (ids.length > 0) {
					await this.tabs.remove(ids).catch(reportManagerError);
				}
				return structuredClone(await this.readState());
			}

			state = {
				...state,
				pausedWindowIds: state.pausedWindowIds.filter((id) => id !== queueWindowId)
			};
			await this.writeState(state);
			const restoreItems = sortByOrder(state.items.filter((item) =>
				item.queueWindowId === queueWindowId && item.resumeOnResume
			));
			let first = true;
			for (const restore of restoreItems) {
				const current = state.items.find((item) => item.id === restore.id);
				if (!current) {
					continue;
				}
				try {
					const tab = await this.tabs.create({ url: current.url, active: first, windowId: queueWindowId });
					if (tab.id === undefined) {
						throw new Error("The browser did not return a tab ID.");
					}
					const updated: LinkManagerItem = {
						...current,
						status: "open",
						tabId: tab.id,
						tabWindowId: tab.windowId,
						ownership: "managed",
						openedAt: current.openedAt ?? this.now(),
						resumeOnResume: false
					};
					state = {
						...state,
						items: state.items.map((item) => item.id === updated.id ? updated : item)
					};
					await this.writeState(state);
					if (first) {
						this.activeTabByWindow.set(queueWindowId, tab.id);
					}
					first = false;
				} catch (error) {
					reportManagerError(error);
				}
			}
			const liveTabs = await this.tabs.query();
			const hasOpenQueueItem = state.items.some((item) =>
				item.queueWindowId === queueWindowId
				&& item.status === "open"
				&& item.tabId !== null
				&& liveTabs.some((tab) => tab.id === item.tabId)
			);
			if (!hasOpenQueueItem) {
				await this.openNextQueued(queueWindowId);
				state = await this.readState();
			}
			return structuredClone(state);
		});
	}


	moveItem(itemId: string, direction: -1 | 1): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			const current = state.items.find((item) => item.id === itemId);
			if (!current) {
				throw new Error("Link not found.");
			}
			const siblings = sortByOrder(state.items.filter((item) =>
				item.queueWindowId === current.queueWindowId && item.listId === current.listId
			));
			const index = siblings.findIndex((item) => item.id === itemId);
			const targetIndex = index + direction;
			if (targetIndex < 0 || targetIndex >= siblings.length) {
				return structuredClone(state);
			}
			const reordered = [ ...siblings ];
			[ reordered[index], reordered[targetIndex] ] = [ reordered[targetIndex]!, reordered[index]! ];
			const orderSlots = siblings.map((item) => item.order).sort((a, b) => a - b);
			const nextOrder = new Map(reordered.map((item, position) => [ item.id, orderSlots[position]! ]));
			const next = {
				...state,
				items: state.items.map((item) => nextOrder.has(item.id)
					? { ...item, order: nextOrder.get(item.id)! }
					: item)
			};
			await this.writeState(next);
			return structuredClone(next);
		});
	}

	removeDuplicateUrls(queueWindowId: number, listId: string): Promise<LinkManagerState> {
		return this.removeCollectionItems(queueWindowId, listId, true);
	}

	clearCollection(queueWindowId: number, listId: string): Promise<LinkManagerState> {
		return this.removeCollectionItems(queueWindowId, listId, false);
	}

	private removeCollectionItems(
		queueWindowId: number,
		listId: string,
		duplicatesOnly: boolean
	): Promise<LinkManagerState> {
		return this.serialize(async () => {
			const state = await this.readState();
			if (!Number.isInteger(queueWindowId) || !state.lists.some((list) => list.id === listId)) {
				throw new Error("The selected collection or browser window is invalid.");
			}
			const collectionItems = sortByOrder(state.items.filter((item) =>
				item.queueWindowId === queueWindowId && item.listId === listId
			));
			const keepUrls = new Set<string>();
			const removedIds = new Set<string>();
			for (const item of collectionItems) {
				const normalized = normalizeManagerUrl(item.url) ?? item.url;
				if (duplicatesOnly && !keepUrls.has(normalized)) {
					keepUrls.add(normalized);
					continue;
				}
				removedIds.add(item.id);
			}
			if (removedIds.size === 0) {
				return structuredClone(state);
			}

			const removedItems = collectionItems.filter((item) => removedIds.has(item.id));
			const liveTabs = await this.tabs.query();
			const liveById = new Map(liveTabs.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));
			const managedTabIds = removedItems
				.filter((item) => item.ownership === "managed" && item.tabId !== null && liveById.has(item.tabId))
				.map((item) => item.tabId!);
			const closesActiveQueueTab = removedItems.some((item) =>
				item.ownership === "managed"
				&& item.tabId !== null
				&& (liveById.get(item.tabId)?.active === true
					|| this.activeTabByWindow.get(item.tabWindowId ?? item.queueWindowId) === item.tabId)
			);
			const next = {
				...state,
				items: state.items.filter((item) => !removedIds.has(item.id))
			};
			await this.writeState(next);
			if (managedTabIds.length > 0) {
				await this.tabs.remove(managedTabIds).catch(reportManagerError);
			}
			if (closesActiveQueueTab && !isWindowPaused(next, queueWindowId)) {
				await this.advanceQueue(queueWindowId);
			}
			return structuredClone(await this.readState());
		});
	}

	setReadStatus(itemId: string, readStatus: LinkManagerReadStatus): Promise<LinkManagerState> {
		if (readStatus !== "unread" && readStatus !== "read") {
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
			const liveTabs = await this.tabs.query();
			const wasActive = item.tabId !== null && (
				this.activeTabByWindow.get(item.tabWindowId ?? item.queueWindowId) === item.tabId
				|| liveTabs.some((tab) => tab.id === item.tabId && tab.active === true)
			);
			const next = { ...state, items: state.items.filter((candidate) => candidate.id !== itemId) };
			await this.writeState(next);
			if (item.ownership === "managed" && item.tabId !== null) {
				await this.tabs.remove(item.tabId).catch(reportManagerError);
			}
			if (wasActive && item.ownership === "managed" && !isWindowPaused(next, item.queueWindowId)) {
				await this.advanceQueue(item.queueWindowId);
			}
			return structuredClone(await this.readState());
		});
	}

	recover(): Promise<void> {
		return this.serialize(async () => {
			const state = await this.readState();
			const tabs = await this.tabs.query();
			this.activeTabByWindow.clear();
			for (const tab of tabs) {
				if (tab.active && tab.id !== undefined) {
					this.activeTabByWindow.set(tab.windowId, tab.id);
				}
			}
			const byId = new Map(tabs.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));
			let changed = false;
			const items = state.items.map((item) => {
				if (item.tabId === null) {
					return item;
				}
				const tab = byId.get(item.tabId);
				if (!tab) {
					changed = true;
					return { ...item, status: "closed" as const, tabId: null, tabWindowId: null, ownership: null };
				}
				if (item.tabWindowId !== tab.windowId) {
					changed = true;
					return { ...item, tabWindowId: tab.windowId };
				}
				return item;
			});
			if (changed) {
				await this.writeState({ ...state, items });
			}
		});
	}

	private async advanceQueue(queueWindowId: number): Promise<void> {
		const state = await this.readState();
		if (isWindowPaused(state, queueWindowId)) {
			return;
		}
		const liveTabs = await this.tabs.query();
		const byId = new Map(liveTabs.filter((tab) => tab.id !== undefined).map((tab) => [ tab.id!, tab ]));
		const openItems = sortByOrder(state.items.filter((item) =>
			item.queueWindowId === queueWindowId
			&& item.status === "open"
			&& item.tabId !== null
			&& byId.has(item.tabId)
			&& this.isEligibleWindow(item.tabWindowId ?? queueWindowId, queueWindowId, state.windowPolicy)
		));
		if (openItems.length > 0) {
			const next = openItems[0]!;
			await this.activateTab(next.tabId!, next.tabWindowId ?? queueWindowId, queueWindowId, state.windowPolicy);
			return;
		}
		await this.openNextQueued(queueWindowId);
	}

	private async openNextQueued(queueWindowId: number): Promise<void> {
		const state = await this.readState();
		if (isWindowPaused(state, queueWindowId)) {
			return;
		}
		const next = sortByOrder(state.items.filter((item) => item.queueWindowId === queueWindowId && item.status === "queued"))[0];
		if (!next) {
			return;
		}
		const liveTabs = await this.tabs.query();
		const matches = liveTabs.filter((tab) =>
			tab.id !== undefined
			&& normalizeManagerUrl(tab.url ?? "") === next.url
			&& this.isEligibleWindow(tab.windowId, queueWindowId, state.windowPolicy)
			&& !state.items.some((known) => known.id !== next.id && known.tabId === tab.id)
		);
		const existing = preferredMatch(matches);
		let updated: LinkManagerItem;
		if (existing?.id !== undefined) {
			updated = {
				...next,
				status: "open",
				tabId: existing.id,
				tabWindowId: existing.windowId,
				ownership: state.defaultOwnership,
				readStatus: existing.active ? "read" : next.readStatus,
				openedAt: this.now()
			};
		} else {
			const created = await this.tabs.create({ url: next.url, active: true, windowId: queueWindowId });
			if (created.id === undefined) {
				throw new Error("The browser did not return a tab ID.");
			}
			updated = {
				...next,
				status: "open",
				tabId: created.id,
				tabWindowId: created.windowId,
				ownership: "managed",
				readStatus: "read",
				openedAt: this.now()
			};
		}
		await this.writeState({
			...state,
			items: state.items.map((item) => item.id === updated.id ? updated : item)
		});
		if (existing?.id !== undefined) {
			await this.activateTab(existing.id, existing.windowId, queueWindowId, state.windowPolicy);
		}
	}

	private async activateTab(
		tabId: number,
		tabWindowId: number,
		queueWindowId: number,
		policy: LinkManagerWindowPolicy
	): Promise<void> {
		if (tabWindowId !== queueWindowId && policy === "current-window") {
			return;
		}
		if (tabWindowId !== queueWindowId && policy === "follow") {
			await this.windows?.update(tabWindowId, { focused: true });
		}
		await this.tabs.update(tabId, { active: true });
		this.activeTabByWindow.set(tabWindowId, tabId);
	}

	private isEligibleWindow(tabWindowId: number, queueWindowId: number, policy: LinkManagerWindowPolicy): boolean {
		return policy === "follow" || tabWindowId === queueWindowId;
	}

	private async handleTabActivated(tabId: number): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item || item.readStatus === "read") {
			return;
		}
		await this.writeState({
			...state,
			items: state.items.map((candidate) => candidate.id === item.id
				? { ...candidate, readStatus: "read" }
				: candidate)
		});
	}

	private async handleTabRemoved(
		tabId: number,
		removeInfo: { readonly windowId: number; readonly isWindowClosing: boolean },
		wasActiveOverride = false
	): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item) {
			if (this.activeTabByWindow.get(removeInfo.windowId) === tabId) {
				this.activeTabByWindow.delete(removeInfo.windowId);
			}
			return;
		}
		const wasActive = wasActiveOverride || this.activeTabByWindow.get(removeInfo.windowId) === tabId;
		if (this.activeTabByWindow.get(removeInfo.windowId) === tabId) {
			this.activeTabByWindow.delete(removeInfo.windowId);
		}
		const next = {
			...state,
			items: state.items.map((candidate) => candidate.id === item.id
				? { ...candidate, status: "closed" as const, tabId: null, tabWindowId: null, ownership: null }
				: candidate)
		};
		await this.writeState(next);
		if (wasActive && !isWindowPaused(next, item.queueWindowId) && !removeInfo.isWindowClosing) {
			await this.advanceQueue(item.queueWindowId);
		}
	}

	private async handleTabUpdated(tabId: number, _url: string | undefined, tab: LinkManagerTabInfo): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item) {
			return;
		}
		// Keep the association by tab ID when a user navigates elsewhere. The tab remains
		// the queue item until it is closed; ownership rules still apply to that tab.
		if (tab.title && tab.title !== item.title) {
			await this.writeState({
				...state,
				items: state.items.map((candidate) => candidate.id === item.id
					? { ...candidate, title: tab.title! }
					: candidate)
			});
		}
	}

	private async handleTabAttached(tabId: number, newWindowId: number): Promise<void> {
		const state = await this.readState();
		const item = state.items.find((candidate) => candidate.tabId === tabId);
		if (!item) {
			return;
		}
		if (state.windowPolicy === "current-window" && newWindowId !== item.queueWindowId) {
			const movedTabIsActive = await this.tabs.get(tabId)
				.then((tab) => tab.active === true, () => false);
			const wasActive = movedTabIsActive
				|| this.activeTabByWindow.get(item.tabWindowId ?? item.queueWindowId) === tabId;
			if (item.tabWindowId !== null && this.activeTabByWindow.get(item.tabWindowId) === tabId) {
				this.activeTabByWindow.delete(item.tabWindowId);
			}
			await this.writeState({
				...state,
				items: state.items.map((candidate) => candidate.id === item.id
					? { ...candidate, status: "closed", tabId: null, tabWindowId: null, ownership: null }
					: candidate)
			});
			if (wasActive) {
				await this.advanceQueue(item.queueWindowId);
			}
			return;
		}
		await this.writeState({
			...state,
			items: state.items.map((candidate) => candidate.id === item.id
				? { ...candidate, tabWindowId: newWindowId }
				: candidate)
		});
		if (this.activeTabByWindow.get(item.tabWindowId ?? item.queueWindowId) === tabId) {
			this.activeTabByWindow.delete(item.tabWindowId ?? item.queueWindowId);
		}
		try {
			if ((await this.tabs.get(tabId)).active === true) {
				this.activeTabByWindow.set(newWindowId, tabId);
			}
		} catch {
			// The tab can close while a move is being reconciled; onRemoved handles it.
		}
	}

	private async readSessionPreferences(): Promise<LinkManagerSessionPreferences> {
		if (!this.sessionStorage) {
			return DEFAULT_SESSION_PREFERENCES;
		}
		try {
			const stored = await this.sessionStorage.get(LINK_MANAGER_SESSION_KEY);
			const value = stored[LINK_MANAGER_SESSION_KEY] as Partial<LinkManagerSessionPreferences> | undefined;
			return {
				duplicateResolution: value?.duplicateResolution === "activate"
					|| value?.duplicateResolution === "replace"
					|| value?.duplicateResolution === "duplicate"
					? value.duplicateResolution : null,
				ownership: isOwnership(value?.ownership) ? value.ownership : null
			};
		} catch {
			return DEFAULT_SESSION_PREFERENCES;
		}
	}

	private async saveSessionPreferences(preferences: LinkManagerSessionPreferences): Promise<void> {
		await this.sessionStorage?.set({ [LINK_MANAGER_SESSION_KEY]: preferences });
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
		const migrated = migrateVersionTwoState(value);
		if (migrated) {
			await this.writeState(migrated);
			return migrated;
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

function preferredMatch<T extends { readonly active?: boolean; readonly index?: number }>(matches: readonly T[]): T | undefined {
	return [ ...matches ].sort((a, b) => Number(b.active === true) - Number(a.active === true)
		|| Number(a.index ?? 0) - Number(b.index ?? 0))[0];
}

function reportManagerError(error: unknown): void {
	console.error("[LinkManager] Operation failed:", error);
}

const storageSession = (browser.storage as unknown as { session?: LinkManagerStorageAdapter }).session;
export const linkManagerService = new LinkManagerService(
	browser.tabs as unknown as LinkManagerTabsAdapter,
	browser.storage.local as unknown as LinkManagerStorageAdapter,
	{
		windows: browser.windows as unknown as LinkManagerWindowsAdapter,
		sessionStorage: storageSession
	}
);
