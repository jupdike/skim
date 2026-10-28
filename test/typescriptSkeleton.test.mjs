// These tests cover the TypeScript shapes that the repos use: plain functions, classes, module objects,
// window assignments and type declarations. They need an installed TypeScript compiler, and they are
// skipped when none is found. Run them with `node --test 'Tools/skim/test/*.test.mjs'`.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from '../lib/typescript.mjs';
import { skeletonTypeScript } from '../lib/typescriptSkeleton.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { ts } = await loadTypeScript(root);
const skip = ts == null ? 'No TypeScript compiler was found, so the TypeScript tests are skipped.' : false;

/** Returns the skeleton text with each fold marker written as ⟦kind⟧, plus the warnings. */
function skim(src, options = {}) {
	const result = skeletonTypeScript(src, { fileName: 'test.ts', ...options }, ts);
	const text = result.text.replace(/([-]+)/g, (_, digits) => {
		const id = Number([...digits].map(c => c.charCodeAt(0) - 0xE010).join(''));
		return `⟦${result.folds[id].kind}⟧`;
	});
	return { text, warnings: result.warnings, folds: result.folds };
}

const longBody = 'let total = 0;\n\tfor(let i = 0; i < 10; i++) {\n\t\ttotal += i;\n\t}\n\treturn total;';

test('A function with an object return type folds only its body', { skip }, () => {
	const src = `/** Makes the image. */\nexport async function make(title: string): Promise<{ dataUrl: string; size: { w: number } }> {\n\t${longBody}\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.equal(text, '/** Makes the image. */\nexport async function make(title: string): Promise<{ dataUrl: string; size: { w: number } }> {⟦body⟧}');
});

test('Regex and template literals with braces stay inside the folded body', { skip }, () => {
	const src = `function a(s: string) {\n\tconst r = /[{}]+\\/\\}/g;\n\tconst t = \`{ \${s.replace(r, '}')} }\`;\n\t${longBody}\n}\nexport const After = 1;`;
	const { text, warnings, folds } = skim(src);
	assert.deepEqual(warnings, []);
	assert.equal(folds.length, 1);
	assert.equal(text, 'function a(s: string) {⟦body⟧}\nexport const After = 1;');
});

test('A module object shows its members and folds their bodies and long values', { skip }, () => {
	const src = `export const Module = {\n\tsetup(el: HTMLElement) {\n\t\t${longBody}\n\t},\n\tdispose: () => {\n\t\t${longBody}\n\t},\n\tcfg: {\n\t\ta: 1,\n\t\tb: 2,\n\t},\n\tname: 'x',\n};`;
	const { text } = skim(src);
	assert.match(text, /setup\(el: HTMLElement\) \{⟦body⟧\},/);
	assert.match(text, /dispose: \(\) => \{⟦body⟧\},/);
	assert.match(text, /cfg: ⟦init⟧,/);
	assert.match(text, /name: 'x',/);
});

test('A data object folds whole, while a shorthand list of functions stays', { skip }, () => {
	const src = `export const settings = {\n\tspeed: 1,\n\tsize: 2,\n};\nexport const Api = {\n\tsetup,\n\tdispose\n};`;
	const { text } = skim(src);
	assert.match(text, /settings = ⟦init⟧;/);
	assert.match(text, /Api = \{\n\tsetup,\n\tdispose\n\};/);
});

test('An object assigned to window is shown like a module object', { skip }, () => {
	const src = `(window as any).api = {\n\tinit(id: string): void {\n\t\t${longBody}\n\t},\n};`;
	const { text } = skim(src);
	assert.match(text, /\(window as any\)\.api = \{\n\tinit\(id: string\): void \{⟦body⟧\},\n\};/);
});

