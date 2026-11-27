import { defineConfig } from "wxt";
import type { ConfigEnv, UserManifest, WxtViteConfig } from "wxt";
import { manifest } from "./src/manifest";

type GetViteConfig = (env: ConfigEnv) => WxtViteConfig;
type GetManifest = (env: ConfigEnv) => UserManifest;

const getViteConfig: GetViteConfig = (env) => ({
	build: {
		sourcemap: env.mode === "sourcemap",
		modulePreload: false
	}
});

const getManifest: GetManifest = (env) => {
	const mf: UserManifest = structuredClone(manifest);
	const extra = mf as unknown as Record<string, unknown>;
	const commands = {
		"open-link-manager": {
			suggested_key: { default: "Alt+Shift+L" },
			description: "Open Link Manager"
		},
		"toggle-link-manager-pause": {
			suggested_key: { default: "Alt+Shift+P" },
			description: "Pause or resume Link Manager"
		}
	};

	switch (env.browser) {
		case "chrome":
			delete mf.browser_specific_settings;
			mf.permissions = [ ...(mf.permissions ?? []), "sidePanel" ];
			extra.side_panel = { default_path: "linkManager.html" };
			extra.commands = commands;
			break;
		case "firefox":
			delete mf.minimum_chrome_version;
			extra.sidebar_action = {
				default_title: "Link Manager",
				default_panel: "linkManager.html",
				open_at_install: false
			};
			extra.commands = commands;
			break;
		default:
			extra.commands = commands;
			break;
	}

	return mf;
};

export default defineConfig({
	srcDir: "src",
	publicDir: "src/public",
	outDirTemplate: "{{browser}}-mv{{manifestVersion}}",
	vite: getViteConfig,
	manifest: getManifest
});
