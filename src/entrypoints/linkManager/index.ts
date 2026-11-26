import { browser } from "wxt/browser";
import type {
	LinkManagerDuplicateAction,
	LinkManagerItem,
	LinkManagerQueueMode,
	LinkManagerReadStatus,
	LinkManagerState,
	LinkManagerTabDuplicate,
	LinkManagerViewMode
} from "@/assets/js/types/LinkManager";
import type {
	LinkManagerInspectDuplicatesResponse,
	LinkManagerMessage
} from "@/assets/js/types/Messages";

type ManagerResponse = {
	readonly ok: boolean;
	readonly state?: LinkManagerState;
	readonly duplicates?: Record<string, LinkManagerTabDuplicate[]>;
	readonly error?: string;
};

const $ = <T extends HTMLElement>(selector: string): T => {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error("Missing Link Manager UI element: " + selector);
	}
	return element;
};

let state: LinkManagerState | null = null;
let visibleIds: string[] = [];
let selectedIds = new Set<string>();
let anchorId: string | null = null;

async function send(message: LinkManagerMessage): Promise<ManagerResponse> {
	const response = await browser.runtime.sendMessage(message) as ManagerResponse | undefined;
	if (!response?.ok) {
		throw new Error(response?.error || "The Link Manager operation failed.");
	}
	return response;
}

async function refresh(): Promise<void> {
	const response = await send({ message: "linkManagerGetState" });
	if (!response.state) {
		throw new Error("The background service did not return Link Manager state.");
	}
	state = response.state;
	render();
}

function parseLinks(raw: string): { url: string; title: string }[] {
	const parsed: { url: string; title: string }[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const value = line.trim();
		if (!value) {
			continue;
		}
		const tabIndex = value.indexOf("\t");
		const title = tabIndex > 0 ? value.slice(0, tabIndex).trim() : value;
		const url = tabIndex > 0 ? value.slice(tabIndex + 1).trim() : value;
		try {
			const parsedUrl = new URL(url);
			if ([ "http:", "https:", "ftp:", "file:" ].includes(parsedUrl.protocol)) {
				parsed.push({ url: parsedUrl.href, title: title || parsedUrl.href });
			}
		} catch {
			// Invalid lines are ignored; the user receives a count/status after parsing.
		}
	}
	return parsed;
}

function normalizeUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return [ "http:", "https:", "ftp:", "file:" ].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

async function askDuplicate(
	url: string,
	matches: readonly LinkManagerTabDuplicate[]
): Promise<LinkManagerDuplicateAction | null> {
	const dialog = $("#duplicate-dialog") as HTMLDialogElement;
	const description = $("#duplicate-description");
	const select = $("#duplicate-tab-select") as HTMLSelectElement;
	description.textContent = "Link Manager found " + matches.length + " matching tab(s) for " + url
		+ ". Activating a tab leaves it outside Link Manager's ownership. Replacing it closes only the selected tab.";
	select.replaceChildren();
	const preferred = matches.find((tab) => tab.active) ?? matches[0];
	for (const match of matches) {
		const option = document.createElement("option");
		option.value = String(match.id);
		option.textContent = (match.active ? "Active · " : "")
			+ (match.managed ? "Link Manager · " : "")
			+ match.title
			+ " · Window " + match.windowId
			+ " · Tab " + match.id;
		if (match.id === preferred?.id) {
			option.selected = true;
		}
		select.appendChild(option);
	}

	if (typeof dialog.showModal !== "function") {
		const useExisting = window.confirm("This URL is already open. OK activates the existing tab; Cancel closes it and opens a managed replacement.");
		const tab = preferred;
		if (!tab) {
			return null;
		}
		return { url, tabId: tab.id, action: useExisting ? "activate" : "replace" };
	}

	return new Promise((resolve) => {
		const finish = (action: string): void => {
			dialog.removeEventListener("close", onClose);
			const tabId = Number(select.value);
			const valid = matches.some((tab) => tab.id === tabId);
			if ((action === "activate" || action === "replace") && valid) {
				resolve({ url, tabId, action });
			} else {
				resolve(null);
			}
		};
		const onClose = (): void => finish(dialog.returnValue);
		dialog.addEventListener("close", onClose, { once: true });
		dialog.showModal();
	});
}

