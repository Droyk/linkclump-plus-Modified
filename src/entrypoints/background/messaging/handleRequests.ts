/**
 * Runtime message dispatch for content scripts, options, and the Link Manager panel.
 */
import type { Browser } from "wxt/browser";
import { safeAsync } from "@/assets/js/lib/safeAsync";
import { linkManagerService } from "../queue/LinkManagerService";
import { handleActivate } from "./handleActivate";
import { handleUpdateSettings } from "./handleUpdateSettings";

import type { ActivateMessage, Messages, UpdateMessage } from "@/assets/js/types/Messages";
import type { Deps } from "../deps";

export function handleRequests(
	request: Messages,
	sender: Browser.runtime.MessageSender,
	sendResponse: (response?: unknown) => void,
	deps: Deps
): boolean {
	switch (request.message) {
		case "activate":
			safeAsync("handleActivate", () => handleActivate(request as ActivateMessage, sender), "background");
			return false;
		case "init":
			safeAsync("init", async () => {
				try {
					sendResponse(await deps.settingsManager.load());
				} catch (error) {
					sendResponse(undefined);
					throw error;
				}
			}, "background");
			return true;
		case "update":
			safeAsync("handleUpdateSettings", () => handleUpdateSettings(request as UpdateMessage, deps), "background");
			return false;
		case "linkManagerGetState":
			return respond("linkManagerGetState", () => linkManagerService.getState(), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerInspectDuplicates":
			return respond(
				"linkManagerInspectDuplicates",
				() => linkManagerService.inspectDuplicates(request.urls, request.queueWindowId),
				sendResponse,
				(result) => ({ ok: true, ...result })
			);
		case "linkManagerAddLinks":
			return respond("linkManagerAddLinks", () => linkManagerService.addLinks(request.request), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSaveSelection":
			return respond(
				"linkManagerSaveSelection",
				() => linkManagerService.saveSelection(request.urls, sender.tab?.windowId),
				sendResponse,
				(state) => ({ ok: true, state })
			);
		case "linkManagerAddList":
			return respond("linkManagerAddList", () => linkManagerService.addList(request.name), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetActiveList":
			return respond("linkManagerSetActiveList", () => linkManagerService.setActiveList(request.listId), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetViewMode":
			return respond("linkManagerSetViewMode", () => linkManagerService.setViewMode(request.viewMode), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetOpenOnSingleClick":
			return respond("linkManagerSetOpenOnSingleClick", () => linkManagerService.setOpenOnSingleClick(request.enabled), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetDefaultOwnership":
			return respond("linkManagerSetDefaultOwnership", () => linkManagerService.setDefaultOwnership(request.ownership), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetWindowPolicy":
			return respond("linkManagerSetWindowPolicy", () => linkManagerService.setWindowPolicy(request.policy), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetReadStatus":
			return respond("linkManagerSetReadStatus", () => linkManagerService.setReadStatus(request.itemId, request.readStatus), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerRemoveItem":
			return respond("linkManagerRemoveItem", () => linkManagerService.removeItem(request.itemId), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerMoveItem":
			return respond("linkManagerMoveItem", () => linkManagerService.moveItem(request.itemId, request.direction), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerRemoveDuplicateUrls":
			return respond(
				"linkManagerRemoveDuplicateUrls",
				() => linkManagerService.removeDuplicateUrls(request.queueWindowId, request.listId),
				sendResponse,
				(state) => ({ ok: true, state })
			);
		case "linkManagerClearCollection":
			return respond(
				"linkManagerClearCollection",
				() => linkManagerService.clearCollection(request.queueWindowId, request.listId),
				sendResponse,
				(state) => ({ ok: true, state })
			);
		case "linkManagerOpenItem":
			return respond("linkManagerOpenItem", () => linkManagerService.openItem(request.itemId), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerOpenSelected":
			return respond(
				"linkManagerOpenSelected",
				() => linkManagerService.openSelected(request.itemIds, request.queueWindowId, request.duplicateActions),
				sendResponse,
				(state) => ({ ok: true, state })
			);
		case "linkManagerTogglePause":
			return respond("linkManagerTogglePause", () => linkManagerService.togglePause(request.queueWindowId), sendResponse, (state) => ({ ok: true, state }));
		default:
			return false;
	}
}

function respond<T>(
	name: string,
	operation: () => Promise<T>,
	sendResponse: (response?: unknown) => void,
	mapResponse: (value: T) => unknown
): boolean {
	safeAsync(name, async () => {
		try {
			sendResponse(mapResponse(await operation()));
		} catch (error) {
			sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}, "background");
	return true;
}
