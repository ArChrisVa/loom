# Loom design

Operate surface: a working tool used for hours next to code, styled to match Loom's website. The full brand guide lives outside the repo (the Loom brand kit's `BRAND.md`); the website's playable demo (`components/demo` in the site project) is the reference implementation. This file records what the app uses.

## The idea

A graphite room lit from above. Surfaces are dark glass: each a little lighter than what is behind it, catching a thin highlight on its top edge, casting a soft deep shadow. One colour carries meaning, the violet of the logo's loop: live, active, connected. A softer lavender is the edge light: focus, selection, checked. Everything else is greys with a faint blue cast. Calm and precise, never neon. Light comes from light sources (glows, rims, LEDs), never from decorative gradients. Dark only.

## Palette (tokens in `styles/base.css`)

| Token | Value | Use |
|---|---|---|
| `--window` | `#0c0e15` | The window body |
| `--bg` | `#10131c` | Panes: chats, files, terminals, settings |
| `--bg-shell` / `--bg-top` | `#10121a` / `#12141b` | Sidebar, tab rows and side panel; title bar and status bar (the window with a white wash) |
| `--bg-raised` / `--float` | `#161926` / `rgba(22,25,38,0.97)` | Cards; menus and popovers (with a 16px blur) |
| `--bg-sunken` | `#080a10` | Terminal, tool output and diff wells |
| `--line` / `--line-strong` | white at 7% / 12% | Dividers; stronger dividers, input outlines, the chat timeline |
| `--edge` / `--edge-2` / `--hi` | white at 8% / 14% / 10% | Glass outline (inset shadow), on hover, the lit top edge |
| `--text` / `--text-2` / `--text-3` | `#eceef4` / `#a9afbf` / `#858b9c` | Primary, secondary, meta (never dimmer than `--text-3`) |
| `--brand` | `#8c8af6` | The one meaningful colour: active tab underline, thinking dot, running chat |
| `--light` | `#c8c6fa` | Focus rings, checked controls, caret, links, meter fills |
| `--brand-deep` | `#4b47b8` | Text selection, with white text |
| `--ok` / `--warn` / `--danger` | `#4fd18b` / `#f0c38a` / `#ff8595` | Running and added; modified and needs approval; deleted, deny, stop (never violet for errors) |

Projects keep a colour, but only as the deep tint of their initial tile (`--t-*` gradients) when they have no icon. No second accent colour.

## Type

- Interface: Schibsted Grotesk (variable, bundled through `@fontsource-variable/schibsted-grotesk`), falling back to Segoe UI, which also covers Greek. Base 13px, labels 12 to 12.5px at 560 to 650, meta 11 to 11.5px with tabular numbers, panel headings 14 to 18px at 650 to 700 and -0.015em, big headings 28 to 40px at 700 and -0.03em.
- Code, terminals, paths and file names: Cascadia Code or Mono. Never for labels.

## Shape and depth

- 4px spacing base. Radii: pills (999px) for buttons and chips, 8px icon buttons and menu items, 9 to 14px fields and the composer, 12px menus and cards, 5px tiles and checkboxes. Nested corners are concentric.
- Glass: a white wash over `#0f121b`, an inset 1px top highlight, an inset 1px outline, a deep soft shadow. Borders are inset shadows so they never change layout.
- The primary action is a lit white button whose violet spill grows on hover; everything else is a glass pill.
- Bars: title bar 42px, open files row 30px, pane headers 32px, status bar 28px.

## Signature details

