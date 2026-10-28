# skim

skim shows the C#, Razor and TypeScript files of the pull requests your branches would open, as
"header" views: types, member signatures, attributes and comments, with method bodies, accessor bodies,
long initializers and Razor markup folded. Click a fold's chip to expand it in place.

It needs only Node (no npm install of its own; see TypeScript below) and is read-only. It runs git and the read-only `gh` commands
(`gh pr list`, `gh pr view`, `gh repo view`), and it never runs `gh pr create`.

## Run it

```
node Tools/skim/skim.mjs                     # every .cs/.razor/.ts file in each repo's would-be PR
node Tools/skim/skim.mjs --new               # only the files those PRs add
node Tools/skim/skim.mjs --only TheBrainNetCore/TheBrainNetCore/TheBrain.Core/Collections,'Vulcan/**/Collection*.razor'
node Tools/skim/skim.mjs --only 'Vulcan/**/*.ts'
node Tools/skim/skim.mjs --repos Vulcan,TheBrainNetCore --fetch
node Tools/skim/skim.mjs --check             # print skeleton warnings for every file, then exit
node Tools/skim/skim.mjs --help
```

It serves http://127.0.0.1:5179/ and opens the browser.

## How the file list is built

For each repo (TheBrainNetCore, Athena, Vulcan, Deku, TheBrainCloud, KezaEdit, Ceres) whose current
branch has commits that its base does not:

- The base is the open PR's base when the branch already has a PR, and otherwise the repo's default
  branch from `gh repo view` (or `master` when gh fails). `--base` overrides both.
- The files are the existing PR's files from `gh pr view`. When there is no PR yet, they come from
  `git diff origin/<base>...HEAD`, which is what GitHub would show. Files with uncommitted changes are
  marked, and new uncommitted files are listed with status N.
- Each repo's header shows its commit count, any PR, how far it is behind its base, unpushed commits
  and uncommitted files.

Run with `--fetch` first if `origin/master` might be stale.

## TypeScript

skim parses .ts, .mts, .cts and .tsx files with the TypeScript compiler, but it uses a copy that is
already installed rather than one of its own. It looks for `typescript` in `SKIM_TYPESCRIPT` (the path of
a typescript package folder), then in `Athena/Venus/node_modules`, `Deku/Dekutron/ElectronHostHook/node_modules`
and the global npm root. When it finds none, each .ts file is shown unfolded, with a warning that lists
the folders it searched. Plain .js files are not listed, since the ones in the repos are compiled
TypeScript.

In a TypeScript file, functions, methods and accessors fold their bodies, and long values fold the same
way as in C#. An object that holds or lists functions, such as `export const Module = { setup() {…} }` or
`(window as any).api = { setup, dispose }`, is shown member by member, like a class. Hide private drops
`private` and `#name` class members. In a file that imports or exports, it also drops the top-level
declarations that the file neither exports nor publishes, whether through such an object or as the class
of an exported instance (`export const carousel = new Carousel()`).

## Keys

`j`/`k` move to the next or previous file, `/` filters, `e` expands or collapses every fold, and `r`
switches between the skeleton and the raw file.

## Tests

```
node --test 'Tools/skim/test/*.test.mjs'
```

The TypeScript tests are skipped when no compiler is found. The C# skeletonizer is a lexer plus a
brace-and-semicolon pass, not a parser. When a file's skeleton
doesn't add up (an unclosed string or brace, or braces that don't balance), the page says so above
the code and links to the raw file.
