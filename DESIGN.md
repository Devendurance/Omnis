---
version: alpha
name: useOmnis
description: "Cosmic atmosphere for bounded financial execution: from mandate to settlement proof."
colors:
  void: "#050308"
  deepViolet: "#2B0F6E"
  vividViolet: "#7B3FF2"
  primary: "#7B3FF2"
  lavenderGlow: "#C9B7FF"
  hotWhite: "#FFFFFF"
  editorialLavender: "#F3EEFC"
  violetInk: "#14101C"
  grainViolet: "#241044"
  stateWaiting: "#C9B7FF"
  stateBlocked: "#A32945"
  stateInfo: "#2B0F6E"
typography:
  hero-wordmark:
    fontFamily: "Neue Machina, General Sans, Inter, sans-serif"
    fontSize: "140px"
    fontWeight: 800
    lineHeight: "130px"
    letterSpacing: "-2px"
  hero-wordmark-mobile:
    fontFamily: "Neue Machina, General Sans, Inter, sans-serif"
    fontSize: "48px"
    fontWeight: 800
    lineHeight: "48px"
    letterSpacing: "-1px"
  section-headline:
    fontFamily: "Neue Machina, General Sans, Inter, sans-serif"
    fontSize: "48px"
    fontWeight: 700
    lineHeight: "52px"
    letterSpacing: "-1px"
  tagline:
    fontFamily: "JetBrains Mono, IBM Plex Mono, Space Mono, monospace"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: "24px"
  nav:
    fontFamily: "JetBrains Mono, IBM Plex Mono, Space Mono, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0.5px"
  button:
    fontFamily: "JetBrains Mono, IBM Plex Mono, Space Mono, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0.5px"
  feature-list:
    fontFamily: "JetBrains Mono, IBM Plex Mono, Space Mono, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  body:
    fontFamily: "Inter, General Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "26px"
rounded:
  none: 0px
  card: 20px
  pill: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  4xl: 96px
  5xl: 128px
components:
  pill-button-dark:
    backgroundColor: "{colors.void}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "10px 24px"
    height: 40px
  pill-button-light:
    backgroundColor: "{colors.editorialLavender}"
    textColor: "{colors.violetInk}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "10px 24px"
    height: 40px
  pill-button-violet:
    backgroundColor: "{colors.vividViolet}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "10px 24px"
    height: 40px
  hero-glow-field:
    backgroundColor: "{colors.void}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 0px
  hero-glow-core:
    backgroundColor: "{colors.deepViolet}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 0px
  glow-outer:
    backgroundColor: "{colors.lavenderGlow}"
    textColor: "{colors.violetInk}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 0px
  grain-overlay:
    backgroundColor: "{colors.grainViolet}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 0px
  editorial-card:
    backgroundColor: "{colors.editorialLavender}"
    textColor: "{colors.violetInk}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: 64px
  task-card:
    backgroundColor: "{colors.editorialLavender}"
    textColor: "{colors.violetInk}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: 32px
  proof-card:
    backgroundColor: "{colors.editorialLavender}"
    textColor: "{colors.violetInk}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: 32px
  state-waiting:
    backgroundColor: "{colors.stateWaiting}"
    textColor: "{colors.violetInk}"
    typography: "{typography.nav}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  state-approval:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.nav}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  state-blocked:
    backgroundColor: "{colors.stateBlocked}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.nav}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  state-info:
    backgroundColor: "{colors.stateInfo}"
    textColor: "{colors.hotWhite}"
    typography: "{typography.nav}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
---

# useOmnis Design System

## Overview

This system preserves the supplied reference's formal world: a near-black cosmic field, soft violet-to-white glow, violet-black grain, massive centered geometric display type, lowercase monospace UI, pale lavender editorial sections, pill controls, no conventional shadows, and pinned full-viewport section transitions.

The meaning is rebuilt for useOmnis. The atmosphere represents the open range of work an agent can coordinate; the product's boundaries are carried by the **Mandate to Proof** system: a user task becomes a visible mandate, moves through policy and service checks, pauses at approval when required, settles, and ends as proof.

The visual world may feel expansive. The product must never imply unrestricted financial authority.

### Preserve / replace / reinterpret audit

