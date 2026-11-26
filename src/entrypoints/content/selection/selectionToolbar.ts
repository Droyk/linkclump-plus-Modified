import { browser } from "wxt/browser";
import { safeAsync } from "@/assets/js/lib/safeAsync";
import type { ActivateMessage } from "@/assets/js/types/Messages";
import type { LinkSelectionStore } from "./LinkSelectionStore";

const HOST_ID = "linkclump-selection-manager";
const STYLE_ID = "linkclump-selection-highlight-style";
const SELECTED_CLASS = "linkclump-selected-link";

let host: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
let activeHighlights = new Map<string, { element: HTMLElement; hadClass: boolean }>();

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
		"<footer><button id=\"copy\" type=\"button\" class=\"primary\">Copy URLs</button><button id=\"open\" type=\"button\">Open tabs</button><button id=\"bookmark\" type=\"button\">Bookmark</button><button id=\"clear\" type=\"button\">Clear</button></footer>",
		"</section>"
	].join("");

	document.documentElement.appendChild(host);
	installHighlightStyle();

	const panel = shadow.querySelector<HTMLElement>(".panel");
	const rows = shadow.querySelector<HTMLElement>("#rows");
	const count = shadow.querySelector<HTMLElement>("#count");
	const copy = shadow.querySelector<HTMLButtonElement>("#copy");
	const open = shadow.querySelector<HTMLButtonElement>("#open");
	const bookmark = shadow.querySelector<HTMLButtonElement>("#bookmark");
	const clear = shadow.querySelector<HTMLButtonElement>("#clear");
	const collapse = shadow.querySelector<HTMLButtonElement>("#collapse");

	copy?.addEventListener("click", () => runAction(store, "copy"));
	open?.addEventListener("click", () => runAction(store, "tabs"));
	bookmark?.addEventListener("click", () => runAction(store, "bm"));
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
		if (!rows || !count || !copy || !open || !bookmark || !clear) {
			return;
		}

		const entries = store.getEntries();
		count.textContent = "(" + entries.length + ")";
		copy.disabled = entries.length === 0;
		open.disabled = entries.length === 0;
		bookmark.disabled = entries.length === 0;
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

			const remove = document.createElement("button");
			remove.className = "remove";
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "Remove this link";
			remove.setAttribute("aria-label", "Remove " + (entry.title || entry.url));
			remove.addEventListener("click", () => store.remove(entry.id));

			row.append(description, remove);
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

function runAction(store: LinkSelectionStore, action: "copy" | "tabs" | "bm"): void {
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
		case "tabs":
			setting = { action: "tabs", options: { block: true, reverse: false, end: false, delay: 0, close: 0 } };
			break;
		case "bm":
			setting = { action: "bm", options: { block: true, reverse: false, bookmarks: 1 } };
			break;
	}

	safeAsync(
		"selectionToolbar:" + action,
		() => browser.runtime.sendMessage({ message: "activate", urls, setting } satisfies ActivateMessage),
		"content"
	);
}
