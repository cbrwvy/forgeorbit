/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  // `src/shared/**/*.ts` is included so Tailwind's JIT picks up class-name
  // literals defined in shared metadata (e.g. TASK_TYPES' `iconClass` /
  // `borderClass`). Without it the JIT scan misses them and the colors
  // get purged from the bundle.
  content: [
    "./src/mainview/**/*.{html,js,ts,jsx,tsx}",
    "./src/shared/**/*.ts",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
        },
        // FO-UX-VISUAL01: filled primary action and the window frame.
        "brand-solid": {
          DEFAULT: "hsl(var(--brand-solid))",
          foreground: "hsl(var(--brand-solid-foreground))",
        },
        chrome: "hsl(var(--chrome))",
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
        },
        merged: {
          DEFAULT: "hsl(var(--merged))",
          foreground: "hsl(var(--merged-foreground))",
        },
        spike: {
          DEFAULT: "hsl(var(--spike))",
          foreground: "hsl(var(--spike-foreground))",
        },
        "success-solid": "hsl(var(--success-solid))",
        "danger-solid": "hsl(var(--danger-solid))",
        "warning-solid": "hsl(var(--warning-solid))",
      },
      // 8 / 12 / 16 (FO-UX02-B). md and lg are both the 8px control radius, so
      // the ~500 existing rounded-md/-lg uses agree; xl is the 12px surface
      // radius (already Tailwind's 0.75rem) and 2xl the 16px panel radius.
      borderRadius: {
        lg: "var(--radius)",
        md: "var(--radius)",
        sm: "calc(var(--radius) - 4px)",
        xl: "var(--radius-surface)",
        "2xl": "var(--radius-panel)",
      },
      // 14 / 13 / 12px type steps and the density-driven control heights.
      fontSize: {
        title: ["var(--text-title)", { lineHeight: "var(--leading-title)", fontWeight: "600" }],
        section: ["var(--text-section)", { lineHeight: "var(--leading-section)", fontWeight: "600" }],
        body: ["var(--text-base)", { lineHeight: "var(--leading-base)" }],
        secondary: ["var(--text-secondary)", { lineHeight: "var(--leading-secondary)" }],
        caption: ["var(--text-caption)", { lineHeight: "var(--leading-caption)" }],
      },
      height: { control: "var(--control-h)", "control-sm": "var(--control-h-sm)", "control-lg": "var(--control-h-lg)" },
      minHeight: { control: "var(--control-h)", "control-sm": "var(--control-h-sm)", "control-lg": "var(--control-h-lg)" },
      width: { control: "var(--control-h)" },
      spacing: { page: "var(--space-page)", stack: "var(--space-stack)", row: "var(--space-row)" },
      zIndex: { dock: "var(--z-dock)", popover: "var(--z-popover)" },
      // FO-UX-VISUAL01: restrained, token-driven elevation. One colour
      // (--shadow) scaled by --shadow-strength, so dark mode gets deeper
      // shadows without separate literals. Replaces Tailwind's defaults for
      // every existing shadow-sm/-md/-lg/-xl/-2xl use.
      boxShadow: {
        sm: "0 1px 2px hsl(var(--shadow) / calc(0.05 * var(--shadow-strength)))",
        DEFAULT: "0 1px 3px hsl(var(--shadow) / calc(0.07 * var(--shadow-strength))), 0 1px 2px hsl(var(--shadow) / calc(0.04 * var(--shadow-strength)))",
        md: "0 4px 10px hsl(var(--shadow) / calc(0.07 * var(--shadow-strength))), 0 1px 3px hsl(var(--shadow) / calc(0.05 * var(--shadow-strength)))",
        lg: "0 10px 28px hsl(var(--shadow) / calc(0.10 * var(--shadow-strength))), 0 2px 6px hsl(var(--shadow) / calc(0.05 * var(--shadow-strength)))",
        xl: "0 16px 40px hsl(var(--shadow) / calc(0.13 * var(--shadow-strength))), 0 4px 10px hsl(var(--shadow) / calc(0.06 * var(--shadow-strength)))",
        "2xl": "0 24px 60px hsl(var(--shadow) / calc(0.18 * var(--shadow-strength))), 0 6px 16px hsl(var(--shadow) / calc(0.08 * var(--shadow-strength)))",
      },
      transitionDuration: { fast: "var(--duration-fast)", base: "var(--duration-base)", slow: "var(--duration-slow)" },
      transitionTimingFunction: { standard: "var(--ease-standard)" },
      fontFamily: {
        geist: ['"Geist Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        // Slower, calmer than tailwind's default `pulse` — used by TaskCard's
        // awaiting-glow overlay to indicate "this card is waiting on you"
        // without feeling anxious. Animates OPACITY only (compositor-friendly:
        // no per-frame repaint) — the glow itself is a static box-shadow on a
        // dedicated overlay element (see TaskCard), which is also what keeps
        // it from clobbering Tailwind's `ring-*` box-shadow on the card.
        "awaiting-pulse": {
          "0%, 100%": { opacity: "0.45" },
          "50%":      { opacity: "1" },
        },
        // Pipelines canvas: a soft pulse around the node currently
        // running/awaiting attention, using the --info token (blue) so it
        // matches the rest of the app's "in progress" color language rather
        // than introducing a new hue. Animates `outline` (+ `outline-offset`)
        // rather than `box-shadow` on purpose: Tailwind's `ring-*` utilities
        // ARE box-shadow, so a box-shadow keyframe on the same element
        // clobbered both the node's static `ring-info` and the `ring-primary`
        // selection ring for as long as the animation ran. The element pairs
        // this with `outline outline-2` so there's an outline to animate.
        "pipeline-pulse": {
          "0%, 100%": { outlineColor: "hsl(var(--info) / 0.55)", outlineOffset: "0px" },
          "50%":      { outlineColor: "hsl(var(--info) / 0)",    outlineOffset: "6px" },
        },
        // Pipelines canvas: animated "marching ants" dash offset for an
        // in-flight edge (a step currently handing off to the next one).
        "pipeline-dash": {
          "0%":   { strokeDashoffset: "24" },
          "100%": { strokeDashoffset: "0" },
        },
        // FO-UX-VISUAL01: dialogs and their backdrop fade in. Opacity only on
        // purpose: a transform would move the panel's measured box during the
        // animation (anchored popovers, geometry checks) and rebase any
        // non-portaled position:fixed descendant for its duration.
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
      },
      animation: {
        "awaiting-pulse": "awaiting-pulse 2.4s ease-in-out infinite",
        "pipeline-pulse": "pipeline-pulse 1.6s ease-in-out infinite",
        "pipeline-dash": "pipeline-dash 1s linear infinite",
        "fade-in": "fade-in var(--duration-fast) ease-out",
      },
    },
  },
  plugins: [],
};