test('A class keeps parameter properties and short fields, and folds methods and accessors', { skip }, () => {
	const src = `export class A {\n\tconstructor(private readonly host: Host) {}\n\tcount = 0;\n\tprivate items: string[] = [];\n\tget total(): number {\n\t\t${longBody}\n\t}\n\tstatic make<T extends object>(x: T): A {\n\t\t${longBody}\n\t}\n\tshort() { return 1; }\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /constructor\(private readonly host: Host\) \{\}/);
	assert.match(text, /count = 0;\n\tprivate items: string\[\] = \[\];/);
	assert.match(text, /get total\(\): number \{⟦body⟧\}/);
	assert.match(text, /static make<T extends object>\(x: T\): A \{⟦body⟧\}/);
	assert.match(text, /short\(\) \{ return 1; \}/);
});

test('Interfaces, type aliases, enums and declare global are kept as written', { skip }, () => {
	const src = `export interface Host {\n\tdraw(): void;\n\tsize: { w: number; h: number };\n}\nexport type Phase =\n\t| 'cur'\n\t| 'old';\nenum Kind { One = 1, Two = 2 }\ndeclare global {\n\tinterface Window {\n\t\tapi?: { run: () => void };\n\t}\n}\nexport {};`;
	const { text, folds } = skim(src);
	assert.equal(folds.length, 0);
	assert.equal(text, src);
});

test('A long arrow expression body is folded and a short one stays', { skip }, () => {
	const src = `export const short = (x: number) => x * 2;\nexport const long = (items: Item[]) => items\n\t.filter(i => i.ok)\n\t.map(i => i.name);`;
	const { text } = skim(src);
	assert.match(text, /short = \(x: number\) => x \* 2;/);
	assert.match(text, /long = \(items: Item\[\]\) => ⟦expr⟧;/);
});

test('hidePrivate drops private members and unexported declarations in a module', { skip }, () => {
	const src = `// The file header.\n\nimport { x } from './x.js';\n\n// A helper.\nfunction helper() {\n\t${longBody}\n}\nfunction published() {}\nexport class A {\n\t/** The secret. */\n\tprivate secret = 1;\n\t#hidden = 2;\n\tpublic open = 3;\n}\nexport function api() {}\n(window as any).thing = { published };`;
	const { text } = skim(src, { hidePrivate: true });
	assert.match(text, /^\/\/ The file header\./);
	assert.doesNotMatch(text, /helper|A helper|secret|#hidden/);
	assert.match(text, /function published\(\) \{\}/);
	assert.match(text, /public open = 3;/);
	assert.match(text, /export function api\(\) \{\}/);
});

test('hidePrivate keeps a class whose instance the module exports', { skip }, () => {
	const src = `import { x } from './x.js';\nclass Carousel {\n\tinit() {}\n\tprivate tick() {}\n}\nclass Unused {}\nexport const carousel: Carousel = new Carousel();`;
	const { text } = skim(src, { hidePrivate: true });
	assert.match(text, /class Carousel \{\n\tinit\(\) \{\}\n\}/);
	assert.doesNotMatch(text, /tick|Unused/);
	const listed = skim('class Bench {\n\trun() {}\n}\nconst bench = new Bench();\nexport { bench };', { hidePrivate: true });
	assert.match(listed.text, /class Bench \{/);
});

test('hidePrivate keeps the declarations of a script that does not import or export', { skip }, () => {
	const src = `function helper() {}\nconst state = { a: 1 };\n(window as any).api = { helper };`;
	const { text } = skim(src, { hidePrivate: true });
	assert.equal(text, src);
});

test('hideComments drops comment-only lines and trailing comments', { skip }, () => {
	const src = `/** Doc. */\nexport const x = 1; // trailing\n/* block */\nexport const y = 2;\nfunction f() {\n\t// inside\n}`;
	const { text } = skim(src, { hideComments: true });
	assert.equal(text, 'export const x = 1;\nexport const y = 2;\nfunction f() {\n}');
});

test('A syntax error is reported with its line', { skip }, () => {
	const { warnings } = skim('export function a() {\n\treturn 1;\n}\nexport const b = ;\nexport const c = 1;');
	assert.deepEqual(warnings, ['Expression expected. (line 4).']);
});
