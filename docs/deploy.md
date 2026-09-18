# Deploying

WebBoy is a static site. There is no backend, no database and no API — the emulator runs
entirely in the browser, and the build is ten files totalling under 500 KB. Any static host
serves it; Cloudflare Pages is a good fit and has a free tier.

## Read this first

**Nobody has run this application in a browser.** Every change is verified by tests, typecheck
and build — never by looking at the rendered page, because this development environment has no
browser access and cannot reach a local server. Phases 09 and 10 are explicitly not signed off
for that reason (see `docs/handoff.md`).

That does not make it unsafe to deploy — it is a static page that touches nothing — but it does
mean **the first deploy is also the first time anyone sees it run.** Expect to find things. Deploy
to a preview URL, open it, and check it works before pointing a real domain at it.

## What is ready

| | |
|---|---|
| Output | `apps/web/dist`, 10 files, ~492 KB |
| Third-party requests at runtime | **none** — fonts are self-hosted, there is no CDN, no analytics |
| Backend | none |
| Secrets / env vars | none |
| Routing | single page, no client-side router, so no SPA fallback needed |
| Dev-only code | the `window.webboy` handle is stripped by `import.meta.env.DEV` (verified in the bundle) |

The one legal point: WebBoy ships **no ROMs and no cheat codes**, and the disclaimer renders in the
UI rather than only in the README. Players supply their own files, which are read in the browser
and never uploaded.

## Cloudflare Pages

You will need a Cloudflare account — the free tier is enough, and Pages does not require a card.
Create one at <https://dash.cloudflare.com/sign-up>. I cannot create it for you.

### Settings

Connect the Git repository, then:

| Field | Value |
|---|---|
| Framework preset | **None** |
| Build command | `npm run build` |
| Build output directory | `apps/web/dist` |
| Root directory | *(leave blank — this is an npm workspace and the build runs from the repo root)* |

Node version comes from `.nvmrc` (22). Pages otherwise defaults to a Node too old for Vite, which
requires `^20.19.0 || >=22.12.0` — that is the single most likely cause of a first build failing.

`apps/web/public/_headers` is copied into the output and sets caching: hashed assets and fonts are
immutable for a year, `index.html` is never cached hard (or a deploy would not reach anyone).

### Without a Git connection

```sh
npm run build
npx wrangler pages deploy apps/web/dist --project-name webboy
```

`wrangler` will prompt you to log in through the browser the first time.

## After the first deploy — in this order

1. **Open it and play something.** The whole point.
2. **Check the console is clean.** No 404s, no errors.
3. **Confirm nothing is requested off-origin.** Open the Network tab and check every request is
   your own domain. This is the privacy promise, and it should be verified empirically rather
   than trusted — that is `webboy-app-qa`'s standing job.
4. **Try it on a phone.** The touch controls have never met a real device; `mock/README.md` flags
   the layout as undecided for exactly this reason.

## Two headers worth adding later, deliberately left off

Both are in `apps/web/public/_headers` as comments.

**`Content-Security-Policy`.** Worth having on a page that runs user-supplied binaries. It is left
off because a policy that is slightly wrong breaks the page on load and it cannot be verified from
here. Apply this once the app is confirmed working, then re-check it:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self' blob:;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

`'unsafe-inline'` for styles is needed because a few components set inline `style` attributes.
`data:` for images is needed because save-state thumbnails are PNG data URLs.

**`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`.** These make `crossOriginIsolated`
true, which switches `RingBuffer` from a plain `ArrayBuffer` to a `SharedArrayBuffer`. That path
exists and is intended, but it is much less exercised than the fallback — and switching to the
less-tested path on the very first deploy is the wrong order. Turn them on alongside the Web
Worker in phase 10.

## Before making it public

- ~~There is no `LICENSE` file.~~ **Settled: MIT**, declared in `LICENSE` and in all three
  `package.json` files. The licence covers WebBoy's own source only — no Nintendo code, no BIOS, no
  ROMs, and the two bundled fonts keep their own OFL licences.
- The history is a retrospective import: intermediate commits are not individually buildable, only
  the tip is. Squashing before the first public push is easier now than later.