- The active tab is lit, with a 2px violet underline glowing under its label; its project name turns lavender.
- Dividers light up lavender while held; dragged tabs show lavender drop zones. A split pane draws no edge of its own: the active tab's underline says which one you are in.
- With the screen split, a pane's header is its handle (the grab hand): dragged, the pane moves beside another or swaps with it, through the same drop zones as a tab.
- Sidebar groups reorder by dragging, with a lavender line where the group will land. A faint line separates the groups from the projects in none.
- File icons (Files panel, Ctrl+P) are the one place with many hues: each kind of file keeps the colour it is known by, muted to about the same lightness, drawn in one hand in `FileIcon.tsx`. Tool folders (`node_modules`, `dist`, `.git`) are dimmed; `.claude` and `CLAUDE.md` take the lavender.
- Once your message has scrolled away, a slim band under the chat header keeps it pinned (one line, then its time and the arrows to the message before and after, which stay at the column's right edge whatever the message's length); the conversation passes beneath it with a blur.
- What you can do to a running task is said in words, in small pills: Run in background in glass, Stop in the red of the chat's Stop with its filled square. Send to background sits beside the lit Send as a glass key.
- A teammate is a round lavender mark with their initial, never a square: squares are projects. A green dot on its rim says they are online; away, the mark is an empty ring. It marks their chats in the sidebar, on the tab and beside their messages, and the chat header says who writes in a chat. A history being copied fills its row from the left in lavender.
- A shared project says so in the sidebar on both sides, under its own chats and a faint line: the team's name with a small people glyph, then the teammates' chats, or a line of grey text on where things stand (only you share it so far; a teammate shares it and you do not yet, with the way to share it too).
- In a chat that has changed hands every message carries, over its bubble, the mark and name of who wrote it, or You.
- What the writer of a followed chat is typing shows over the follow bar in the outline of a message box, dashed since nothing in it is sent yet.
- A chat someone else writes in has no message box: a raised bar in its place names the writer and offers the two ways to carry on, Continue here (lit) and Take a copy (glass).
- Another chat brought into a message waits in the message box as a chip: grey with a turning ring while Claude writes its notes, lavender when ready, amber if the notes could not be written. Under the sent message a small grey line names the chat that came along, as Send to background does.
- Running servers are green LEDs.
- A public link (Cloudflare Tunnel) is the one place Cloudflare's orange appears: an outlined cloud offers it, a filled one marks it open, and an orange cloud stays in the status bar while any site is public.
- The live dot is violet and sends out a ring every two seconds while Claude thinks or works, beside "Claude is working" in lavender: the only animation that loops. A finished turn ends with a green check and "Done in"; a stopped one says so, without the check.

## Motion

Ease-out `cubic-bezier(0.16, 1, 0.3, 1)` for almost everything (hovers 200 to 250ms, menus 180ms from their corner at 98% scale, new chat steps 350ms rising 4px); ease-in-out for things moving between two places; press feedback at 96%. Everything collapses under reduced motion.

## Controls

All drawn in theme: dropdowns with a drawn chevron and a glass list, checkboxes and radios that light lavender, the small Ultracode switch, fields with a lavender focus, keycaps with a lit top and dark base, light thin scrollbars, violet selection. Context menus are drawn by the app, never by the OS.

Tooltips are Loom's too, never the system's pale box: dark glass at 12px, under the control and centred on it (over it at the bottom of the window), fading in after half a second of rest, there at once when moving from one control to the next, and gone at once. Every `title` in the app goes through them (`lib/tooltips.ts`).

Settings lists its sections down the left as tabs, one section showing at a time; the chosen one carries the lit wash of the current project in the sidebar, its icon in lavender. Room for the scrollbar is always kept, so nothing shifts between a long section and a short one. On a narrow window the sections become one row that scrolls.

Settings, Team keeps the projects a team shares as a short list, each saying who else shares it (amber when nobody does yet, the one state that needs something done on another PC). Every other project waits behind Share a project: a field to find it by, a list under the sidebar's groups, and the projects with no git remote folded away at its end.

A menu can carry a small grey line that names the items under it (From the team, On this PC), and a menu opened from the bottom of the window grows upwards from its button.

A toast can offer one thing to do about what it says (Undo, Open) as a small lavender pill beside the text.

## Rules kept

No em dashes, no decorative numbering, no uppercase eyebrow labels, no gradient text or glow blobs without a source, no cards as the page structure, monospace only for code and data, no light-on-light glass.