| Layer | Preserve from the supplied reference | useOmnis translation |
|---|---|---|
| Preserve | `#050308` void, violet glow, `#F3EEFC` editorial lavender, `#14101C` violet ink | The dark field carries possibility; the light field carries explanation and review. |
| Preserve | Neue Machina, JetBrains Mono, Inter | Display creates presence, mono exposes machine state, and Inter keeps financial explanations readable. |
| Preserve | Grain, full-bleed panels, centered hero, corner blocks, lowercase UI | The atmosphere introduces the agentic world; the copy and state labels explain the actual financial action. |
| Preserve | Full pill buttons/inputs, 20px editorial card, no drop shadows | Pills represent controlled commands; cards hold mandates, approvals, settlement details, and proof. |
| Replace | “Limitless” or “unbounded” product meaning | The open visual field now surrounds a bounded economic sandbox. |
| Replace | Generic protocol/crypto calls to action | Use `start a task`, `review the plan`, `approve payment`, and `view proof`. |
| Reinterpret | Glow arch, pinned sections, corner feature lists, grain | These become the Mandate Line, sequential execution states, task anchors, and proof atmosphere. |

### Recommended territory: Mandate to Proof

**Mandate to Proof** is the recommended visual and interaction territory. It expresses useOmnis's actual value: the agent does not merely chat about money; it carries a financial task through an accountable route.

### Core visual asset: the Mandate Line

The Mandate Line is a luminous violet route that begins with the user's task and passes through six legible checkpoints:

1. `intent`
2. `policy`
3. `service`
4. `approval`
5. `settlement`
6. `proof`

It is not a generic progress bar. Every checkpoint corresponds to a real product state, a decision, or a record. Use it in:

- the hero, as the visual explanation of the product;
- the Task Brief, as a preview of the proposed work;
- the activity view, as the live route through service purchase and approval;
- the Proof Bundle, as the completed record;
- the hackathon demo, to make the entire flow understandable in seconds.

### High-risk product moment

The critical moment is an irreversible financial action: a service purchase or final settlement. Before money moves, the user must be able to see:

- what task is being completed;
- what the agent plans to buy;
- how much each action costs;
- what budget remains;
- whether approval is required;
- whether money has moved.

### Product rule

**Let the atmosphere suggest possibility; let the mandate line make authority visible.**

## Colors

### Dark cosmic sections

| Token | Hex | Role |
|---|---|---|
| Void Black | `#050308` | Base background for hero and dark execution sections. |
| Deep Violet Core | `#2B0F6E` | Inner glow and route depth. |
| Vivid Violet | `#7B3FF2` | Primary brand signal, active route, links, and selected action. |
| Lavender Glow | `#C9B7FF` | Outer glow, waiting state, and soft route illumination. |
| Hot White | `#FFFFFF` | Hero wordmark, dark-section copy, and inverse controls. |
| Grain Violet | `#241044` | Low-opacity noise treatment over dark sections; never a visible flat fill. |

### Editorial sections

| Token | Hex | Role |
|---|---|---|
| Editorial Pale Lavender | `#F3EEFC` | Light section and card surface. It must remain visibly lavender, never warm cream. |
| Violet Ink | `#14101C` | Text and UI on editorial surfaces. |
| Editorial Accent | `#7B3FF2` | Links, route markers, buttons, and selected controls on light sections. |

### Product state colours

| Token | Hex | Role |
|---|---|---|
| Waiting | `#C9B7FF` | The task is intact but waiting for a condition, service, or timing window. |
| Approval | `#7B3FF2` | A human decision is required before the next financial action. |
| Blocked | `#A32945` | The action cannot continue under the current policy or service state. |
| Information | `#2B0F6E` | Supporting technical or policy information on dark/inverse surfaces. |

### Semantic rules

- Keep one dominant colour moment per screen. The violet field carries the emotional weight; pale lavender provides the reading surface.
- Do not use the glow to imply that a payment is successful. Success must be written as a state such as `settled` or `proof ready`.
- Do not communicate approval, waiting, or blocking by colour alone. Pair every state with a lowercase label, icon, and plain-language explanation.
- The glow is atmosphere, not a financial-performance signal.
- Grain remains violet-black. Do not introduce orange, navy, crypto-green, or random multi-colour gradients.
- The product can use the hot white core as a focal point, but essential body copy must also have a readable non-glowing surface.

