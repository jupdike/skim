// These tests cover the C# and Razor constructs that a brace-counting skeletonizer most easily gets wrong.
// Run them with `node --test 'Tools/skim/test/*.test.mjs'`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { bracesBalance, skeletonCSharp } from '../lib/csharpSkeleton.mjs';
import { skeletonRazor } from '../lib/razorSkeleton.mjs';

/** Returns the skeleton text with each fold marker written as ⟦kind⟧, plus the warnings. */
function skim(src, options = {}, razor = false) {
	const result = razor ? skeletonRazor(src, options) : skeletonCSharp(src, options);
	const text = result.text.replace(/\uE000([\uE010-\uE019]+)\uE001/g, (_, digits) => {
		const id = Number([...digits].map(c => c.charCodeAt(0) - 0xE010).join(''));
		return `⟦${result.folds[id].kind}⟧`;
	});
	return { text, warnings: result.warnings, folds: result.folds };
}

const longBody = 'var total = 0;\n\t\tfor(int i = 0; i < 10; i++) {\n\t\t\ttotal += i;\n\t\t}\n\t\treturn total;';

test('A method body is folded and its doc comment is kept', () => {
	const { text, warnings } = skim(`class A {\n\t/// <summary>Adds things.</summary>\n\tpublic int Sum() {\n\t\t${longBody}\n\t}\n}`);
	assert.deepEqual(warnings, []);
	assert.match(text, /\/\/\/ <summary>Adds things.<\/summary>/);
	assert.match(text, /public int Sum\(\) \{⟦body⟧\}/);
	assert.doesNotMatch(text, /total/);
});

test('A raw string with JSON braces does not confuse the structure', () => {
	const src = `class A {\n\tconst string Json = """\n\t\t{ "a": { "b": 1 } }\n\t\t""";\n\tvoid M() {\n\t\t${longBody}\n\t}\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /void M\(\) \{⟦body⟧\}/);
});

test('An interpolated raw string with $$ keeps single braces as content', () => {
	const src = `class A {\n\tstring M(int x) {\n\t\treturn $$"""{ "x": {{x}} }""" + "}";\n\t\t${longBody}\n\t}\n\tint N;\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /int N;/);
});

test('Interpolated, verbatim and char literals with braces are skipped', () => {
	const src = `class A {\n\tvoid M() {\n\t\tvar a = $"{(x ? "{" : "}")} {{literal}} {value:N0}";\n\t\tvar b = @"C:\\{dir}"" }";\n\t\tchar c = '{';\n\t\tchar d = '\\'';\n\t\t${longBody}\n\t}\n\tpublic int After;\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /void M\(\) \{⟦body⟧\}\n\tpublic int After;/);
});

test('Expression-bodied members are kept when short and folded when long', () => {
	const src = `class A {\n\tpublic int X => _x;\n\tpublic string Y => _items\n\t\t.Where(i => i.Ok)\n\t\t.Select(i => i.Name)\n\t\t.First();\n}`;
	const { text } = skim(src);
	assert.match(text, /public int X => _x;/);
	assert.match(text, /public string Y => ⟦expr⟧;/);
});

test('Properties keep their accessors and fold accessor bodies', () => {
	const src = `class A {\n\tpublic int Auto { get; private set; } = 5;\n\tpublic int Full {\n\t\tget {\n\t\t\t${longBody}\n\t\t}\n\t\tset => _x = value;\n\t}\n\tpublic int this[int i] { get { return i; } }\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /public int Auto \{ get; private set; \} = 5;/);
	assert.match(text, /get \{⟦body⟧\}/);
	assert.match(text, /set => _x = value;/);
	assert.match(text, /this\[int i\] \{ get \{ return i; \} \}/);
});

test('A generic method with a class constraint is a method, not a type', () => {
	const src = `class A {\n\tpublic T Make<T>() where T : class, new() {\n\t\t${longBody}\n\t}\n\tpublic void Two<T, U>() where T : class where U : struct {\n\t\t${longBody}\n\t}\n}`;
	const { text, folds } = skim(src);
	assert.equal(folds.length, 2);
	assert.match(text, /where T : class, new\(\) \{⟦body⟧\}/);
});

