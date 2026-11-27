import { browser } from "wxt/browser";
import type {
	LinkManagerDuplicateAction,
	LinkManagerItem,
	LinkManagerOwnership,
	LinkManagerReadStatus,
	LinkManagerSessionPreferences,
	LinkManagerState,
	LinkManagerTabDuplicate,
	LinkManagerViewMode,
	LinkManagerWindowPolicy
} from "@/assets/js/types/LinkManager";
import type { LinkManagerMessage } from "@/assets/js/types/Messages";

type ManagerResponse = {
	readonly ok: boolean;
	readonly state?: LinkManagerState;
	readonly duplicates?: Record<string, LinkManagerTabDuplicate[]>;
	readonly sessionPreferences?: LinkManagerSessionPreferences;
	readonly error?: string;
};

type DuplicateResolutionResult = {
	readonly accepted: readonly { url: string; title: string }[];
	readonly decisions: readonly LinkManagerDuplicateAction[];
};

const $ = <T extends HTMLElement>(selector: string): T => {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error("Missing Link Manager UI element: " + selector);
	}
	return element;
};

let state: LinkManagerState | null = null;
let currentWindowId = -1;
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

async function resolveWindowId(): Promise<number> {
	const current = await browser.windows.getCurrent();
	if (Number.isInteger(current.id)) {
		return current.id!;
	}
	const active = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
	if (active?.windowId !== undefined) {
		return active.windowId;
	}
	throw new Error("Could not determine the browser window for this Link Manager queue.");
}

async function refresh(): Promise<void> {
	currentWindowId = await resolveWindowId();
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
			// Invalid lines are ignored; valid lines are processed normally.
		}
	}
	return parsed;
}

function normalizeUrl(value: string): string | null {
	try {
		const parsed = new URL(value);
		return [ "http:", "https:", "ftp:", "file:" ].includes(parsed.protocol) ? parsed.href : null;
	} catch {
		return null;
	}
}

function askDuplicate(
	url: string,
	matches: readonly LinkManagerTabDuplicate[],
	defaultOwnership: LinkManagerOwnership,
	sessionPreferences: LinkManagerSessionPreferences
): Promise<LinkManagerDuplicateAction | null> {
	const dialog = $("#duplicate-dialog") as HTMLDialogElement;
	const description = $("#duplicate-description");
	const rows = $("#duplicate-tabs");
	const ownership = $("#duplicate-ownership") as HTMLSelectElement;
	const rememberResolution = $("#remember-resolution") as HTMLInputElement;
	const rememberOwnership = $("#remember-ownership") as HTMLInputElement;
	const applyCustom = $("#apply-custom") as HTMLButtonElement;
	const preferred = matches.find((tab) => tab.active) ?? matches[0];

	description.textContent = matches.length + " matching tab(s) were found for " + url
		+ ". Pick one for activation and independently check any tabs to close.";
	ownership.value = sessionPreferences.ownership ?? defaultOwnership;
	rememberResolution.checked = false;
	rememberOwnership.checked = false;
	rows.replaceChildren();

	for (const match of matches) {
		const row = document.createElement("div");
		row.className = "duplicate-row";
		const descriptionCell = document.createElement("div");
		const title = document.createElement("span");
		title.className = "duplicate-title";
		title.textContent = match.title || match.url;
		const meta = document.createElement("span");
		meta.className = "duplicate-meta";
		meta.textContent = (match.active ? "Active tab · " : "")
			+ (match.managed ? "Managed · " : "")
			+ (match.tracked ? "Already tracked · " : "")
			+ "Window " + match.windowId + " · Position " + (match.index + 1);
		descriptionCell.append(title, meta);

		const controls = document.createElement("div");
		controls.className = "duplicate-controls";
		const activateLabel = document.createElement("label");
		const activate = document.createElement("input");
		activate.type = "radio";
		activate.name = "duplicate-activate-tab";
		activate.value = String(match.id);
		activate.checked = match.id === preferred?.id;
		activateLabel.append(activate, document.createTextNode("Activate"));

		const closeLabel = document.createElement("label");
		const close = document.createElement("input");
		close.type = "checkbox";
		close.name = "duplicate-close-tab";
		close.value = String(match.id);
		close.disabled = activate.checked;
		closeLabel.append(close, document.createTextNode("Close"));
		activate.addEventListener("change", () => {
			for (const checkbox of rows.querySelectorAll<HTMLInputElement>("input[name='duplicate-close-tab']")) {
				checkbox.disabled = checkbox.value === activate.value;
				if (checkbox.disabled) {
					checkbox.checked = false;
				}
			}
		});
		controls.append(activateLabel, closeLabel);
		row.append(descriptionCell, controls);
		rows.appendChild(row);
	}

	applyCustom.disabled = matches.length === 0;
	return new Promise((resolve) => {
		const closeWith = (value: string): void => dialog.close(value);
		applyCustom.onclick = () => closeWith("custom");
		($("#replace-all") as HTMLButtonElement).onclick = () => closeWith("replace");
		($("#open-duplicate") as HTMLButtonElement).onclick = () => closeWith("duplicate");
		($("#cancel-duplicate") as HTMLButtonElement).onclick = () => closeWith("cancel");

		dialog.addEventListener("close", () => {
			const action = dialog.returnValue;
			if (action === "cancel" || !action) {
				resolve(null);
				return;
			}
			const activateTabId = Number(rows.querySelector<HTMLInputElement>("input[name='duplicate-activate-tab']:checked")?.value);
			const closeTabIds = [ ...rows.querySelectorAll<HTMLInputElement>("input[name='duplicate-close-tab']:checked") ]
				.map((input) => Number(input.value));
			if (action === "replace" || action === "duplicate") {
				resolve({
					url,
					action,
					closeTabIds: action === "replace" ? matches.map((tab) => tab.id) : [],
					rememberResolution: rememberResolution.checked
				});
				return;
			}
			if (!Number.isInteger(activateTabId) || !matches.some((tab) => tab.id === activateTabId)) {
				resolve(null);
				return;
			}
			resolve({
				url,
				action: closeTabIds.length > 0 ? "custom" : "activate",
				activateTabId,
				closeTabIds,
				ownership: ownership.value === "managed" ? "managed" : "borrowed",
				rememberResolution: rememberResolution.checked,
				rememberOwnership: rememberOwnership.checked
			});
		}, { once: true });

		if (typeof dialog.showModal === "function") {
			dialog.showModal();
		} else {
			resolve({
				url,
				action: "activate",
				activateTabId: preferred?.id ?? matches[0]!.id,
				ownership: defaultOwnership
			});
		}
	});
}

