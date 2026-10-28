# skim

skim shows the C# and Razor files of the pull requests your branches would open, as "header" views:
types, member signatures, attributes and comments, with method bodies, accessor bodies, long
initializers and Razor markup folded. Click a fold's chip to expand it in place.

It needs only Node (no npm install) and is read-only. It runs git and the read-only `gh` commands
(`gh pr list`, `gh pr view`, `gh repo view`), and it never runs `gh pr create`.

## Run it

```
node Tools/skim/skim.mjs                     # every .cs/.razor file in each repo's would-be PR
node Tools/skim/skim.mjs --new               # only the files those PRs add
node Tools/skim/skim.mjs --only TheBrainNetCore/TheBrainNetCore/TheBrain.Core/Collections,'Vulcan/**/Collection*.razor'
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

## Keys

`j`/`k` move to the next or previous file, `/` filters, `e` expands or collapses every fold, and `r`
switches between the skeleton and the raw file.

## Tests

```
node --test Tools/skim/test/skeleton.test.mjs
```

The skeletonizer is a lexer plus a brace-and-semicolon pass, not a parser. When a file's skeleton
doesn't add up (an unclosed string or brace, or braces that don't balance), the page says so above
the code and links to the raw file.
