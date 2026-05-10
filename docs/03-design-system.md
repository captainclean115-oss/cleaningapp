# Penta — Design System

## Color Palette

### Primary Colors

- **Background:** `#F7F7F5` (warm off-white)
- **Claire purple:** `#5E5CE6` (primary brand accent, AI/intelligence)
- **Ink (primary text):** `#1A1A1A`
- **Ink soft (secondary text):** `#4A4A48`
- **Ink faint (tertiary text):** `#8A8A85`

### UI Colors

- **Line:** `#D8D6CF` (borders, dividers)
- **Line soft:** `#E8E6DF` (subtle separators)
- **Claire soft:** `rgba(94, 92, 230, 0.08)` (Claire-tinted backgrounds)
- **Claire glow:** `rgba(94, 92, 230, 0.18)` (active/hover states for Claire elements)

### Semantic Colors

- **Success/Active:** `#4ADE80` (green, status indicators)
- **Warning:** Amber range (use sparingly)
- **Error:** Red range (use sparingly)

## Typography

### Font Stack

- **Display (headlines, marketing):** Fraunces (serif)
- **Body (UI text, content):** Inter (sans-serif)
- **Technical (data, code, monospace contexts):** JetBrains Mono

### Type Scale

- Hero headline: 48-64px Fraunces 400
- Section heading: 32-40px Fraunces 400
- Page heading: 24-28px Inter 600
- Subhead: 18-20px Inter 500
- Body: 16-17px Inter 400
- Small: 14px Inter 400
- Technical/meta: 11-12px JetBrains Mono 400

### Style Notes

- Fraunces uses italics for emphasis in headlines (lighter weight, often Claire purple)
- Inter is the workhorse for UI
- JetBrains Mono should be used for any data presentation that wants a technical, precise feel — labels, codes, identifiers, status indicators

## Layout Principles

- Light mode is primary (migrated from earlier dark mode era — do not revert)
- Generous whitespace
- Soft shadows over hard borders where possible
- Rounded corners: 8-12px on cards, 6-8px on buttons, 50% on circular elements
- Hover states: subtle lift (translateY -2px) with soft shadow expansion

## Component Patterns

### Cards

- White background (`#FFFFFF`)
- 1px border in line color (`#D8D6CF`)
- Border radius 10px
- Padding 14-16px
- Hover: border becomes Claire purple, lifts 2px, soft Claire-tinted shadow

### Claire UI Elements

When representing Claire in UI:
- Use Claire purple as primary
- Use radial gradient for "intelligent" elements (orb, indicators)
- Use pulsing animation for "thinking/active" states
- Status indicator: green dot with subtle blink animation

### Buttons

- Primary: Claire purple background, white text
- Secondary: Transparent with Claire purple text and 1px Claire border
- Tertiary: Plain text in Claire purple
- All buttons: smooth 200-300ms transitions on hover

### Data Display

- Use JetBrains Mono for numbers in technical contexts
- Use Inter for narrative numbers (in sentences)
- Currency: $X,XXX format (no decimals when whole, 2 decimals when partial)
- Percentages: 24% format (no decimals unless precision matters)

## Animation Standards

- Default transition: 0.3s ease
- Hover lifts: translateY(-2px)
- Pulse animations on AI-active elements: 4s ease-in-out infinite
- Status indicator blinks: 2s ease-in-out infinite
- Loading states: subtle, not distracting

## What to Avoid

- Heavy drop shadows (keeps things modern)
- Hard black anywhere except true text contexts
- Overly bright colors outside Claire purple
- Generic AI tropes (no glowing borders on everything, no constant animation)
- Dark mode (migrated away from this — do not introduce)

## Voice and Personality

When writing UI text, error messages, empty states:
- Direct and operator-respectful
- No corporate fluff or marketing speak in functional UI
- Brief over verbose
- Helpful over apologetic
- Confident over hedging

Examples:
- ✓ "No clients yet. Add your first one."
- ✗ "It looks like there aren't any clients here yet! Why don't we add one?"
- ✓ "Schedule conflict on Friday."
- ✗ "Oops! It seems there's a small scheduling issue we should look at."