async function addLinks(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const raw = ($("#links-input") as HTMLTextAreaElement).value;
	const urls = parseLinks(raw);
	if (urls.length === 0) {
		setStatus("No valid HTTP, HTTPS, FTP, or file URLs were found. Use one URL per line.");
		return;
	}

	try {
		const inspected = await send({ message: "linkManagerInspectDuplicates", urls });
		const duplicateResponse = inspected as LinkManagerInspectDuplicatesResponse & ManagerResponse;
		const duplicates = duplicateResponse.duplicates ?? {};
		const decisions: LinkManagerDuplicateAction[] = [];
		const accepted: { url: string; title: string }[] = [];

		for (const item of urls) {
			const normalized = normalizeUrl(item.url);
			if (!normalized) {
				continue;
			}
			const matches = duplicates[normalized];
			if (!matches || matches.length === 0) {
				accepted.push(item);
				continue;
			}
			const decision = await askDuplicate(normalized, matches);
			if (decision) {
				decisions.push(decision);
				accepted.push(item);
			}
		}

		if (accepted.length === 0) {
			setStatus("No links were added.");
			return;
		}

		const response = await send({
			message: "linkManagerAddLinks",
			request: {
				urls: accepted,
				listId: ($("#list-select") as HTMLSelectElement).value,
				duplicateActions: decisions
			}
		});
		state = response.state ?? state;
		($("#links-input") as HTMLTextAreaElement).value = "";
		render();
		setStatus("Added " + accepted.length + " link(s).");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
		await refresh().catch(() => undefined);
	}
}

function setStatus(message: string): void {
	$("#status").textContent = message;
}

function statusLabel(item: LinkManagerItem): string {
	const read = item.readStatus === "read" ? "Read" : item.readStatus === "viewed" ? "Viewed" : "Unread";
	const queue: Record<string, string> = {
		queued: "Queued",
		opening: "Opening",
		staged: "Deferred tab",
		opened: "Open",
		suspended: "Suspended",
		external: "Existing tab (not managed)",
		closed: "Closed"
	};
	return read + " · " + (queue[item.queueStatus] ?? item.queueStatus);
}

function getListName(listId: string): string {
	return state?.lists.find((list) => list.id === listId)?.name ?? "Unknown collection";
}

function createItemRow(item: LinkManagerItem): HTMLElement {
	const row = document.createElement("div");
	row.className = "item";
	row.tabIndex = 0;
	row.setAttribute("role", "option");
	row.setAttribute("aria-selected", String(selectedIds.has(item.id)));
	row.dataset.itemId = item.id;

	const content = document.createElement("div");
	const title = document.createElement("span");
	title.className = "item-title";
	title.textContent = item.title || item.url;
	const url = document.createElement("span");
	url.className = "item-url";
	url.textContent = item.url;
	const meta = document.createElement("span");
	meta.className = "item-meta";
	meta.textContent = statusLabel(item) + " · " + getListName(item.listId)
		+ (item.batchId ? " · " + item.batchId : "");
	content.append(title, url, meta);

	const actions = document.createElement("div");
	actions.className = "item-actions";
	const open = document.createElement("button");
	open.type = "button";
	open.textContent = item.tabId === null ? "Open" : "Activate";
	open.addEventListener("click", (event) => {
		event.stopPropagation();
		void runAction(() => send({ message: "linkManagerOpenItem", itemId: item.id }));
	});
	const read = document.createElement("button");
	read.type = "button";
	read.textContent = item.readStatus === "read" ? "Mark unread" : "Mark read";
	read.addEventListener("click", (event) => {
		event.stopPropagation();
		const next: LinkManagerReadStatus = item.readStatus === "read" ? "unread" : "read";
		void runAction(() => send({ message: "linkManagerSetReadStatus", itemId: item.id, readStatus: next }));
	});
	actions.append(open, read);
	row.append(content, actions);

	row.addEventListener("click", (event: MouseEvent) => {
		if (state?.openOnSingleClick && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			selectedIds = new Set([ item.id ]);
			anchorId = item.id;
			render();
			// A double-click emits a second click with detail=2; the first click has
			// already opened the link, so avoid a duplicate command.
			if (event.detail <= 1) {
				void runAction(() => send({ message: "linkManagerOpenItem", itemId: item.id }));
			}
			return;
		}
		selectRow(item.id, event);
	});
	row.addEventListener("dblclick", () => {
		if (!state?.openOnSingleClick) {
			void runAction(() => send({ message: "linkManagerOpenItem", itemId: item.id }));
		}
	});
	row.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void runAction(() => send({ message: "linkManagerOpenItem", itemId: item.id }));
		}
	});
	return row;
}

