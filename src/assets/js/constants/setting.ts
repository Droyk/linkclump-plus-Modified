import {
	FILTER_EXCLUDE_LINKS,
	SMART_SELECT_ON
} from "@/assets/js/constants/action";
import { KEY_CODE_DEFAULT_Z } from "@/assets/js/constants/keyboard";
import { MOUSE_BUTTON_LEFT } from "@/assets/js/constants/mouseButton";
import {
	COUNTER_FONT_SIZE_DEFAULT,
	COUNTER_FONT_WEIGHT_DEFAULT
} from "@/assets/js/constants/ui";

import type { LinkSelectionSettings, Settings } from "@/assets/js/types/Settings";

// The optional collection settings block requires no migration of existing settings.
export const CURRENT_VERSION = "5" as const;

export const DEFAULT_LINK_SELECTION_SETTINGS: Readonly<LinkSelectionSettings> = Object.freeze({
	enabled: false,
	inputMode: "mouse-key",
	mouseButton: 2,
	key: 16,
	holdDurationMs: 450
});

// key name for Storage
export const linkclumpSettingsKey = "linkclumpSettings" as const;
export const linkclumpVersionKey = "linkclumpVersion" as const;
export const linkclumpStorageModeKey = "linkclumpStorageMode" as const;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
	"actions": Object.freeze({
		"101": Object.freeze({
			"mouse": MOUSE_BUTTON_LEFT,  // left mouse button
			"key": KEY_CODE_DEFAULT_Z,   // z key
			"action": "tabs",
			"color": "#FFA500",
			"options": Object.freeze({
				"smart": SMART_SELECT_ON,
				"ignore": Object.freeze([ FILTER_EXCLUDE_LINKS ]),
				"delay": 0,
				"close": 0,
				"block": true,
				"reverse": false,
				"end": false,
				"fontsizeofcounter": COUNTER_FONT_SIZE_DEFAULT,
				"fontweightofcounter": COUNTER_FONT_WEIGHT_DEFAULT,
				"samebgcolorasbox": true  // If you want to set the color of counter to the same as the box color, specify a value of true
			})
		})
	}),
	"blocked": Object.freeze([]),
	"selection": DEFAULT_LINK_SELECTION_SETTINGS
}) as unknown as Settings;