### Accessibility rules

- Use Hot White on Void Black, Deep Violet, Vivid Violet, or Blocked for inverse text.
- Use Violet Ink on Editorial Pale Lavender or Lavender Glow for light surfaces.
- Use a written status and icon alongside every state colour.
- Keep JetBrains Mono at readable sizes; do not use small, low-contrast mono text for essential instructions.
- Focus states must remain visible against both dark and light panels. Use a high-contrast outline plus a non-colour focus indicator where necessary.
- Test the glow and grain with reduced transparency and reduced motion. Texture must never impair reading.

## Typography

### Font families

- **Display:** `Neue Machina`, falling back to `General Sans`, `Inter`, sans-serif. Use for the useOmnis wordmark, hero lockup, and editorial section headlines only.
- **Monospace/UI:** `JetBrains Mono`, falling back to `IBM Plex Mono`, `Space Mono`, monospace. Use for taglines, navigation, buttons, task metadata, policy limits, and status labels.
- **Editorial body:** `Inter`, falling back to `General Sans`, `-apple-system`, `BlinkMacSystemFont`, sans-serif. Use for longer explanations, service results, approval copy, and proof details.

### Hierarchy

| Role | Family | Size | Weight | Line height | Tracking | Use |
|---|---|---:|---:|---:|---:|---|
| Hero wordmark | Neue Machina | 140px | 800 | 130px | -2px | Centered hero identity. |
| Hero wordmark mobile | Neue Machina | 48px | 800 | 48px | -1px | Mobile hero identity. |
| Tagline | JetBrains Mono | 18px | 400 | 24px | 0 | Directly below wordmark. |
| Section headline | Neue Machina | 48px | 700 | 52px | -1px | Editorial statements and section titles. |
| Navigation | JetBrains Mono | 14px | 400 | 20px | 0.5px | Lowercase links. |
| Button | JetBrains Mono | 14px | 500 | 20px | 0.5px | Lowercase commands. |
| Corner feature list | JetBrains Mono | 14px | 400 | 22px | 0 | Three-line task anchors. |
| Body | Inter | 16px | 400 | 26px | 0 | Explanations and longer product copy. |

### Rules

- Neue Machina is display-only. Never use it in a dense payment table, form, or status explanation.
- Keep all monospace UI lowercase: `start a task`, `review the plan`, `approve payment`.
- Corner feature lists contain exactly three lines per block on desktop.
- Inter carries the long-form explanation because a financial policy must be easy to read, not merely on-brand.
- Use IBM Plex Mono or JetBrains Mono for amounts, budgets, transaction fragments, policy IDs, and service prices.
- Use `font-display: swap` and preload only the fonts required for the first viewport.

## Layout

### Spacing system

Use a 4px base unit:

`4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px, 96px, 128px`

- `4–16px`: metadata, route markers, nav gaps, status-icon spacing.
- `24–48px`: command controls and tagline-to-wordmark spacing.
- `64–96px`: section and card internal spacing.
- `128px`: hero centering buffer and major section breathing room.

### Grid and containers

- Dark/glow sections remain full-bleed.
- Editorial content uses a centered maximum width of `1100px`.
- Long-form proof and policy explanations use a readable measure of `640–720px`.
- Hero: centered wordmark and tagline, with the Mandate Line faintly visible behind or beneath the lockup.
- Product workspace: conversation/intent on the left, policy and proof on the right at desktop; stack in the order `task → budget → activity → approval → proof` on mobile.

### Hero composition

The hero contains:

1. centered useOmnis wordmark;
2. tagline: `tell omnis what needs to get paid. it handles the rest.`;
3. a soft glow field and grain;
4. left corner block: `intent / policy / agent`;
5. right corner block: `service / settlement / proof`;
6. one pill CTA: `start a task`.

The corner blocks are content anchors, not decoration. Keep exactly three lines per block on desktop.

### Pinned section behaviour

Preserve the supplied reference's page-stacking model:

- each major section is a full-viewport panel;
- the current section remains pinned;
- the next section rises from below and covers it;
- dark and editorial sections alternate;
- each transition reveals another step in the Mandate Line.

Recommended section order:

1. `intent`, cosmic hero;
2. `policy`, pale editorial explanation;
3. `service`, dark machine-commerce route;
4. `approval`, pale decision surface;
5. `settlement`, dark payment state;
6. `proof`, pale proof archive.

Prototype this early. On mobile, conventional scroll is an acceptable fallback if pinned panels create jank, scroll trapping, or accessibility problems.

### Whitespace philosophy

The hero remains extremely open. The product workspace is denser, but not crowded. Do not let the cosmic atmosphere consume the space needed to understand a budget, an approval, or a settlement state.

### Responsive breakpoints

| Breakpoint | Width | Behaviour |
|---|---:|---|
| Mobile | 375–599px | Wordmark 48px, tagline 14px, corner blocks stack below hero, nav becomes a hamburger, task route becomes vertical. |
| Tablet | 600–1023px | Wordmark 80–100px, corner blocks shrink, policy and activity panels stack when necessary. |
| Desktop | 1024–1439px | 140px wordmark, full corner layout, two-column task workspace, pinned panels enabled after prototype validation. |
| Wide | 1440px+ | Wordmark may scale upward; glow expands without enlarging essential copy beyond readable measure. |

### Touch targets

Minimum target: `44px × 44px`. Keep at least `8px` between adjacent controls. Do not make the pill silhouette an excuse for tiny hit areas.

## Elevation & Depth

This system intentionally uses no conventional drop shadows. Depth comes from:

- atmospheric violet glow;
- violet-black grain;
- dark/light panel contrast;
- the pinned section stack;
- route checkpoints and receipt surfaces.

| Level | Treatment | useOmnis use |
|---|---|---|
| Flat | No shadow | Navigation, pills, corner labels, route lines. |
| Atmospheric glow | Soft radial gradient with no hard edge | Hero and dark task-route sections. |
| Grain | Fine violet-black noise at low opacity | Dark cosmic panels only. |
| Stack elevation | Incoming panel covers the previous pinned panel | Section transitions that move the Mandate Line forward. |

Never use a drop shadow to imply that money is secure or that a task is complete. Those meanings must come from explicit status and proof.

## Shapes

### Radius scale

- `9999px`: buttons, inputs, status pills, compact filters.
- `20px`: Editorial Section Cards, Task Cards, Proof Cards, and contained explanation panels.
- `0px`: full-bleed dark and editorial sections.

### Shape language

Use:

- luminous lines;
- open routes;
- checkpoints;
- pill commands;
- soft editorial rectangles;
- receipt rows;
- approval gates.

Avoid:

- literal chains;
- wallet icons as the main brand mark;
- bridges;
- coins;
- robot heads;
- infinity symbols;
- generic chat bubbles;
- hard-edged dashboards;
- upward financial arrows.

## Components

### Primary navigation

- Transparent background over the active panel.
- `24px 40px` desktop padding.
- useOmnis wordmark left.
- lowercase monospace links: `tasks`, `policies`, `services`, `proof`.
- pill CTA on the right: `start a task`.
- Text colour follows the panel: Hot White on dark, Violet Ink on editorial.

### Pill command button

- `10px 24px` padding.
- `40px` height.
- `9999px` radius.
- `1.5px` border matching the current text colour.
- Transparent base; on hover, fill inverts and text switches to the opposite register.
- Labels stay lowercase.

Recommended commands:

- `start a task`
- `review the plan`
- `approve payment`
- `view proof`
- `try again`

### Command input

- Transparent over dark panels or white over editorial panels.
- `1.5px` border matching the current text colour.
- `9999px` radius.
- `44px` height.
- JetBrains Mono at `14px`.
- Placeholder: `tell omnis what needs to get paid...`
- The input must support plain language, but its submitted result must become a structured Task Brief.

### Mandate Line

- One luminous route with six labelled checkpoints.
- The active checkpoint uses Vivid Violet or Lavender Glow depending on the panel.
- Completed checkpoints receive a written label such as `complete` or `paid`.
- Blocked checkpoints show the reason and whether money moved.
- On reduced motion, the route is static and the active checkpoint receives a high-contrast outline.

