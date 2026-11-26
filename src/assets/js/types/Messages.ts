import type { CopyFormat, Settings, SettingsStorageMode } from "./Settings";
import type {
	LinkManagerAddLinksRequest,
	LinkManagerQueueMode,
	LinkManagerReadStatus,
	LinkManagerTabDuplicate,
	LinkManagerViewMode
} from "./LinkManager";

export type ActivateMessage_copy = {
	"action": "copy",
	"options": {
		"block": boolean,
		"reverse": boolean,
		"copy": CopyFormat
	}
};

export type ActivateMessage_bm = {
	"action": "bm",
	"options": {
		"block": boolean,
		"reverse": boolean,
		"bookmarks": number
	}
};

export type ActivateMessage_win = {
	"action": "win",
	"options": {
		"block": boolean,
		"reverse": boolean,
		"unfocus": boolean,
		"delay": number,
	}
};

export type ActivateMessage_tabs = {
	"action": "tabs",
	"options": {
		"block": boolean,
		"reverse": boolean,
		"end": boolean,
		"delay": number,
		"close"?: number,
	}
};

export type ActivateMessageTypes = ActivateMessage_copy | ActivateMessage_bm | ActivateMessage_win | ActivateMessage_tabs;

export type ActivateMessage<T extends ActivateMessageTypes = ActivateMessageTypes> = {
	"message": "activate",
	"urls": { url: string, title: string }[],
	"setting": T
};

export type UpdateMessage = {
	"message": "update",
	"settings": Settings,
};

export type InitMessage = {
	"message": "init",
};

export type StartSequentialQueueMessage = {
	"message": "startSequentialQueue";
	"urls": { url: string; title: string }[];
	"blockDuplicates"?: boolean;
};

export type StopSequentialQueueMessage = {
	"message": "stopSequentialQueue";
};

export type SequentialQueueCommandResponse = {
	readonly ok: boolean;
};

export type CreateLazyTabsMessage = {
	"message": "createLazyTabs";
	"urls": { url: string; title: string }[];
	"delayMs"?: number;
	"blockDuplicates"?: boolean;
};

export type ChangeStorageModeMessage = {
	"message": "changeStorageMode";
	"mode": SettingsStorageMode;
};

export type ChangeStorageModeResponse = {
	readonly ok: boolean;
	readonly mode: SettingsStorageMode;
	readonly error?: string;
};

export type LinkManagerMessage =
	| { readonly message: "linkManagerGetState" }
	| { readonly message: "linkManagerInspectDuplicates"; readonly urls: readonly { readonly url: string; readonly title: string }[] }
	| { readonly message: "linkManagerAddLinks"; readonly request: LinkManagerAddLinksRequest }
	| { readonly message: "linkManagerAddList"; readonly name: string }
	| { readonly message: "linkManagerSetActiveList"; readonly listId: string }
	| { readonly message: "linkManagerSetMode"; readonly mode: LinkManagerQueueMode }
	| { readonly message: "linkManagerSetViewMode"; readonly viewMode: LinkManagerViewMode }
	| { readonly message: "linkManagerSetBatchSize"; readonly batchSize: number }
	| { readonly message: "linkManagerSetOpenOnSingleClick"; readonly enabled: boolean }
	| { readonly message: "linkManagerSetReadStatus"; readonly itemId: string; readonly readStatus: LinkManagerReadStatus }
	| { readonly message: "linkManagerRemoveItem"; readonly itemId: string }
	| { readonly message: "linkManagerStageNext" }
	| { readonly message: "linkManagerTogglePause" }
	| { readonly message: "linkManagerOpenItem"; readonly itemId: string };

export type LinkManagerInspectDuplicatesResponse = {
	readonly ok: boolean;
	readonly duplicates?: Record<string, LinkManagerTabDuplicate[]>;
	readonly error?: string;
};

export type Messages =
	| ActivateMessage
	| InitMessage
	| UpdateMessage
	| StartSequentialQueueMessage
	| StopSequentialQueueMessage
	| CreateLazyTabsMessage
	| ChangeStorageModeMessage
	| LinkManagerMessage;

export type InitResponse = Settings & {
	error?: string;
	storageMode?: SettingsStorageMode;
};
