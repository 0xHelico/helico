# Landing page starter — Astro under `apps/landing`

Issue: [#9](https://github.com/0xHelico/helico/issues/9)

## Problem

Helico needs a public landing page eventually: a home for the product story once it
exists, and a deploy pipeline we will need anyway. (The finalist track's requirement is a
deployed application others can use without us running anything, which a static placeholder
does not satisfy on its own.) Nothing exists under `apps/` yet. The product story is not
written, so what is needed now is a starter that builds, type-checks, and fits the workspace
(bun, Turborepo, Biome, Husky), with placeholder content that is obviously placeholder.

## Approach

Scaffold with Astro's own tool, as Astro's AI guidance recommends ("start with templates,
use `npm create astro`"), then fold into the workspace:

- `bun create astro@latest landing -- --template minimal --no-install --no-git --yes`
- Package renamed to `@helico/landing`; dependencies installed by the root `bun install`
- `tsconfig.json` extends `astro/tsconfigs/strict` (Astro's preset already sets
  `moduleResolution: Bundler`, `verbatimModuleSyntax`, `isolatedModules`, `noEmit`, so the
  repo base tsconfig is not layered on top)
- `typecheck` script is `astro check`, which covers `.astro` and `.ts` files; Turborepo's
  existing `typecheck`, `build`, and `dev` tasks pick it up unchanged
- One base layout (`src/layouts/Base.astro`) with typed `Props`, one index page with
  placeholder copy
- The `AGENTS.md` and `CLAUDE.md` that `create-astro` generates are kept: they carry
  Astro's own instructions for coding agents (background dev server, which guides to read),
  which is exactly the kind of artifact the hackathon rules ask to keep in the repository
- Root `.gitignore` gains `.astro/` (generated types); the template's own `.gitignore` and
  nested `.vscode/` are dropped because the root already covers them

### Rejected alternatives

- **Tailwind or a UI kit now.** No design exists. `astro add tailwind` is one command later.
- **Biome on `.astro` files.** Biome's full Astro support is experimental and off by default
  in 2.5, but even without it Biome lints the frontmatter on its own and cannot see the
  template, so every prop used in the markup is reported as unused and the layout import
  is flagged as removable. `.astro` files and `public/` assets are therefore excluded in the
  root `biome.json`; `astro check` type-checks `.astro` files, and Biome still covers
  `astro.config.mjs` and any `.ts`.
- **Astro 5-era patterns.** Astro is at 7.3.1; the Rust compiler is stricter about unclosed
  tags and `compressHTML` defaults to JSX whitespace rules. The layout is written with
  explicit closing tags and no inline-element whitespace tricks.

## Scope

**In:** `apps/landing` as above, short README, root README and CONTRIBUTING layout rows,
`AI-USAGE.md` entry.

**Out:** styling framework, real copy, SEO, analytics, hosting and deployment, i18n, CMS,
the Astro docs MCP server (a per-developer tool, not a repo artifact).

## How to verify

From the repository root:

| Step | Command | Pass condition |
|---|---|---|
| 1 | `bun install` | clean |
| 2 | `bun run --filter @helico/landing typecheck` | `astro check`: 0 errors, 0 warnings |
| 3 | `bun run --filter @helico/landing build` | static site in `apps/landing/dist`, `index.html` present |
| 4 | `bun run typecheck --force` | Turborepo runs every package's typecheck, all successful |
| 5 | `bun run check` | Biome clean |

## Facts checked during research

- Astro 7.3.1, create-astro 5.2.4, `@astrojs/check` 0.9.10 (peer `typescript ^5 || ^6`,
  root has 5.9.3). Astro requires Node ≥ 22.12; the machine has 22.14 and bun 1.3.14.
- Astro's Bun recipe: `bun create astro`, `bun run dev|build|preview`, with a warning that
  some integrations have rough edges under bun.
- Astro's "Build with AI" page recommends the Astro Docs MCP server
  (`claude mcp add --transport http astro-docs https://mcp.docs.astro.build/mcp`), starting
  from templates, `astro add` for integrations, and verifying current APIs.
- `create-astro` writes `AGENTS.md` and `CLAUDE.md` unless `--no-ai` is passed.
- Sources: https://docs.astro.build/en/guides/build-with-ai/ ·
  https://docs.astro.build/en/guides/typescript/ · https://docs.astro.build/en/recipes/bun/ ·
  https://docs.astro.build/en/guides/upgrade-to/v7/ · https://biomejs.dev/internals/language-support/

## Prompts

> kalo udah kelar lanjut buat apps/landing starter dulu ya, pelajari https://docs.astro.build/en/guides/build-with-ai/ https://docs.astro.build/en/guides/typescript/

*"When that is done, continue with an `apps/landing` starter first; study the Astro
build-with-AI and TypeScript guides."*

Standing instructions from the same session: READMEs stay short; issue, one comment, branch,
PR; no direct commits to `main`; always pull first.
