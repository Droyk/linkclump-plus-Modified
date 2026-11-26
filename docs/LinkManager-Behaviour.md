# Link Manager: accepted behaviour and queue semantics

This document records the product decisions for the Link Manager implementation.

## Low-overhead reading state

Every saved link has one of three states:

- **Unread**: it has not been activated through Link Manager.
- **Viewed**: the browser reported that its managed tab became active at least once.
- **Read**: the user explicitly marked it read.

Automatic state changes use only the browser's tab-activation event. There is no scroll polling, dwell-time timer, DOM traversal, page-content inspection, or analytics instrumentation. "Viewed" is an exposure signal, not proof that the page was read. A manual action can set a link back to Unread or mark it Read.

## Queue modes

A, B, and C manage deferred placeholder tabs. The batch size is configurable (default 4, range 1-50).

- **A — Refill immediately**: keep up to the configured number of Link Manager tabs staged/open. When one closes, replace only that slot. Other tabs remain open.
- **B — Refill after batch**: a batch is a fixed cohort. Closing one tab does not stage another. Stage the next batch only after every tab in that cohort has closed.
- **C — Manual replenishment**: closing a tab never triggers new work. The user invokes Stage next to fill available slots.
- **D — Sequential direct**: one destination URL at a time, opened directly rather than through a placeholder. The next URL opens after the current managed queue tab closes. When changing to D while several tabs from an earlier mode remain open, those tabs are left alone; D waits until all managed queue tabs have closed before opening its next URL.

When A/B/C has an active batch and one tab closes, only the freed slot is available to A or an explicit C replenishment. B uses the batch's original membership and does not count replacement tabs as members of an already-running cohort.

Mode changes never close currently open tabs. The new mode governs later replenishment.

## Lists, batches, and views

A link is stored once and belongs to one named collection (for example Inbox, Research, or Shopping). Each queue staging operation may assign a batch ID. The sidebar's Combined and Collections views are presentations of the same data; changing the view does not copy or split links.

The sidebar accepts one URL per line. A line may use `Title<TAB>URL`; otherwise the URL is also used as its title.

## Duplicate tabs

Before a URL is queued for opening, Link Manager searches tabs across the current browser profile for a normalized URL match. Query strings and fragments are retained in matching; they can identify different pages or in-page application routes.

The user chooses one of two actions:

1. **Activate existing tab**: activate the selected matching tab. It is recorded as externally open and is not claimed by Link Manager. Pause will not close it.
2. **Close it and open a managed replacement**: close the selected matching tab and queue a new Link Manager tab. The replacement is created at the end of the tab strip rather than reusing the previous tab's position.

There is no automatic takeover. Existing tabs and tabs owned/managed by other extensions are untouched unless the user explicitly selects one of these duplicate actions.

## Pause and resume

Pause is global. Before closing tabs, the extension persists the paused state and clears managed tab IDs from the live records. It then closes all Link Manager-controlled destination and placeholder tabs. Unrelated tabs and externally activated duplicate tabs remain open.

Resume recreates managed tabs in their saved order. Destination tabs reopen at their exact URLs. Placeholder tabs are recreated as placeholders with their original destination URLs still stored for activation. Read state, list membership, ordering, and batch membership are retained. Browser page memory, unsaved form state, scroll position, and media playback state are not guaranteed to survive a close/reopen cycle.

## Tab-manager coexistence

There is no standard browser-extension API for coordinating with another extension's private tab-management model. Link Manager therefore uses the standard browser tabs API and confines its automatic actions to tabs it created or explicitly controls. It does not modify tab groups or other extensions' settings.
