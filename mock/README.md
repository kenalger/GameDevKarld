# Mock — UI/UX direction

Open `webboy-ui.html` in a browser. It is a **static design mock**, not wired to the emulator.

It opens with **zero network requests**. The two typefaces are vendored in `fonts/` — no CDN, no
Google Fonts call. The app's whole promise is that nothing leaves the device, and a page that
phones a font host undercuts it before anyone reads a word.

Toggles in the masthead: **View** (loaded ↔ empty state) and **Light/Dark**. The panel tabs work.

## The critique of what ships today

`apps/web/src/styles/theme.css` is not offensive — it avoids the obvious traps. But it has no point
of view, and four specific problems:

1. **The ground is blue-grey.** `#f4f4f5` / `#131316` are cool neutrals. Cool grey is the default
   of every component library, which is exactly why it reads as generic.
2. **Everything is a rounded card.** A 6px radius on every surface, separated by fills rather than
   rules, gives a flat page of undifferentiated boxes. Nothing looks more important than anything
   else.
3. **The screen is not the hero.** Single-column stacking puts the LCD in the same visual weight
   class as a tab strip. The screen is the product.
4. **The privacy claim is throwaway.** `Your ROM stays on your device.` is the entire thesis of
   this project and it renders as small grey text next to the title.

## The direction: instrument, not dashboard

The product *is* a device. Make the page feel like a piece of hardware, and let the screen be the
largest object on it. Reference points: Braun/Dieter Rams panel labelling, technical datasheets —
not consumer web.

The organising idea, and the thing everything else follows from:

> **The device is the only filled box on the page.** Every other border, card and container is
> gone. That is what makes the screen read as the hero — it doesn't need to be inflated, it just
> needs to be the only object with a surface.

## Type

| Role | Face | Why |
|---|---|---|
| UI, headings, labels | **Archivo** (variable 400–800) | A grotesque with tight apertures that survives 10px uppercase |
| Every number and hardware value | **IBM Plex Mono** (400, 500) | Tabular figures, technical character |

Both SIL OFL 1.1, latin subset only, 55KB total, licences in `fonts/`. They were downloaded once
into the repo — nothing is fetched at runtime.

The previous pass used system stacks, which render SF Pro on macOS: the most generic typeface
available and the "no decision" decision. It fought the whole premise.

## Colour

| | Light | Dark (“Stone”) |
|---|---|---|
| Page | `#E8E4D9` bone | `#2E2B26` warm charcoal |
| Ink | `#1B1A17` | `#EAE6DB` |
| Rule | `#C9C3B3` | `#45403A` |
| Signal (lamp, underline) | `#C23B13` | `#D2673A` clay |
| Signal as text | `#B53610` | `#DD7A4E` |
| Control surface | `#DCD7C9` | `#3E3A32` |
| Device shell | `#2A2721` near-black | `#8E887C` grey plastic |
| LCD well | `#17150F → #201D16` — dark in **both** | same |

### Dark mode is Stone, not midnight

Three connected decisions:

- **`#2E2B26`, not near-black.** A mid ground has headroom in *both* directions, so wells can
  recess and plates can raise. At near-black every surface has to go lighter to read as separate —
  one direction only, and the elevation model collapses into "slightly less black".
- **Warm charcoal, hue ~38°, never navy.** It stays continuous with the bone light mode and stays
  *away* from the LCD's olive. This matters more than it sounds: `#9BBC0F` is itself a mid-value
  olive, so an olive-tinted mid-grey page would make the screen read as "brighter page" rather than
  a separate lit object.
- **The shell inverts to grey plastic.** On a dark page a near-black bezel becomes the only
  near-black mass and reads as a hole punched in the layout. `#8E887C` turns the device into an
  object on a dark desk — and it is what a real DMG looked like. The LCD well stays dark in both
  themes, because a recess is a recess.

Consequence: **the device body has to be one continuous piece.** Screen and pad share the plastic;
only software controls (pause, reset, mute, fullscreen, eject) sit off it. If only the bezel goes
grey and the pad stays on the page, the device reads as two unrelated slabs the moment the shell
inverts.

### Accent

`#D2673A` at 61% saturation rather than pushing to a hotter vermilion. Saturated warm on mid-grey
shimmers at 1–2px rules and small lamps, and gets tiring over a long session.

## Lines and surfaces

- **One rule, reused.** A 1px horizontal divider is the only line in the file. No enclosing
  outlines, no internal grid dividers, no bordered inputs, no cards.
- **Controls are surfaces, not outlines.** A filled plate with no border and no offset shadow.
  Pressing goes *darker*, because pressing pushes in.
- **Two box-shadows exist**, both doing real work: the inset that recesses the LCD well, and the
  halo on the power lamp. Nothing else has a shadow.
- **One gradient exists**, the two-stop LCD well, selling a moulded plastic lip.

The earlier pass used a hard 2px offset shadow on every key. It had drifted into neo-brutalist
cliché, which is its own kind of slop.

## Layout

```
masthead ─────────────────────────────
             [ device ]                 ← centred, max 620px, the only filled box
           transport row
        fps · frames · target
──────────────────────────────────────
 tabs
 panel content, full width, in COLUMNS
──────────────────────────────────────
```

Panels moved below the stage because full width is only worth taking if it buys something: the
cartridge specs and key bindings become two or three columns instead of one long list, and the
debugger puts registers and disassembly side by side.

## Contrast

All twelve text-on-surface pairs meet WCAG AA (4.5:1 for text, 3:1 for UI components such as the
tab underline and the power lamp). Body text clears 11:1 dark / 13:1 light. Two things fell out of
measuring rather than eyeballing:

- **Signal needs two tokens.** `--signal` is fine for a lamp or a 2px underline (3:1 bar) but fails
  as *text* in both themes. `--signal-text` is the readable variant, used for the bad-checksum
  value and the debugger's flag register.
- **A mid-value shell has no "dim".** On `#8E887C` there is nowhere to dim *to* without failing
  contrast, so the secondary label on the plastic uses the same ink and separates by size and
  tracking — which is how a silkscreened panel does it anyway.

## What this rules out, on purpose

No blue or violet anywhere. No gradient meshes or hero washes. No glassmorphism, no backdrop blur,
no neon glow. No pill-radius buttons. No card shadows. No hard offset shadows. No emoji as
iconography. No full-width gradient CTA.

## Not decided here

- **Icons.** The mock uses one inline SVG shield. A real set (~10 glyphs) should be a single stroke
  weight, 1.75–2px, square caps — one family, never mixed.
- **Motion.** Only the LCD animates. Suggest 60–90ms on press and no page transitions at all.
- **Mobile portrait.** The pad stacks below 560px, but touch-control placement for a real phone
  needs its own pass against a device.

## If you want to adopt it

- Tokens and the radius/shadow rules replace the top of `apps/web/src/styles/theme.css`.
- `App.tsx` becomes stage-then-panels instead of one stacked column.
- `TouchControls` moves *inside* the device body, and its colours become shell-relative
  (`--on-shell`, `--shell-key`) rather than page-relative — that is what lets the shell invert
  without every child needing a special case.
- Copy `fonts/` into `apps/web/public/` and keep the `@font-face` blocks. Self-hosting is not
  optional here: a Google Fonts link would be the app's first third-party request, in a product
  whose headline promise is that there are none.
