// WXT-provided cross-browser APIs.
import { browser } from "wxt/browser";
import { safeAsync } from "@/assets/js/lib/safeAsync";
import { initBackground } from "./init/initBackground";
import { handleRequests } from "./messaging/handleRequests";
import { ContentScriptManager } from "./scripts/ContentScriptManager";
import { SettingsManager } from "./settings/SettingsManager";
import { StorageManager } from "./settings/StorageManager";
import { linkManagerService } from "./queue/LinkManagerService";

import type { Deps } from "./deps";
import type { Messages } from "@/assets/js/types/Messages";

const storageManager = new StorageManager();
const settingsManager = new SettingsManager(storageManager);
const contentScriptManager = new ContentScriptManager(settingsManager);
const deps: Deps = { settingsManager, contentScriptManager };

type SidebarApi = {
	sidePanel?: {
		open(options: { windowId: number }): Promise<void>;
		setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
	};
	sidebarAction?: { open(): Promise<void> };
};

function main(): void {
	linkManagerService.register();
	safeAsync("recoverLinkManager", () => linkManagerService.recover(), "background");

	browser.runtime.onMessage.addListener((request: Messages, sender, sendResponse) =>
		handleRequests(request, sender, sendResponse, deps)
	);

	const sidebarApi = browser as unknown as SidebarApi;
	if (sidebarApi.sidePanel?.setPanelBehavior) {
		safeAsync(
			"configureLinkManagerSidePanel",
			() => sidebarApi.sidePanel!.setPanelBehavior!({ openPanelOnActionClick: true }),
			"background"
		);
	}

	browser.action.onClicked.addListener((tab) => {
		if (sidebarApi.sidePanel) {
			return;
		}
		safeAsync("openLinkManager", () => openLinkManager(tab.windowId), "background");
	});

	browser.commands.onCommand.addListener((command) => {
		safeAsync("linkManagerCommand:" + command, async () => {
			if (command === "toggle-link-manager-pause") {
				const activeTab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
				if (activeTab?.windowId !== undefined) {
					await linkManagerService.togglePause(activeTab.windowId);
				}
			} else if (command === "open-link-manager") {
				await openLinkManager();
			}
		}, "background");
	});

	safeAsync("initBackground", () => initBackground(deps), "background");
}

async function openLinkManager(windowId?: number): Promise<void> {
	const api = browser as unknown as SidebarApi;
	if (api.sidePanel) {
		let targetWindowId = windowId;
		if (targetWindowId === undefined) {
			const active = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
			targetWindowId = active?.windowId;
		}
		if (targetWindowId !== undefined) {
			await api.sidePanel.open({ windowId: targetWindowId });
			return;
		}
	}
	if (api.sidebarAction) {
		await api.sidebarAction.open();
		return;
	}
	await browser.tabs.create({ url: browser.runtime.getURL("/linkManager.html"), active: true });
}

export default defineBackground(main);
