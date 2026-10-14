import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const hasLocalDependencies = existsSync(new URL('../node_modules/esbuild', import.meta.url));
const esbuildModule = await import(
	hasLocalDependencies ? 'esbuild' : '../../obsidian-time-grid/node_modules/esbuild/lib/main.js'
);
const esbuild = esbuildModule.default ?? esbuildModule;
const testsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testsDirectory, '..');
const testFiles = readdirSync(testsDirectory)
	.filter((name) => name === 'smoke.ts' || name.endsWith('.test.ts'))
	.sort();
const forwardedArguments = process.argv.slice(2);
if (forwardedArguments[0] === '--') forwardedArguments.shift();
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'task-graph-test-'));
let passed = 0;
let failed = 0;

try {
	if (testFiles.length === 0) throw new Error('No test files found.');
	for (const testFile of testFiles) {
		const sourcePath = join(testsDirectory, testFile);
		const outputPath = join(temporaryDirectory, `${testFile.replace(/\.ts$/, '')}.cjs`);
		console.log(`\n[TEST] ${testFile}`);
		try {
			await esbuild.build({
				entryPoints: [sourcePath],
				bundle: true,
				platform: 'node',
				format: 'cjs',
				target: 'node16',
				outfile: outputPath,
				logLevel: 'warning',
			});
			const result = spawnSync(process.execPath, [outputPath, ...forwardedArguments], {
				cwd: projectDirectory,
				stdio: 'inherit',
			});
			if (result.error) throw result.error;
			if (result.status !== 0) {
				failed += 1;
				continue;
			}
			passed += 1;
		} catch (error) {
			failed += 1;
			console.error(error);
		}
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log(`\nTest files: ${passed} passed, ${failed} failed, ${testFiles.length} total.`);
if (failed > 0) process.exitCode = 1;
