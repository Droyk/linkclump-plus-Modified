import { browser } from "wxt/browser";
import { LAZY_TAB_ENTRY_PREFIX, type PendingLazyTab } from "@/entrypoints/background/queue/LazyTabManager";

async function renderDeferredDestination(): Promise<void> {
	const token = new URL(window.location.href).searchParams.get("token");
	const titleElement = document.getElementById("title");
	const messageElement = document.getElementById("message");
	const destinationElement = document.getElementById("destination");
	const loadLink = document.getElementById("load-link") as HTMLAnchorElement | null;

	if (!token || !titleElement || !messageElement || !destinationElement || !loadLink) {
		return;
	}

	const key = LAZY_TAB_ENTRY_PREFIX + token;
	const stored = await browser.storage.local.get(key);
	const entry = stored[key] as PendingLazyTab | undefined;
	if (!entry || typeof entry.url !== "string") {
		titleElement.textContent = "Deferred destination unavailable";
		messageElement.textContent = "This placeholder no longer has a pending destination. You can close this tab.";
		return;
	}

	document.title = "Deferred: " + entry.title;
	titleElement.textContent = entry.title || "Deferred destination";
	messageElement.textContent = "This destination has not been requested yet. It will load automatically when this tab is activated.";
	destinationElement.textContent = entry.url;
	loadLink.href = entry.url;
	loadLink.textContent = "Load destination now";
	loadLink.hidden = false;
}

void renderDeferredDestination().catch((error: unknown) => {
	console.error("[lazyTab] Failed to display deferred destination:", error);
});
