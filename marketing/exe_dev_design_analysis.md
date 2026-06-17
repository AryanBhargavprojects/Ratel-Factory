# Design System Analysis: `exe.dev`

This document provides a detailed breakdown of the visual design system, typography, color palette, page layouts, interactive components, and micro-animations used on **exe.dev**. 

You can use this analysis and the included CSS snippets to build a similar developer-focused, high-fidelity web application for your product.

---

## 1. Design Ethos: "Hacker-Minimalist"
The core aesthetic of `exe.dev` is **minimalist, engineering-centric, and terminal-like**. It avoids typical modern gradient-heavy or soft-shadow landing page styles in favor of a clean, stark, command-line interface (CLI) inspired layout. 

### Key Characteristics:
* **Terminal Alignment**: Everything feels like a terminal session (pure black & white bases, monospace fonts, code tags, and layout grids separated by sharp borders).
* **Strict Density**: High information density. Text is kept relatively small and highly readable.
* **Functional Ornamentation**: The page is decorated using standard CLI symbols like bullet points (`&bull;` or `•`), code blocks (`code` tags), caret symbols (`›`, `‹`), and sharp solid borders instead of shadows.

---

## 2. Typography System
Monospace is used for **everything**—not just for code snippets, but also for menus, titles, buttons, and body copy. This is the single most important element in achieving their specific aesthetic.

### The Font Stack
* **Primary Font**: `'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;`
* **Google Fonts Import**:
  ```html
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ```

### Font Hierarchy & Scale
| Element | Font Size (Desktop) | Font Size (Mobile) | Font Weight | Line Height | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Hero Title** | `clamp(2.7rem, 7.2vw, 6.3rem)` | `clamp(1.75rem, 11vw, 2.75rem)` | `700` (Bold) | `1.0` | Styled for a massive impact; uses responsive clamp scaling. |
| **Section Header (H2)** | `1.5rem` | `1.25rem` | `600` (Semibold) | `1.2` | Clean, solid headings. |
| **Feature Title (H3)** | `1.0rem` | `1.0rem` | `600` (Semibold) | `1.3` | Sized identically to standard body titles. |
| **Navigation Links** | `0.85rem` | `0.75rem` | `400` / `600` | `1.6` | Smaller and lighter text. |
| **Body Text** | `0.80rem` | `0.80rem` | `400` (Regular) | `1.7` | High readability and spacious line height (`1.7`). |
| **Secondary / Meta Text**| `0.75rem` | `0.70rem` | `400` (Regular) | `1.5` | Used for descriptions, labels, and footer links. |
| **Code Tags** | `0.80rem` | `0.68rem` | `400` (Regular) | `1.0` | Custom inline blocks with padding. |

---

## 3. Color Theme System
The website uses a dynamic **Light / Dark Mode** design system. Rather than having a manual toggle, it reads the user’s operating system preferences via CSS media queries (`@media (prefers-color-scheme: dark)`).

### Color Palette Reference

```
  Light Mode (Default)                     Dark Mode
  ┌────────────────────────┐              ┌────────────────────────┐
  │ Background: #FFFFFF    │              │ Background: #111111    │
  │ Text (Main): #111111   │              │ Text (Main): #F3F4F6   │
  │ Text (Sub):  #6B7280   │              │ Text (Sub):  #9CA3AF   │
  │ Border:      #E5E7EB   │              │ Border:      #2A2A2A   │
  │ Card Fill:   #FAFAFA   │              │ Card Fill:   #1A1A1A   │
  │ Interactive: #111111   │              │ Interactive: #F3F4F6   │
  └────────────────────────┘              └────────────────────────┘
```

### 1. Default (Light Mode) Palette
* **Canvas Background**: `#ffffff` (Pure White)
* **Primary Text**: `#111111` (Deep Off-Black)
* **Secondary Text / Labels**: `#6b7280` (Medium Slate Gray) & `#4b5563` (Darker Gray)
* **Borders / Grid Lines**: `#e5e7eb` (Light Gray) & `#d1d5db` (Medium Border Gray)
* **Surface Background (Cards / Inputs)**: `#fafafa` (Warm White) & `#f3f4f6` (Off-white for code tags)
* **Accent/Primary Action**: Solid Black (`#111111`) used for buttons and highlight boundaries.

