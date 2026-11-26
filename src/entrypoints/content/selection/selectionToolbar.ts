import { browser } from "wxt/browser";
import { safeAsync } from "@/assets/js/lib/safeAsync";
import type { ActivateMessage, CreateLazyTabsMessage } from "@/assets/js/types/Messages";
import type { LinkSelectionStore } from "./LinkSelectionStore";

const HOST_ID = "linkclump-selection-manager";
const STYLE_ID = "linkclump-selection-highlight-style";
const SELECTED_CLASS = "linkclump-selected-link";

let host: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
const activeHighlights = new Map<string, { element: HTMLElement; hadClass: boolean }>();

/** Creates the isolated floating manager and subscribes it to the page's selection store. */
export function createSelectionToolbar(store: LinkSelectionStore): void {
	if (host) {
		return;
	}

	host = document.createElement("div");
	host.id = HOST_ID;
	host.setAttribute("aria-label", "Linkclump link collection");

	const shadow = host.attachShadow({ mode: "open" });
	shadow.innerHTML = [
		"<style>",
		":host { all: initial; }",
		".panel { position:fixed; right:16px; bottom:16px; z-index:2147483647; width:min(360px,calc(100vw - 32px)); max-height:min(58vh,520px); display:flex; flex-direction:column; overflow:hidden; color:#202124; background:#fff; border:1px solid #c8cdd2; border-radius:10px; box-shadow:0 5px 24px rgba(0,0,0,.24); font:13px/1.4 Arial,sans-serif; color-scheme:light; }",
		"header, footer { display:flex; align-items:center; gap:6px; padding:9px 10px; }",
		"header { justify-content:space-between; border-bottom:1px solid #e1e4e8; }",
		"header strong { font-size:14px; }",
		"#count { color:#5f6368; font-weight:normal; }",
		"#rows { overflow:auto; min-height:0; padding:4px 10px; }",
		".row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:7px 0; border-bottom:1px solid #edf0f2; }",
		".row:last-child { border-bottom:0; }",
		".row { cursor:grab; }",
		".row.dragging { opacity:.4; }",
		".row.drop-target { outline:2px dashed #2563eb; outline-offset:-2px; }",
		".controls { display:flex; align-items:center; gap:3px; }",
		".controls button { padding:3px 6px; }",
		".drag-handle { color:#777; user-select:none; padding:0 2px; cursor:grab; }",
		".title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }",
		".url { display:block; overflow-wrap:anywhere; color:#5f6368; font-size:11px; }",
		".empty { color:#5f6368; padding:12px 2px; }",
		"footer { border-top:1px solid #e1e4e8; flex-wrap:wrap; }",
		"button { appearance:none; border:1px solid #c6cbd0; border-radius:6px; background:#f8f9fa; color:#202124; padding:6px 9px; font:inherit; cursor:pointer; }",
		"button:hover { background:#eef1f4; }",
		"button:disabled { opacity:.45; cursor:default; }",
		"button.primary { background:#e8f0fe; border-color:#b7c9ec; }",
		"button.remove { padding:3px 7px; align-self:center; }",
		"#collapse { padding:2px 7px; }",
		".panel.collapsed #rows, .panel.collapsed footer { display:none; }",
		"</style>",
		"<section class=\"panel\" role=\"region\" aria-label=\"Selected links\">",
		"<header><strong>Link collection <span id=\"count\">(0)</span></strong><button id=\"collapse\" type=\"button\" aria-expanded=\"true\" title=\"Collapse collection\">−</button></header>",
		"<div id=\"rows\" aria-live=\"polite\"></div>",
		"<footer><button id=\"copy\" type=\"button\" class=\"primary\">Copy URLs</button><button id=\"copy-json\" type=\"button\">Copy JSON</button><button id=\"open\" type=\"button\">Open tabs</button><button id=\"lazy\" type=\"button\" title=\"Create placeholder tabs; each destination loads only when activated\">Deferred tabs</button><label for=\"lazy-delay\">Gap (seconds)</label><input id=\"lazy-delay\" type=\"number\" min=\"0\" max=\"30\" step=\"0.5\" value=\"0\" /><button id=\"bookmark\" type=\"button\">Bookmark</button><button id=\"deduplicate\" type=\"button\">Remove duplicates</button><button id=\"clear\" type=\"button\">Clear</button></footer>",
		"</section>"
	].join("");

	document.documentElement.appendChild(host);
	installHighlightStyle();

	const panel = shadow.querySelector<HTMLElement>(".panel");
	const rows = shadow.querySelector<HTMLElement>("#rows");
	const count = shadow.querySelector<HTMLElement>("#count");
	const copy = shadow.querySelector<HTMLButtonElement>("#copy");
	const copyJson = shadow.querySelector<HTMLButtonElement>("#copy-json");
	const open = shadow.querySelector<HTMLButtonElement>("#open");
	const lazy = shadow.querySelector<HTMLButtonElement>("#lazy");
	const lazyDelay = shadow.querySelector<HTMLInputElement>("#lazy-delay");
	const bookmark = shadow.querySelector<HTMLButtonElement>("#bookmark");
	const deduplicate = shadow.querySelector<HTMLButtonElement>("#deduplicate");
	const clear = shadow.querySelector<HTMLButtonElement>("#clear");
	const collapse = shadow.querySelector<HTMLButtonElement>("#collapse");

	copy?.addEventListener("click", () => runAction(store, "copy"));
	copyJson?.addEventListener("click", () => runAction(store, "copy-json"));
	open?.addEventListener("click", () => runAction(store, "tabs"));
	lazy?.addEventListener("click", () => startLazyTabs(store, lazyDelay));
	bookmark?.addEventListener("click", () => runAction(store, "bm"));
	deduplicate?.addEventListener("click", () => removeDuplicateEntries(store));
	clear?.addEventListener("click", () => store.clear());
	collapse?.addEventListener("click", () => {
		if (!panel || !collapse) {
			return;
		}
		const collapsed = panel.classList.toggle("collapsed");
		collapse.textContent = collapsed ? "+" : "−";
		collapse.setAttribute("aria-expanded", String(!collapsed));
		collapse.title = collapsed ? "Expand collection" : "Collapse collection";
	});

	const render = (): void => {
		if (!rows || !count || !copy || !copyJson || !open || !lazy || !bookmark || !deduplicate || !clear) {
			return;
		}

		const entries = store.getEntries();
		count.textContent = "(" + entries.length + ")";
		copy.disabled = entries.length === 0;
		copyJson.disabled = entries.length === 0;
		open.disabled = entries.length === 0;
		lazy.disabled = entries.length === 0;
		bookmark.disabled = entries.length === 0;
		deduplicate.disabled = entries.length < 2;
		clear.disabled = entries.length === 0;

		const liveIds = new Set(entries.map((entry) => entry.id));
		for (const [ id, highlight ] of activeHighlights) {
			if (!liveIds.has(id)) {
				if (highlight.element.isConnected && !highlight.hadClass) {
					highlight.element.classList.remove(SELECTED_CLASS);
				}
				activeHighlights.delete(id);
			}
		}

		rows.replaceChildren();
		if (entries.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "Hold the configured input on a link, or drag a selection box, to add links here.";
			rows.appendChild(empty);
			return;
		}

		for (const entry of entries) {
			const element = store.getElement(entry.id);
			if (element instanceof HTMLElement && !activeHighlights.has(entry.id)) {
				const hadClass = element.classList.contains(SELECTED_CLASS);
				if (!hadClass) {
					element.classList.add(SELECTED_CLASS);
				}
				activeHighlights.set(entry.id, { element, hadClass });
			}

			const row = document.createElement("div");
			row.className = "row";
			row.draggable = true;
			row.setAttribute("aria-roledescription", "Draggable link row");

			row.addEventListener("dragstart", (event: DragEvent) => {
				if (!event.dataTransfer) {
					return;
				}
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", entry.id);
				row.classList.add("dragging");
			});
			row.addEventListener("dragend", () => {
				row.classList.remove("dragging");
			});
			row.addEventListener("dragover", (event: DragEvent) => {
				event.preventDefault();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = "move";
				}
				row.classList.add("drop-target");
			});
			row.addEventListener("dragleave", () => {
				row.classList.remove("drop-target");
			});
			row.addEventListener("drop", (event: DragEvent) => {
				event.preventDefault();
				row.classList.remove("drop-target");
				const movingId = event.dataTransfer?.getData("text/plain");
				if (!movingId || movingId === entry.id) {
					return;
				}

				const ids = store.getEntries().map((item) => item.id);
				const fromIndex = ids.indexOf(movingId);
				const targetIndex = ids.indexOf(entry.id);
				if (fromIndex < 0 || targetIndex < 0) {
					return;
				}

				const [ movedId ] = ids.splice(fromIndex, 1);
				if (!movedId) {
					return;
				}
				const bounds = row.getBoundingClientRect();
				const insertAfter = event.clientY >= bounds.top + bounds.height / 2;
				const adjustedTarget = ids.indexOf(entry.id) + (insertAfter ? 1 : 0);
				ids.splice(adjustedTarget, 0, movedId);
				store.reorder(ids);
			});
			const description = document.createElement("div");
			description.className = "description";
			const title = document.createElement("span");
			title.className = "title";
			title.textContent = entry.title || entry.url;
			title.title = entry.title || entry.url;
			const url = document.createElement("span");
			url.className = "url";
			url.textContent = entry.url;
			url.title = entry.url;
			description.append(title, url);

			const controls = document.createElement("div");
			controls.className = "controls";
			const dragHandle = document.createElement("span");
			dragHandle.className = "drag-handle";
			dragHandle.textContent = "⋮⋮";
			dragHandle.title = "Drag this row to reorder";
			dragHandle.setAttribute("aria-hidden", "true");

			const moveUp = document.createElement("button");
			moveUp.type = "button";
			moveUp.textContent = "↑";
			moveUp.title = "Move link up";
			moveUp.setAttribute("aria-label", "Move " + (entry.title || entry.url) + " up");
			moveUp.disabled = store.getEntries()[0]?.id === entry.id;
			moveUp.addEventListener("click", () => moveEntry(store, entry.id, -1));

			const moveDown = document.createElement("button");
			moveDown.type = "button";
			moveDown.textContent = "↓";
			moveDown.title = "Move link down";
			moveDown.setAttribute("aria-label", "Move " + (entry.title || entry.url) + " down");
			const lastEntry = entries[entries.length - 1];
			moveDown.disabled = lastEntry?.id === entry.id;
			moveDown.addEventListener("click", () => moveEntry(store, entry.id, 1));

			const remove = document.createElement("button");
			remove.className = "remove";
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "Remove this link";
			remove.setAttribute("aria-label", "Remove " + (entry.title || entry.url));
			remove.addEventListener("click", () => store.remove(entry.id));

			controls.append(dragHandle, moveUp, moveDown, remove);
			row.append(description, controls);
			rows.appendChild(row);
		}
	};

	unsubscribe = store.subscribe(render);
	render();
}