test('Constructors with base calls, nested types and records are handled', () => {
	const src = `namespace N {\n\tpublic record Point(int X, int Y) {\n\t\tpublic int Sum() {\n\t\t\t${longBody}\n\t\t}\n\t}\n\tpublic class B : A {\n\t\tpublic B(int x) : base(x => x + 1) {\n\t\t\t${longBody}\n\t\t}\n\t\tprivate sealed class Inner {\n\t\t\tpublic int Z;\n\t\t}\n\t\tenum Kind { One = 1, Two = 2 }\n\t}\n}`;
	const { text, warnings } = skim(src);
	assert.deepEqual(warnings, []);
	assert.match(text, /public int Sum\(\) \{⟦body⟧\}/);
	assert.match(text, /public B\(int x\) : base\(x => x \+ 1\) \{⟦body⟧\}/);
	assert.match(text, /public int Z;/);
	assert.match(text, /enum Kind \{ One = 1, Two = 2 \}/);
});

test('Local functions and switch expressions inside a body fold with the body', () => {
	const src = `class A {\n\tint M(int k) {\n\t\tint Local(int v) { return v * 2; }\n\t\treturn k switch {\n\t\t\t1 => Local(1),\n\t\t\t_ => 0,\n\t\t};\n\t}\n\tpublic int After;\n}`;
	const { text, folds } = skim(src);
	assert.equal(folds.length, 1);
	assert.match(text, /int M\(int k\) \{⟦body⟧\}\n\tpublic int After;/);
});

test('Long initializers fold, while constants and short initializers stay', () => {
	const src = `class A {\n\tpublic const string Classes = "${'x'.repeat(150)}";\n\tprivate readonly List<int> _a = new();\n\tprivate readonly Dictionary<string, int> _b = new() {\n\t\t["a"] = 1,\n\t\t["b"] = 2,\n\t};\n}`;
	const { text } = skim(src);
	assert.match(text, /const string Classes = "x{150}";/);
	assert.match(text, /_a = new\(\);/);
	assert.match(text, /_b = ⟦init⟧;/);
});

test('hidePrivate drops private and unmodified class members, but keeps explicit interface members', () => {
	const src = `public class A : IFoo {\n\t// The count.\n\tprivate int _count;\n\tint _implicit;\n\tpublic int Count => _count;\n\tvoid IFoo.Bar() {\n\t\t${longBody}\n\t}\n\tprivate void Helper() {\n\t\t${longBody}\n\t}\n}`;
	const { text, folds } = skim(src, { hidePrivate: true });
	assert.doesNotMatch(text, /_implicit|Helper|The count/);
	assert.match(text, /public int Count => _count;/);
	assert.match(text, /void IFoo\.Bar\(\) \{⟦body⟧\}/);
	assert.equal(folds.length, 1);
});

test('hideComments drops comment-only lines and trailing comments', () => {
	const src = `class A {\n\t/// <summary>Doc.</summary>\n\tpublic int X; // trailing\n\t/* block */\n\tpublic int Y;\n}`;
	const { text } = skim(src, { hideComments: true });
	assert.equal(text, 'class A {\n\tpublic int X;\n\tpublic int Y;\n}');
});

test('Razor keeps directives and parameters, folds markup and skips templates in @code', () => {
	const src = [
		'@using Foo',
		'@inject ILocalizer Localizer',
		'',
		'@* The component\'s summary. *@',
		'<div class="a">',
		'\t@foreach(var x in Items) {',
		'\t\tbool on = Comparer<TEnum>.Default.Equals(x, y);',
		'\t\t<span>@Row(Segments<Flow>(x)) isn\'t</span>',
		'\t}',
		'</div>',
		'',
		'@code {',
		'\t[Parameter] public int Count { get; set; }',
		'',
		'\tprivate RenderFragment Title => @<div>',
		'\t\t@* It\'s a title. *@',
		'\t\t<span>@Count</span>',
		'\t</div>;',
		'',
		'\tprivate void M() {',
		`\t\t${longBody}`,
		'\t}',
		'}',
		'',
	].join('\n');
	const { text, warnings, folds } = skim(src, {}, true);
	assert.deepEqual(warnings, []);
	assert.match(text, /^@using Foo\n@inject ILocalizer Localizer/);
	assert.match(text, /@\* The component's summary. \*@\n⟦markup⟧/);
	assert.match(text, /\[Parameter\] public int Count \{ get; set; \}/);
	assert.match(text, /Title => ⟦expr⟧;/);
	assert.match(text, /private void M\(\) \{⟦body⟧\}\n\}/);
	assert.equal(folds.filter(f => f.kind === 'markup').length, 1);
});

test('bracesBalance ignores braces in strings and comments', () => {
	assert.equal(bracesBalance('class A { string s = "}"; // }\n}'), true);
	assert.equal(bracesBalance('class A { '), false);
});