### 2. Dark Mode Palette
* **Canvas Background**: `#111111` (Off-Black / Charcoal)
* **Primary Text**: `#f3f4f6` (Light Gray-White)
* **Secondary Text**: `#9ca3af` (Slate Gray) & `#6b7280` (Medium Gray)
* **Borders / Grid Lines**: `#2a2a2a` (Charcoal Border) & `#374151` (Medium Dark Gray)
* **Surface Background (Cards / Inputs)**: `#1a1a1a` (Lighter Charcoal-Black)
* **Accent/Primary Action**: Solid Gray-White (`#f3f4f6`) used for contrast buttons.

### 3. iOS-Style Terminal Player Colors (Simulated Code View)
For interactive code displays or terminal screens, they implement a fixed Unix dark scheme:
* **Background**: `#1c1c1e` (Apple System Dark Gray)
* **Title Bar**: `#2c2c2e` (Lighter Apple Gray)
* **Active Tab**: `#3a3a3c` (Mid-tone Gray)
* **Tab Text**: `#98989d` (Muted Gray)
* **Terminal Text**: `#e5e5e7` (Silver White)
* **Terminal Prompt**: `#32d74b` (Bright Console Green)
* **URL Highlight**: `#64d2ff` (Console Sky Blue)

---

## 4. Layout Structure & Grid System
The website is structured using a vertical stack of full-width or half-width rows. It constraints readability by separating content into **two distinct viewport width categories**:

1. **Wide Content (`max-width: 1200px`)**: Used for the Navigation, Hero Header, and main multi-column feature lists.
2. **Narrow Content (`max-width: 720px`)**: Used for text-heavy features, the Testimonial Carousel, raised announcement news, and the Footer. This ensures that the lines of text remain easily readable without stretching too wide across modern screens.

```
┌─────────────────────────────────────────────────────────────────┐
│                           NAV (1200px)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                          HERO (1200px)                          │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                     FEATURES GRID (1200px)                      │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                 NARROW SECTION (720px Max-Width)                │
│                 (Testimonials, Announcements, Footer)           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Layout Elements:
* **Dynamic Full Height (`above-fold`)**: The hero container utilizes `min-height: 100dvh` (Dynamic Viewport Height) combined with flexbox column alignment. This forces the Navigation and Hero sections to perfectly fill the user's screen when they land, pushing additional sections "below the fold."
* **Horizontal Divider Accents**:
  * Instead of standard spacing margins, blocks are divided by thin `1px` borders (`border-top: 1px solid #e5e7eb`).
  * Features use a thicker top-border indicator (`border-top: 2px solid #111` or `#f3f4f6`) that anchors the eye to each item.
* **Side-by-Side Dual Column**:
  * On desktop, the main interaction forms use a two-column layout: `.hero-columns { display: grid; grid-template-columns: 1fr 1px 1fr; }` separated by a vertical `1px` border line.
  * On screens smaller than `900px`, the grid collapses into a single column (`grid-template-columns: 1fr`) with vertical spacing.

---

## 5. Interactive Components & Micro-Animations

To prevent the website from feeling flat or sterile, several subtle CSS animations and JavaScript widgets are used to create feedback loops.

### 1. The "Malleable Letter Wave" branding animation
The page contains a unique stretching animation on headings. On load, the header letters expand horizontally, snap back with an overshoot, and perform a brief letter wave.
* **Stretching (`ml-stretch`)**: Increases letter spacing to `0.35em`, snaps back to `-0.02em`, and rests at normal width.
* **Traveling Wave (`ml-wave`)**: Multi-letter stagger calculation where letters translate sequentially using CSS variables (`animation-delay: calc(var(--i) * 0.06s)`).
* **Final Bounce (`ml-bounce`)**: The final letter (such as an "e") drops down and bounces slightly when the snap-back wave completes.

### 2. Slide-In Template Drawer
When clicking "Ideas" or "Templates", a panel slides in from the right edge.
* **Backdrop**: Fades in from `opacity: 0` to `1` in `0.2s`.
* **Drawer Panel (`.ideas-panel`)**: Slides in from `transform: translateX(100%)` to `translateX(0)` in `0.25s`.
* **Lock Scroll**: JavaScript adds `overflow: hidden` to the body to prevent background scrolling while active.

