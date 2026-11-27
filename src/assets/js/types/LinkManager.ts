export type LinkManagerViewMode = "combined" | "collections";
export type LinkManagerReadStatus = "unread" | "read";
export type LinkManagerOwnership = "managed" | "borrowed";
export type LinkManagerWindowPolicy = "current-window" | "follow";
export type LinkManagerDuplicateResolution = "activate" | "replace" | "duplicate";
export type LinkManagerItemStatus = "queued" | "open" | "closed";

export interface LinkManagerList {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
}

export interface LinkManagerItem {
	readonly id: string;
	readonly listId: string;
	readonly url: string;
	readonly title: string;
	readonly order: number;
	readonly queueWindowId: number;
	readonly status: LinkManagerItemStatus;
	readonly tabId: number | null;
	readonly tabWindowId: number | null;
	readonly ownership: LinkManagerOwnership | null;
	readonly readStatus: LinkManagerReadStatus;
	readonly addedAt: number;
	readonly openedAt: number | null;
	readonly resumeOnResume: boolean;
}

export interface LinkManagerState {
	readonly version: 2;
	readonly paused: boolean;
	readonly viewMode: LinkManagerViewMode;
	readonly openOnSingleClick: boolean;
	readonly defaultOwnership: LinkManagerOwnership;
	readonly windowPolicy: LinkManagerWindowPolicy;
	readonly activeListId: string;
	readonly lists: readonly LinkManagerList[];
	readonly items: readonly LinkManagerItem[];
}

export interface LinkManagerTabDuplicate {
	readonly id: number;
	readonly title: string;
	readonly url: string;
	readonly windowId: number;
	readonly index: number;
	readonly active: boolean;
	readonly managed: boolean;
	readonly tracked: boolean;
}

export type LinkManagerDuplicateAction =
	| {
		readonly url: string;
		readonly action: "activate" | "custom";
		readonly activateTabId: number;
		readonly closeTabIds?: readonly number[];
		readonly ownership?: LinkManagerOwnership;
		readonly rememberResolution?: boolean;
		readonly rememberOwnership?: boolean;
	}
	| {
		readonly url: string;
		readonly action: "replace" | "duplicate";
		readonly closeTabIds?: readonly number[];
		readonly rememberResolution?: boolean;
	};

export interface LinkManagerAddLinksRequest {
	readonly urls: readonly { readonly url: string; readonly title: string }[];
	readonly listId?: string;
	readonly queueWindowId: number;
	readonly duplicateActions?: readonly LinkManagerDuplicateAction[];
}

export interface LinkManagerSessionPreferences {
	readonly duplicateResolution: LinkManagerDuplicateResolution | null;
	readonly ownership: LinkManagerOwnership | null;
}

export interface LinkManagerInspectDuplicatesResponse {
	readonly duplicates: Record<string, LinkManagerTabDuplicate[]>;
	readonly sessionPreferences: LinkManagerSessionPreferences;
}

export interface LinkManagerCommandResponse {
	readonly ok: boolean;
	readonly state?: LinkManagerState;
	readonly error?: string;
}