function selectRow(itemId: string, event: MouseEvent): void {
	const index = visibleIds.indexOf(itemId);
	if (index < 0) {
		return;
	}
	const additive = event.ctrlKey || event.metaKey;
	if (event.shiftKey && anchorId !== null) {
		const anchorIndex = visibleIds.indexOf(anchorId);
		if (anchorIndex >= 0) {
			if (!additive) {
				selectedIds.clear();
			}
			const start = Math.min(anchorIndex, index);
			const end = Math.max(anchorIndex, index);
			for (const id of visibleIds.slice(start, end + 1)) {
				selectedIds.add(id);
			}
		} else {
			selectedIds = new Set([ itemId ]);
			anchorId = itemId;
		}
	} else if (additive) {
		if (selectedIds.has(itemId)) {
			selectedIds.delete(itemId);
		} else {
			selectedIds.add(itemId);
		}
		anchorId = itemId;
	} else {
		selectedIds = new Set([ itemId ]);
		anchorId = itemId;
	}
	paintSelection();
}

function paintSelection(): void {
	for (const row of document.querySelectorAll<HTMLElement>(".item[data-item-id]")) {
		row.setAttribute("aria-selected", String(selectedIds.has(row.dataset.itemId ?? "")));
	}
	const hasSelection = selectedIds.size > 0;
	($("#mark-read") as HTMLButtonElement).disabled = !hasSelection;
	($("#mark-unread") as HTMLButtonElement).disabled = !hasSelection;
	($("#remove-selected") as HTMLButtonElement).disabled = !hasSelection;
	($("#clear-selection") as HTMLButtonElement).disabled = !hasSelection;
}

async function runAction(action: () => Promise<ManagerResponse>): Promise<void> {
	try {
		const response = await action();
		state = response.state ?? state;
		render();
		setStatus("");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
	}
}

function render(): void {
	if (!state) {
		return;
	}
	const mode = $("#mode") as HTMLSelectElement;
	const viewMode = $("#view-mode") as HTMLSelectElement;
	const batchSize = $("#batch-size") as HTMLInputElement;
	const singleClickOpen = $("#single-click-open") as HTMLInputElement;
	const listSelect = $("#list-select") as HTMLSelectElement;
	const pause = $("#pause") as HTMLButtonElement;
	const stage = $("#stage") as HTMLButtonElement;
	mode.value = state.mode;
	viewMode.value = state.viewMode;
	batchSize.value = String(state.batchSize);
	singleClickOpen.checked = state.openOnSingleClick;
	pause.textContent = state.paused ? "Resume" : "Pause";
	stage.disabled = state.paused;
	stage.textContent = state.mode === "manual" ? "Stage next batch" : "Stage / Replenish";

	listSelect.replaceChildren();
	for (const list of state.lists) {
		const option = document.createElement("option");
		option.value = list.id;
		option.textContent = list.name;
		option.selected = list.id === state.activeListId;
		listSelect.appendChild(option);
	}

	const items = [ ...state.items ].sort((a, b) => a.order - b.order);
	const root = $("#items");
	root.replaceChildren();
	const grouped = state.viewMode === "collections";
	const displayItems = grouped
		? state.lists.flatMap((list) => items.filter((item) => item.listId === list.id))
		: items;
	visibleIds = displayItems.map((item) => item.id);
	selectedIds = new Set([ ...selectedIds ].filter((id) => visibleIds.includes(id)));
	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = state.paused
			? "Link Manager is paused. Add links here; they will wait until resumed."
			: "No saved links yet. Paste URLs above to create your first queue.";
		root.appendChild(empty);
	} else if (grouped) {
		for (const list of state.lists) {
			const groupItems = items.filter((item) => item.listId === list.id);
			if (groupItems.length === 0) {
				continue;
			}
			const heading = document.createElement("div");
			heading.className = "collection-heading";
			heading.textContent = list.name + " (" + groupItems.length + ")";
			root.appendChild(heading);
			for (const item of groupItems) {
				root.appendChild(createItemRow(item));
			}
		}
	} else {
		for (const item of items) {
			root.appendChild(createItemRow(item));
		}
	}

	const openCount = items.filter((item) => item.managed && item.tabId !== null).length;
	const unreadCount = items.filter((item) => item.readStatus === "unread").length;
	const viewedCount = items.filter((item) => item.readStatus === "viewed").length;
	const readCount = items.filter((item) => item.readStatus === "read").length;
	$("#counts").textContent = items.length + " links · " + openCount + " managed tabs · "
		+ unreadCount + " unread · " + viewedCount + " viewed · " + readCount + " read";
	$("#mode-status").textContent = state.paused ? "Paused" : "Running";

	const hasSelection = selectedIds.size > 0;
	($("#mark-read") as HTMLButtonElement).disabled = !hasSelection;
	($("#mark-unread") as HTMLButtonElement).disabled = !hasSelection;
	($("#remove-selected") as HTMLButtonElement).disabled = !hasSelection;
	($("#clear-selection") as HTMLButtonElement).disabled = !hasSelection;
}