/** Removes the UI, subscriptions, and only the highlight classes this manager added. */
export function destroySelectionToolbar(): void {
	unsubscribe?.();
	unsubscribe = null;

	for (const highlight of activeHighlights.values()) {
		if (highlight.element.isConnected && !highlight.hadClass) {
			highlight.element.classList.remove(SELECTED_CLASS);
		}
	}
	activeHighlights.clear();

	host?.remove();
	host = null;
	document.getElementById(STYLE_ID)?.remove();
}

function installHighlightStyle(): void {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = "." + SELECTED_CLASS + " { outline:2px solid #2563eb !important; outline-offset:2px !important; }";
	(document.head || document.documentElement).appendChild(style);
}

function moveEntry(store: LinkSelectionStore, id: string, offset: -1 | 1): void {
	const ids = store.getEntries().map((entry) => entry.id);
	const index = ids.indexOf(id);
	const nextIndex = index + offset;
	if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) {
		return;
	}

	const [ movedId ] = ids.splice(index, 1);
	if (!movedId) {
		return;
	}
	ids.splice(nextIndex, 0, movedId);
	store.reorder(ids);
}

function startLazyTabs(store: LinkSelectionStore, delayInput: HTMLInputElement | null): void {
	const entries = store.getEntries();
	if (entries.length === 0) {
		return;
	}

	const seconds = Number(delayInput?.value ?? "0");
	if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
		if (delayInput) {
			delayInput.setCustomValidity("Choose a delay between 0 and 30 seconds.");
			delayInput.reportValidity();
		}
		return;
	}

	delayInput?.setCustomValidity("");
	const urls = entries.map(({ url, title }) => ({ url, title }));
	const delayMs = Math.round(seconds * 1000);
	safeAsync(
		"createLazyTabs",
		() => browser.runtime.sendMessage({
			message: "createLazyTabs",
			urls,
			delayMs,
			blockDuplicates: true
		} satisfies CreateLazyTabsMessage),
		"content"
	);
}

function removeDuplicateEntries(store: LinkSelectionStore): void {
	const seen = new Set<string>();
	for (const entry of store.getEntries()) {
		if (seen.has(entry.url)) {
			store.remove(entry.id);
		} else {
			seen.add(entry.url);
		}
	}
}

function runAction(store: LinkSelectionStore, action: "copy" | "copy-json" | "tabs" | "bm"): void {
	const entries = store.getEntries();
	if (entries.length === 0) {
		return;
	}

	const urls = entries.map(({ url, title }) => ({ url, title }));
	let setting: ActivateMessage["setting"];

	switch (action) {
		case "copy":
			setting = { action: "copy", options: { block: true, reverse: false, copy: 1 } };
			break;
		case "copy-json":
			setting = { action: "copy", options: { block: true, reverse: false, copy: 7 } };
			break;
		case "tabs":
			setting = { action: "tabs", options: { block: true, reverse: false, end: false, delay: 0, close: 0 } };
			break;
		case "bm":
			setting = { action: "bm", options: { block: true, reverse: false, bookmarks: 0 } };
			break;
	}

	safeAsync(
		"selectionToolbar:" + action,
		() => browser.runtime.sendMessage({ message: "activate", urls, setting } satisfies ActivateMessage),
		"content"
	);
}