### 3. Autotyping Placeholder Effect
The prompt input box animates a mock terminal sequence directly inside the `placeholder` attribute of the textarea.
* **Implementation**: A JS typing loop writes characters every `18ms`, with a brief delay (`18ms * 4`) when hitting a newline `\n`.
* **Graceful Exit**: The script cancels the animation instantly if the user focuses the textarea, replacing the placeholder with the full final prompt string to avoid interrupting user input.

### 4. Interactive Testimonial Carousel
A swipeable carousel for endorsements.
* Uses CSS flexbox on a `.carousel-track` moving with `transform: translateX()` controlled by navigation bullets or arrows.
* Uses standard CSS animations for slide transitions (`transition: transform 0.4s ease`).
* Equipped with mobile swipe capabilities listening to `touchstart` and `touchend` swipe delta (`Math.abs(dx) > 40px`).

---

## 6. Boilerplate CSS System (To Replicate This Theme)

Here is a clean, modern, single-file stylesheet blueprint. You can import this into your project to get the exact layout resets, typography constraints, colors, and dynamic light/dark schemas of `exe.dev`.

```css
/* ==========================================================================
   RESET & SYSTEM VARIABLE SYSTEM
   ========================================================================== */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  /* Font Family Stack */
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;

  /* Colors - Light Mode (Default) */
  --bg-color: #ffffff;
  --text-color: #111111;
  --text-muted: #6b7280;
  --text-dark: #4b5563;
  --border-light: #e5e7eb;
  --border-mid: #d1d5db;
  --surface-fill: #fafafa;
  --tag-fill: #f3f4f6;
  --accent-action: #111111;
  --accent-hover: #333333;
  --accent-text: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Colors - Dark Mode Override */
    --bg-color: #111111;
    --text-color: #f3f4f6;
    --text-muted: #9ca3af;
    --text-dark: #6b7280;
    --border-light: #2a2a2a;
    --border-mid: #374151;
    --surface-fill: #1a1a1a;
    --tag-fill: #2a2a2a;
    --accent-action: #f3f4f6;
    --accent-hover: #d1d5db;
    --accent-text: #111111;
  }
}

/* ==========================================================================
   BASE STYLING
   ========================================================================== */
body {
  font-family: var(--font-mono);
  background: var(--bg-color);
  color: var(--text-color);
  min-height: 100dvh;
  overflow-x: hidden;
  font-size: 0.8rem; /* Small compact default text sizing */
}

a {
  color: inherit;
  text-decoration: none;
}

/* ==========================================================================
   PAGE WRAPPERS & CONTAINERS
   ========================================================================== */
.above-fold {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
}

.hero {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  padding: 2rem;
}

/* 1200px Grid Container */
.wide-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 5rem 2rem;
}

/* 720px Text Readability Container */
.narrow-container {
  max-width: 720px;
  margin: 0 auto;
  padding: 5rem 2rem;
}

/* ==========================================================================
   COMPONENTS
   ========================================================================== */

/* Divider Border Rows */
.divider-section {
  border-top: 1px solid var(--border-light);
}

/* Feature card styles with a heavy top border accent */
.feature-block {
  padding-top: 1.5rem;
  border-top: 2px solid var(--text-color);
}

.feature-block h3 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.feature-block p {
  color: var(--text-muted);
  line-height: 1.7;
}

/* Standard Button */
.btn-primary {
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.5rem 1.25rem;
  background: var(--accent-action);
  color: var(--accent-text);
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.btn-secondary {
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.5rem 1rem;
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border-mid);
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-secondary:hover {
  border-color: var(--text-color);
  color: var(--text-color);
}

/* Monospace Code tag styling */
code {
  font-size: 0.8rem;
  background: var(--tag-fill);
  padding: 0.15em 0.35em;
  border-radius: 0.25rem;
}

/* ==========================================================================
   MEDIA QUERIES (RESPONSIVE RULES)
   ========================================================================== */
@media (max-width: 900px) {
  .hero-columns {
    grid-template-columns: 1fr;
    row-gap: 3rem;
  }
}

@media (max-width: 640px) {
  nav {
    padding: 0.75rem 1rem;
  }
  .wide-container,
  .narrow-container {
    padding: 3rem 1rem;
  }
}
```
