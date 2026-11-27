# Link Manager behaviour

This is the single-mode, direct-URL queue. It does not create placeholder tabs, deferred tabs, or use a creation-gap timer.

## Sequential queue

Each queue is associated with the browser window from which its links were added. Queue state is independent per originating window. Newly added links begin in stored order. The first pending link opens directly in the foreground when no queue tab is already open for that window.

When the active queue tab closes, Link Manager first activates the next already-open queue tab in stored queue order. If no queue tab is already open, it opens the next pending destination URL directly in the foreground. Closing an inactive queue tab records that it closed but does not advance the queue or take focus. Closing unrelated tabs does nothing. Switching away from a queue tab without closing it does nothing. A whole-window close does not cause replacement tabs to open.

Opening several selected links is an explicit bulk action: the first selected link is activated, and the remaining selected links open in the background. Their stored queue order remains the order used by later progression; tab-strip position does not redefine queue order.

## Duplicate reconciliation

When adding links or opening selected links, the manager checks for exact normalized URL matches. Query strings and fragments are retained. The duplicate dialog offers three decisions:

- Activate one selected existing tab. The user may independently mark other matching tabs for closure. Tabs selected for neither action remain untouched.
- Close all matching tabs and open a new tab.
- Leave all matching tabs untouched and open a new duplicate.

For a custom selection, exactly one tab is selected for activation and zero or more different tabs may be selected for closure. The activation tab cannot also be closed. A saved session resolution remembers a high-level policy (activate, replace, or duplicate), not tab IDs from a previous URL.

## Ownership

Reused tabs have one of two ownership states:

- **Managed (A):** Link Manager may close the associated tab on Pause or when its queue item is removed. Resume recreates managed tabs that were closed by Pause.
- **Borrowed (B):** Link Manager tracks and activates the tab but does not close it on Pause or item removal.

The persistent default is Borrowed. A duplicate prompt can override it for the selected reused tab and can remember that ownership choice for the browser session. Newly created tabs are Managed.

## Window policy

- **Current window only** (default): only tabs in the queue's originating window count as duplicates or reusable queue tabs. A matching tab in another window is ignored and a new tab is opened in the queue's window.
- **Follow across windows:** matching tabs are tracked across windows. When one is due for activation, Link Manager focuses its containing window and activates it.

Each window keeps its own queue session. The cross-window setting controls whether an individual session may reuse and focus tabs outside its originating window.

## Read state

Each item has only **Unread** or **Read**. Activating a queue tab marks it Read. Opening tabs in the background does not mark them Read. Manually marking an item Unread is temporary: its next activation marks it Read again. Reading state is independent of whether the item is queued, open, or closed. Read titles are displayed with strikethrough.

## Pause and collections

Pause and Resume are independent per browser window. Pausing one window stops only that queue and closes only its Managed tabs; Borrowed tabs remain open, and other windows keep running. Resuming that window recreates its Managed tabs and retains their URLs and queue order. Removing a Managed item closes its associated tab; removing a Borrowed item leaves its tab open.

The page selection toolbar has a **Save to Link Manager** action. It copies the current selection into the active persistent collection without opening tabs. Two distinct page elements with the same URL remain separate collection entries. The selection itself is still frame-local and temporary until saved; the saved collection survives page reloads.

Collections are a view and grouping layer over the queue items. The extension retains combined and per-collection views, link entry by one URL per line or Title followed by a Tab and URL, manual collection selection, and multi-select actions. The Link Manager state is persisted locally. Session duplicate and ownership preferences use extension session storage when the browser provides it.
