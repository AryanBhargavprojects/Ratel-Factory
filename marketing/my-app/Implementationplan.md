# Ratel Factory — Hero Section Implementation Spec

## 1. Scope & Goal
Implement the **hero section only** for the Ratel Factory landing page inside `marketing/my-app/`. Do not build any other sections, routes, or factory logic.

**Deliverable:** A single, full-viewport hero section on `app/page.tsx` (and supporting files) that matches the sci-fi / liquid-glass / glassmorphic direction described below.

## 2. Project Context
- **App location:** `marketing/my-app/`
- **Framework:** Next.js 16.2.9 (App Router)
- **React:** 19.2.4
- **Styling:** Tailwind CSS v4 (`@import "tailwindcss"` + `@theme inline` in `globals.css`)
- **Font stack:** Geist / Geist Mono by default; the hero must use the editorial serif font specified below.
- **Critical warning:** `AGENTS.md` says Next.js 16 has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.
- **No new dependencies** unless truly unavoidable. Prefer built-in Next.js + Tailwind v4 + CSS.

## 3. Content
Hero copy (centered, large):
- **Title:** `Ratel Factory`
- **Subtitle:** `Open-source software factory for your coding agent`
- **CTA Button:** `Get started`

No navigation, no extra sections, no footer for now. The hero is the only thing on the page.

## 4. Background Video
- **File:** `website_background.mp4` in `marketing/my-app/`
- **Usage:** Full-screen background video on the hero.
- **Behavior:** autoplay, loop, muted, playsinline, `object-fit: cover`, filling the entire hero section.
- **Layering:** behind the content; add a subtle dark overlay so text remains legible.
- **Accessibility / performance:** include a fallback black background color. Respect `prefers-reduced-motion` by not autoplaying if the user prefers reduced motion (display the first frame or a static dark background instead).
- Place the video inside `public/` or reference it correctly from Next.js. The file is currently at `marketing/my-app/website_background.mp4`; ensure the build can serve it (move to `public/` if needed).

## 5. Typography
- **Display font:** `Gondens` (editorial serif).
  - Demo file available at: `/Users/aryanbhargav/Library/Fonts/Gondens DEMO.otf`
  - Define a CSS `@font-face` named `Gondens` pointing to that local path.
  - Fallback stack: `"Gondens", "Times New Roman", serif`
  - **Note:** This is a demo font file. If loading the local OTF causes build or CORS issues in the browser, fall back to `"Times New Roman", serif` and document the issue. Do not ship a broken font.
- **Title treatment:** very large, elegant, high contrast, centered.
- **Subtitle treatment:** smaller, lighter weight, centered under the title, generous letter-spacing / uppercase optional.
- **CTA treatment:** small, minimal, glass-like button with subtle hover state.

## 6. Visual Direction
Sci-fi / skyfy landing page with **liquid glass / glassmorphism**:
- Dark, premium, monochrome palette driven by the video (black, charcoal, soft white, silver).
- The text should sit on or inside a subtle **frosted-glass panel** — low-opacity dark background, backdrop blur, thin light border — so it floats above the video without fully hiding it.
- Soft inner glows, faint specular highlights, and thin hairline borders are encouraged.
- Keep it minimal; the video is the star, the UI is quiet and elegant.
- Optional subtle animation: a slow text fade-in / slide-up on load, and a gentle hover lift on the CTA.

## 7. Color Palette
- **Background:** `#000000` (pure black)
- **Surface / glass:** `rgba(255, 255, 255, 0.03)` to `rgba(255, 255, 255, 0.08)` with backdrop blur
- **Border:** `rgba(255, 255, 255, 0.12)` to `rgba(255, 255, 255, 0.22)`
- **Primary text:** `#ffffff` / `#f5f5f5`
- **Muted text:** `#a1a1a1`
- Keep accents minimal; if you add one, use a very subtle cool white / silver glow rather than a loud color.

## 8. Layout
- Hero is `min-height: 100svh` or `100dvh`, full width.
- Content centered both horizontally and vertically.
- Generous whitespace. The title should dominate.
- Glass panel around the content with comfortable padding (`clamp` values for responsiveness).
- Responsive: works on desktop, tablet, and mobile. Scale typography with `clamp()`.

## 9. Interactions & Motion
- Page load: content fades/slides up gently (CSS animation / Tailwind animate utilities). Keep it subtle.
- CTA hover: subtle lift, border glow, or background shift.
- Video: loop silently.
- Respect `prefers-reduced-motion`.

## 10. Files to Create / Modify
- `marketing/my-app/app/page.tsx` — hero section component.
- `marketing/my-app/app/globals.css` — add `@font-face` for Gondens, hero base styles, glass utilities if needed. Keep existing Tailwind v4 setup intact.
- `marketing/my-app/app/layout.tsx` — update metadata (title/description) to Ratel Factory.
- Move/copy `website_background.mp4` to `marketing/my-app/public/` if Next.js requires it for static serving.

## 11. What NOT to Do
- Do not touch any factory logic in `packages/core/` or elsewhere outside `marketing/my-app/`.
- Do not add extra sections, navigation, or unrelated pages.
- Do not install animation libraries unless Tailwind/Next.js cannot achieve the desired effect with CSS alone.
- Do not commit or push code.

## 12. Verification Steps
After implementation, run:
```bash
cd marketing/my-app
npm run lint
npm run build
```
The build must pass with no errors. The dev server `npm run dev` should render the hero correctly with the video, the title, subtitle, and CTA centered with the glassmorphic treatment.

## 13. Acceptance Criteria
- [ ] Hero fills the viewport.
- [ ] Background video plays full-screen, looped, muted.
- [ ] Title reads `Ratel Factory` in the editorial serif font (Gondens, falling back to Times New Roman).
- [ ] Subtitle reads `Open-source software factory for your coding agent`.
- [ ] CTA button reads `Get started` and has a hover state.
- [ ] Glassmorphism / liquid-glass treatment is applied to the content card.
- [ ] Responsive on desktop, tablet, and mobile.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
