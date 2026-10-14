import process from "process";
import { copyFileSync, existsSync } from "fs";

const hasLocalDependencies = existsSync(new URL("./node_modules/esbuild", import.meta.url));
const esbuildModule = await import(
	hasLocalDependencies ? "esbuild" : "../obsidian-time-grid/node_modules/esbuild/lib/main.js"
);
const builtinsModule = await import(
	hasLocalDependencies ? "builtin-modules" : "../obsidian-time-grid/node_modules/builtin-modules/index.js"
);
const esbuild = esbuildModule.default ?? esbuildModule;
const builtins = builtinsModule.default ?? builtinsModule;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: {
		js: "/* Task Graph - generated bundle */",
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

copyFileSync("src/styles/main.css", "styles.css");

if (prod) {
	await context.rebuild();
	process.exit(0);
}

await context.watch();