### Task Brief Card

Inherit the Editorial Section Card styling:

- Editorial Pale Lavender surface.
- Violet Ink text.
- `20px` radius.
- Full editorial module: `64px` padding; compact product card: `32px` padding.
- Show: task, recipient, amount, asset, service requirement, service budget, approval rule, and proposed next action.

Example heading: `i understand the task`.

### Policy and Budget Card

Show the authority boundary before any service purchase:

- total task budget;
- service budget;
- remaining allowance;
- allowed capabilities;
- approval threshold;
- permitted assets and recipients where relevant.

Do not hide budget data in an expandable technical drawer.

### Service Card

Use the same pale-lavender 20px card system. Show:

- service name;
- capability;
- price;
- reason for purchase;
- expected result;
- payment status;
- remaining service budget.

The service card must answer: `what is being bought, why, and for how much?`

### Approval Gate

Use a Vivid Violet pill state on either a dark route or a pale card. The approval surface must show:

- exact payment amount;
- recipient;
- asset;
- reason;
- policy threshold crossed;
- `approve payment`, `edit task`, and `cancel` actions.

Never make the user infer the approval amount from the chat transcript.

### Settlement Card

Use the 20px card treatment and display the payment state in plain language:

- `payment ready`;
- `payment settling`;
- `settled`;
- `settlement blocked`.

Technical network and transaction details remain available beneath the plain-language state.

### Proof Bundle

The final proof surface connects:

1. original user intent;
2. structured plan;
3. policy and budget;
4. service purchase and response;
5. human approval;
6. settlement transaction;
7. timestamp and final status.

Suggested heading: `task complete. proof is ready.`

### State labels

Always pair colour with text and an icon:

- `waiting, service response pending`
- `approval needed, payment exceeds automatic limit`
- `blocked, no payment was made`
- `settling, transaction submitted`
- `complete, proof available`
- `retry available`

### Error and recovery state

Every failure must answer:

- what failed;
- whether money moved;
- what remains intact;
- what action is available next.

Example:

> `service unavailable. no payment was made. try the second approved provider?`

## Do's and Don'ts

### Do

- Preserve the cosmic violet glow and grain as the emotional atmosphere.
- Use the Mandate Line to turn the atmosphere into a product-specific system.
- Alternate dark execution sections with pale editorial explanation sections.
- Keep all monospace UI lowercase.
- Keep the hero wordmark perfectly centred.
- Make the Task Brief and Budget Card visible before any approval or payment.
- Use the pale lavender card style for readable policy, service, and proof content.
- Make the final proof object as visually important as the initial task.
- Prototype pinned-panel scrolling early and provide a conventional-scroll fallback.
- Use real task text, prices, approval states, and transaction evidence in demo imagery.

### Don't

- Do not describe useOmnis as limitless, unbounded, or unrestricted.
- Do not let a glow imply profit, safety, or payment completion.
- Do not use generic AI robots, glowing brains, blockchain chains, bridges, or coin illustrations.
- Do not bring orange/navy noise, neon crypto-green, or unrelated sponsor colours into the system.
- Do not use Neue Machina for body copy or financial details.
- Do not make every screen an abstract cosmic poster; the task, policy, and proof must remain legible.
- Do not hide budgets, approval thresholds, or whether money moved.
- Do not use scroll-jacking if it blocks keyboard access, reduced motion, screen readers, or mobile recovery.
- Do not communicate state through colour alone.
- Do not claim legal, financial, security, or accessibility clearance without completing the relevant checks.

### Agent implementation guide

1. Build the Mandate Line before adding decorative glow animations.
2. Use `task → policy → service → approval → settlement → proof` as the product's primary information order.
3. Keep lowercase JetBrains Mono for commands, labels, and metadata.
4. Use Inter for explanatory copy and financial policy details.
5. Preserve the exact reference palette and pill/card silhouettes.
6. Use static route checkpoints in reduced-motion mode.
7. Test at 375px before polishing the 140px desktop hero.
8. Verify that a user can answer what the task is, what Omnis may spend, whether approval is needed, and whether money moved.
