export type LinkManagerQueueMode = "refill" | "batch" | "manual" | "sequential";
export type LinkManagerViewMode = "combined" | "collections";
export type LinkManagerReadStatus = "unread" | "viewed" | "read";
export type LinkManagerQueueStatus =
	| "queued"
	| "opening"
	| "staged"
	| "opened"
	| "suspended"
	| "external"
	| "closed";
export type LinkManagerTabKind = "placeholder" | "destination" | "external" | null;

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
	readonly batchId: string | null;
	readonly readStatus: LinkManagerReadStatus;
	readonly queueStatus: LinkManagerQueueStatus;
	readonly tabKind: LinkManagerTabKind;
	readonly tabId: number | null;
	readonly managed: boolean;
	readonly tabToken?: string;
	readonly addedAt: number;
	readonly viewedAt: number | null;
	readonly tabToken?: string;
}

export interface LinkManagerState {
	readonly version: 1;
	readonly paused: boolean;
	readonly mode: LinkManagerQueueMode;
	readonly viewMode: LinkManagerViewMode;
	readonly batchSize: number;
	readonly openOnSingleClick: boolean;
	readonly activeListId: string;
	readonly activeBatchId: string | null;
	readonly nextBatchNumber: number;
	readonly lists: readonly LinkManagerList[];
	readonly items: readonly LinkManagerItem[];
}

export interface LinkManagerTabDuplicate {
	readonly id: number;
	readonly title: string;
	readonly url: string;
	readonly windowId: number;
	readonly active: boolean;
	readonly managed: boolean;
}

export type LinkManagerDuplicateAction =
	| { readonly url: string; readonly tabId: number; readonly action: "activate" }
	| { readonly url: string; readonly tabId: number; readonly action: "replace" };

export interface LinkManagerAddLinksRequest {
	readonly urls: readonly { readonly url: string; readonly title: string }[];
	readonly listId?: string;
	readonly duplicateActions?: readonly LinkManagerDuplicateAction[];
}

export interface LinkManagerCommandResponse {
	readonly ok: boolean;
	readonly state?: LinkManagerState;
	readonly error?: string;
}
