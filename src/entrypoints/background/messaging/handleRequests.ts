/**
 * Runtime message dispatch for content scripts, options, and the Link Manager panel.
 */
import type { Browser } from "wxt/browser";
import { safeAsync } from "@/assets/js/lib/safeAsync";
import { handleActivate } from "./handleActivate";
import { handleUpdateSettings } from "./handleUpdateSettings";
import { sequentialQueueManager } from "../queue/SequentialQueueManager";
import { lazyTabManager } from "../queue/LazyTabManager";
import { linkManagerService } from "../queue/LinkManagerService";

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
		case "startSequentialQueue":
			safeAsync("startSequentialQueue", async () => {
				try {
					const started = await sequentialQueueManager.start(
						request.urls,
						sender.tab?.id,
						request.blockDuplicates ?? true
					);
					sendResponse({ ok: started });
				} catch (error) {
					sendResponse({ ok: false });
					throw error;
				}
			}, "background");
			return true;
		case "stopSequentialQueue":
			safeAsync("stopSequentialQueue", async () => {
				try {
					await sequentialQueueManager.stop();
					sendResponse({ ok: true });
				} catch (error) {
					sendResponse({ ok: false });
					throw error;
				}
			}, "background");
			return true;
		case "createLazyTabs":
			safeAsync(
				"createLazyTabs",
				() => lazyTabManager.create(request.urls, sender.tab?.id, request.delayMs ?? 0, request.blockDuplicates ?? true),
				"background"
			);
			return false;
		case "changeStorageMode":
			safeAsync("changeStorageMode", async () => {
				try {
					await deps.settingsManager.changeStorageMode(request.mode);
					sendResponse({ ok: true, mode: request.mode });
				} catch (error) {
					sendResponse({
						ok: false,
						mode: await deps.settingsManager.getStorageMode(),
						error: error instanceof Error ? error.message : String(error)
					});
					throw error;
				}
			}, "background");
			return true;
		case "init":
			safeAsync("init", async () => {
				try {
					const settings = await deps.settingsManager.load();
					const storageMode = await deps.settingsManager.getStorageMode();
					sendResponse({ ...settings, storageMode });
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
			return respond("linkManagerInspectDuplicates", () => linkManagerService.inspectDuplicates(request.urls), sendResponse, (duplicates) => ({ ok: true, duplicates }));
		case "linkManagerAddLinks":
			return respond("linkManagerAddLinks", () => linkManagerService.addLinks(request.request), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerAddList":
			return respond("linkManagerAddList", () => linkManagerService.addList(request.name), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetActiveList":
			return respond("linkManagerSetActiveList", () => linkManagerService.setActiveList(request.listId), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetMode":
			return respond("linkManagerSetMode", () => linkManagerService.setMode(request.mode), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetViewMode":
			return respond("linkManagerSetViewMode", () => linkManagerService.setViewMode(request.viewMode), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetBatchSize":
			return respond("linkManagerSetBatchSize", () => linkManagerService.setBatchSize(request.batchSize), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetOpenOnSingleClick":
			return respond("linkManagerSetOpenOnSingleClick", () => linkManagerService.setOpenOnSingleClick(request.enabled), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerSetReadStatus":
			return respond("linkManagerSetReadStatus", () => linkManagerService.setReadStatus(request.itemId, request.readStatus), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerRemoveItem":
			return respond("linkManagerRemoveItem", () => linkManagerService.removeItem(request.itemId), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerStageNext":
			return respond("linkManagerStageNext", () => linkManagerService.stageNext(), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerTogglePause":
			return respond("linkManagerTogglePause", () => linkManagerService.togglePause(), sendResponse, (state) => ({ ok: true, state }));
		case "linkManagerOpenItem":
			return respond("linkManagerOpenItem", () => linkManagerService.openItem(request.itemId), sendResponse, (state) => ({ ok: true, state }));
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