async function resolveDuplicateChoices(
	urls: readonly { url: string; title: string }[],
	excludeTracked = false
): Promise<DuplicateResolutionResult> {
	const inspected = await send({
		message: "linkManagerInspectDuplicates",
		urls,
		queueWindowId: currentWindowId
	});
	const duplicates = inspected.duplicates ?? {};
	const sessionPreferences = inspected.sessionPreferences ?? { duplicateResolution: null, ownership: null };
	const decisions: LinkManagerDuplicateAction[] = [];
	const accepted: { url: string; title: string }[] = [];

	for (const item of urls) {
		const normalized = normalizeUrl(item.url);
		if (!normalized) {
			continue;
		}
		const allMatches = duplicates[normalized] ?? [];
		const matches = excludeTracked ? allMatches.filter((match) => !match.tracked) : allMatches;
		if (matches.length === 0 || sessionPreferences.duplicateResolution !== null) {
			accepted.push(item);
			continue;
		}
		const decision = await askDuplicate(
			normalized,
			matches,
			state?.defaultOwnership ?? "borrowed",
			sessionPreferences
		);
		if (decision) {
			decisions.push(decision);
			accepted.push(item);
		}
	}
	return { accepted, decisions };
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
		const { accepted, decisions } = await resolveDuplicateChoices(urls);
		if (accepted.length === 0) {
			setStatus("No links were added.");
			return;
		}
		const response = await send({
			message: "linkManagerAddLinks",
			request: {
				urls: accepted,
				listId: ($("#list-select") as HTMLSelectElement).value,
				queueWindowId: currentWindowId,
				duplicateActions: decisions
			}
		});
		state = response.state ?? state;
		($("#links-input") as HTMLTextAreaElement).value = "";
		render();
		setStatus("Processed " + accepted.length + " link(s).");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
		await refresh().catch(() => undefined);
	}
}

function setStatus(message: string): void {
	$("#status").textContent = message;
}

function getListName(listId: string): string {
	return state?.lists.find((list) => list.id === listId)?.name ?? "Unknown collection";
}

function statusLabel(item: LinkManagerItem): string {
	const read = item.readStatus === "read" ? "Read" : "Unread";
	const queue = item.status === "open" ? "Open" : item.status === "queued" ? "Queued" : "Closed";
	const owner = item.ownership === "managed" ? "Managed" : item.ownership === "borrowed" ? "Borrowed" : "Not open";
	return read + " · " + queue + " · " + owner + " · Window " + item.queueWindowId;
}


