import type { CopyFormat, Settings } from "./Settings";
import type {
	LinkManagerAddLinksRequest,
	LinkManagerDuplicateAction,
	LinkManagerOwnership,
	LinkManagerReadStatus,
	LinkManagerViewMode,
	LinkManagerWindowPolicy
} from "./LinkManager";

export type ActivateMessage_copy = {
	"action": "copy";
	"options": { "block": boolean; "reverse": boolean; "copy": CopyFormat };
};

export type ActivateMessage_bm = {
	"action": "bm";
	"options": { "block": boolean; "reverse": boolean; "bookmarks": number };
};

export type ActivateMessage_win = {
	"action": "win";
	"options": { "block": boolean; "reverse": boolean; "unfocus": boolean; "delay": number };
};

export type ActivateMessage_tabs = {
	"action": "tabs";
	"options": { "block": boolean; "reverse": boolean; "end": boolean; "delay": number; "close"?: number };
};

export type ActivateMessageTypes = ActivateMessage_copy | ActivateMessage_bm | ActivateMessage_win | ActivateMessage_tabs;

export type ActivateMessage<T extends ActivateMessageTypes = ActivateMessageTypes> = {
	"message": "activate";
	"urls": { url: string; title: string }[];
	"setting": T;
};

export type UpdateMessage = { "message": "update"; "settings": Settings };
export type InitMessage = { "message": "init" };

export type LinkManagerMessage =
	| { "message": "linkManagerGetState" }
	| { "message": "linkManagerInspectDuplicates"; "urls": readonly { url: string; title: string }[]; "queueWindowId": number }
	| { "message": "linkManagerAddLinks"; "request": LinkManagerAddLinksRequest }
	| { "message": "linkManagerSaveSelection"; "urls": readonly { readonly url: string; readonly title: string }[] }
	| { "message": "linkManagerAddList"; "name": string }
	| { "message": "linkManagerSetActiveList"; "listId": string }
	| { "message": "linkManagerSetViewMode"; "viewMode": LinkManagerViewMode }
	| { "message": "linkManagerSetOpenOnSingleClick"; "enabled": boolean }
	| { "message": "linkManagerSetDefaultOwnership"; "ownership": LinkManagerOwnership }
	| { "message": "linkManagerSetWindowPolicy"; "policy": LinkManagerWindowPolicy }
	| { "message": "linkManagerSetReadStatus"; "itemId": string; "readStatus": LinkManagerReadStatus }
	| { "message": "linkManagerRemoveItem"; "itemId": string }
	| { "message": "linkManagerMoveItem"; "itemId": string; "direction": -1 | 1 }
	| { "message": "linkManagerRemoveDuplicateUrls"; "queueWindowId": number; "listId": string }
	| { "message": "linkManagerClearCollection"; "queueWindowId": number; "listId": string }
	| { "message": "linkManagerOpenItem"; "itemId": string }
	| { "message": "linkManagerOpenSelected"; "itemIds": readonly string[]; "queueWindowId": number; "duplicateActions"?: readonly LinkManagerDuplicateAction[] }
	| { "message": "linkManagerTogglePause" };

export type Messages = ActivateMessage | InitMessage | UpdateMessage | LinkManagerMessage;
export type InitResponse = Settings & { error?: string };