async function markSelected(readStatus: LinkManagerReadStatus): Promise<void> {
	for (const id of selectedIds) {
		await send({ message: "linkManagerSetReadStatus", itemId: id, readStatus });
	}
	selectedIds.clear();
	await refresh();
}

async function removeSelected(): Promise<void> {
	const ids = [ ...selectedIds ];
	for (const id of ids) {
		await send({ message: "linkManagerRemoveItem", itemId: id });
	}
	selectedIds.clear();
	await refresh();
}

$("#add-form").addEventListener("submit", (event) => {
	void addLinks(event as SubmitEvent);
});
$("#pause").addEventListener("click", () => {
	void runAction(() => send({ message: "linkManagerTogglePause" }));
});
$("#stage").addEventListener("click", () => {
	void runAction(() => send({ message: "linkManagerStageNext" }));
});
$("#mode").addEventListener("change", () => {
	const mode = ($("#mode") as HTMLSelectElement).value as LinkManagerQueueMode;
	void runAction(() => send({ message: "linkManagerSetMode", mode }));
});
$("#view-mode").addEventListener("change", () => {
	const viewMode = ($("#view-mode") as HTMLSelectElement).value as LinkManagerViewMode;
	void runAction(() => send({ message: "linkManagerSetViewMode", viewMode }));
});
$("#batch-size").addEventListener("change", () => {
	const value = Number(($("#batch-size") as HTMLInputElement).value);
	if (!Number.isInteger(value) || value < 1 || value > 50) {
		setStatus("Batch size must be an integer from 1 to 50.");
		void refresh();
		return;
	}
	void runAction(() => send({ message: "linkManagerSetBatchSize", batchSize: value }));
});
$("#single-click-open").addEventListener("change", () => {
	const enabled = ($("#single-click-open") as HTMLInputElement).checked;
	void runAction(() => send({ message: "linkManagerSetOpenOnSingleClick", enabled }));
});
$("#list-select").addEventListener("change", () => {
	const listId = ($("#list-select") as HTMLSelectElement).value;
	void runAction(() => send({ message: "linkManagerSetActiveList", listId }));
});
$("#add-list").addEventListener("click", () => {
	const name = window.prompt("Name this collection:");
	if (name?.trim()) {
		void runAction(() => send({ message: "linkManagerAddList", name }));
	}
});
$("#settings").addEventListener("click", () => {
	void browser.runtime.openOptionsPage();
});
$("#mark-read").addEventListener("click", () => void markSelected("read").catch((error: unknown) => setStatus(String(error))));
$("#mark-unread").addEventListener("click", () => void markSelected("unread").catch((error: unknown) => setStatus(String(error))));
$("#remove-selected").addEventListener("click", () => void removeSelected().catch((error: unknown) => setStatus(String(error))));
$("#clear-selection").addEventListener("click", () => {
	selectedIds.clear();
	anchorId = null;
	render();
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
		const target = event.target;
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
			return;
		}
		event.preventDefault();
		selectedIds = new Set(visibleIds);
		anchorId = visibleIds[0] ?? null;
		paintSelection();
	} else if (event.key === "Escape") {
		selectedIds.clear();
		anchorId = null;
		paintSelection();
	}
});

void refresh().catch((error: unknown) => {
	setStatus(error instanceof Error ? error.message : String(error));
});