function render(): void {
	if (!state) {
		return;
	}
	($("#view-mode") as HTMLSelectElement).value = state.viewMode;
	($("#default-ownership") as HTMLSelectElement).value = state.defaultOwnership;
	($("#window-policy") as HTMLSelectElement).value = state.windowPolicy;
	($("#single-click-open") as HTMLInputElement).checked = state.openOnSingleClick;
	($("#pause") as HTMLButtonElement).textContent = state.paused ? "Resume" : "Pause";
	($("#open-selected") as HTMLButtonElement).disabled = selectedIds.size === 0;

	const listSelect = $("#list-select") as HTMLSelectElement;
	listSelect.replaceChildren();
	for (const list of state.lists) {
		const option = document.createElement("option");
		option.value = list.id;
		option.textContent = list.name;
		option.selected = list.id === state.activeListId;
		listSelect.appendChild(option);
	}

	const items = state.items.filter((item) => item.queueWindowId === currentWindowId)
		.sort((a, b) => a.order - b.order);
	const grouped = state.viewMode === "collections";
	const displayItems = grouped
		? state.lists.flatMap((list) => items.filter((item) => item.listId === list.id))
		: items;
	visibleIds = displayItems.map((item) => item.id);
	selectedIds = new Set([ ...selectedIds ].filter((id) => visibleIds.includes(id)));

	const root = $("#items");
	root.replaceChildren();
	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = state.paused
			? "Link Manager is paused. New links will wait until resumed."
			: "No links in this window's queue yet. Paste URLs above to begin.";
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

	const openCount = items.filter((item) => item.status === "open").length;
	const unreadCount = items.filter((item) => item.readStatus === "unread").length;
	const readCount = items.filter((item) => item.readStatus === "read").length;
	$("#counts").textContent = items.length + " links · " + openCount + " open queue tabs · "
		+ unreadCount + " unread · " + readCount + " read";
	$("#queue-status").textContent = state.paused ? "Paused" : "Running";
	paintSelection();
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
	title.className = item.readStatus === "read" ? "item-title read" : "item-title";
	title.textContent = item.title || item.url;
	const url = document.createElement("span");
	url.className = "item-url";
	url.textContent = item.url;
	const meta = document.createElement("span");
	meta.className = "item-meta";
	meta.textContent = statusLabel(item) + " · " + getListName(item.listId);
	content.append(title, url, meta);

	const actions = document.createElement("div");
	actions.className = "item-actions";
	const open = document.createElement("button");
	open.type = "button";
	open.textContent = item.status === "open" ? "Activate" : "Open";
	open.addEventListener("click", (event) => {
		event.stopPropagation();
		selectedIds = new Set([ item.id ]);
		void openSelected();
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
			if (event.detail <= 1) {
				void openSelected();
			}
			return;
		}
		selectRow(item.id, event);
	});
	row.addEventListener("dblclick", () => {
		if (!state?.openOnSingleClick) {
			selectedIds = new Set([ item.id ]);
			void openSelected();
		}
	});
	row.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			selectedIds = new Set([ item.id ]);
			void openSelected();
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
			for (const id of visibleIds.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)) {
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
	($("#open-selected") as HTMLButtonElement).disabled = !hasSelection;
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

async function openSelected(): Promise<void> {
	if (!state || selectedIds.size === 0) {
		return;
	}
	try {
		const selected = [ ...selectedIds ]
			.map((id) => state!.items.find((item) => item.id === id))
			.filter((item): item is LinkManagerItem => item !== undefined && item.queueWindowId === currentWindowId);
		if (selected.length === 0) {
			return;
		}
		const liveTabs = await browser.tabs.query({});
		const liveTabIds = new Set(liveTabs.map((tab) => tab.id).filter((id): id is number => id !== undefined));
		const needsReconciliation = selected.filter((item) => item.tabId === null || !liveTabIds.has(item.tabId));
		const choices = needsReconciliation.length > 0
			? await resolveDuplicateChoices(needsReconciliation.map((item) => ({ url: item.url, title: item.title })), true)
			: { accepted: [], decisions: [] };
		const acceptedUrls = new Set(choices.accepted.map((item) => normalizeUrl(item.url)).filter((url): url is string => url !== null));
		const itemIds = selected
			.filter((item) => item.tabId !== null && liveTabIds.has(item.tabId) || acceptedUrls.has(item.url))
			.map((item) => item.id);
		if (itemIds.length === 0) {
			setStatus("No selected links were opened.");
			return;
		}
		const response = await send({
			message: "linkManagerOpenSelected",
			itemIds,
			queueWindowId: currentWindowId,
			duplicateActions: choices.decisions
		});
		state = response.state ?? state;
		render();
		setStatus("Opened " + itemIds.length + " selected link(s); the first is active and the rest are in the background.");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
		await refresh().catch(() => undefined);
	}
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
$("#open-selected").addEventListener("click", () => void openSelected());
$("#view-mode").addEventListener("change", () => {
	const viewMode = ($("#view-mode") as HTMLSelectElement).value as LinkManagerViewMode;
	void runAction(() => send({ message: "linkManagerSetViewMode", viewMode }));
});
$("#single-click-open").addEventListener("change", () => {
	const enabled = ($("#single-click-open") as HTMLInputElement).checked;
	void runAction(() => send({ message: "linkManagerSetOpenOnSingleClick", enabled }));
});
$("#default-ownership").addEventListener("change", () => {
	const ownership = ($("#default-ownership") as HTMLSelectElement).value as LinkManagerOwnership;
	void runAction(() => send({ message: "linkManagerSetDefaultOwnership", ownership }));
});
$("#window-policy").addEventListener("change", () => {
	const policy = ($("#window-policy") as HTMLSelectElement).value as LinkManagerWindowPolicy;
	void runAction(() => send({ message: "linkManagerSetWindowPolicy", policy }));
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
