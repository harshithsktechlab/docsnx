/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        heading: ['var(--font-outfit)', 'Inter', 'sans-serif'],
        mono: ['SF Mono', 'Fira Code', 'Fira Mono', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        // The fill inside a form control. `input` above is its BORDER — both
        // `bg-input` and `border-input` read that one token, so the fill needed
        // its own. See the comment on --field in src/app/globals.css.
        field: 'hsl(var(--field))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        /*
         * The THIRD text tier. `text-faint` used to be a hand-written rule in
         * globals.css that dimmed `--muted-foreground` with an alpha — see the
         * comment on --faint there for why no alpha can reach a third tier and
         * stay readable. It is a colour now, so `text-faint` is an ordinary
         * utility and composes like one.
         */
        faint: 'hsl(var(--faint))',
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        /*
         * Extended semantic palette — THREE ROLES, NOT ONE COLOUR.
         *
         * These were fixed hex (#10b981 / #f59e0b / #ef4444) and so identical in
         * both themes, which meant `text-warning` was amber on white (1.99:1) in
         * light mode and `text-destructive` was maroon on black (1.87:1) in dark.
         * A single mid-tone cannot serve as both a fill and a label; it is
         * legible against exactly one of the two backgrounds it has to sit on.
         *
         *   DEFAULT  — solid fill, pairs with `foreground` (white). Buttons.
         *   surface  — the faint tint behind an alert or badge.
         *   text     — the label ON that surface. AA-contrast in both themes.
         *   border   — the hairline around the surface.
         *
         * Values live in src/app/globals.css so they can differ per theme; see
         * the comment in the dark block before changing any of them.
         */
        success: {
          DEFAULT: 'hsl(var(--success-solid))',
          foreground: '#ffffff',
          text: 'hsl(var(--success-text))',
          surface: 'hsl(var(--success-surface))',
          border: 'hsl(var(--success-border))',
          light: 'hsl(var(--success-solid) / 0.15)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning-solid))',
          foreground: '#ffffff',
          text: 'hsl(var(--warning-text))',
          surface: 'hsl(var(--warning-surface))',
          border: 'hsl(var(--warning-border))',
          light: 'hsl(var(--warning-solid) / 0.15)',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger-solid))',
          foreground: '#ffffff',
          text: 'hsl(var(--danger-text))',
          // A destructive CONTROL (Delete). Deliberately more saturated than
          // `text` — see the comment on --danger-action in globals.css.
          action: 'hsl(var(--danger-action))',
          surface: 'hsl(var(--danger-surface))',
          border: 'hsl(var(--danger-border))',
          light: 'hsl(var(--danger-solid) / 0.15)',
        },
        // The neutral/informational rung, so `default` alerts stop borrowing
        // `--primary` (a brand colour tuned for buttons, not for body text).
        info: {
          DEFAULT: 'hsl(var(--info-text))',
          text: 'hsl(var(--info-text))',
          surface: 'hsl(var(--info-surface))',
          border: 'hsl(var(--info-border))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
        full: '9999px',
      },
      backdropBlur: {
        glass: '20px',
      },
      /*
       * Elevation comes from CSS variables so it can differ per theme — the
       * literal `rgba(0,0,0,0.4)` these held was a lift on near-black and a grey
       * smudge on white. Values live in src/app/globals.css; `glass-light` is
       * gone because the theme-aware `glass` is now what it was trying to be.
       */
      boxShadow: {
        glass: 'var(--shadow-card)',
        'glass-hover': 'var(--shadow-hover)',
        // Tracks --primary rather than hard-coding violet, which is what these
        // two literals were an out-of-date copy of.
        glow: '0 0 0 3px hsl(var(--primary) / 0.35)',
        'glow-neon': '0 0 10px hsl(var(--primary) / 0.8), 0 0 20px hsl(var(--primary) / 0.4)',
      },
      /*
       * An 11px step, in REM. It exists because ~380 labels were written as
       * arbitrary `text-[9px]`/`text-[10px]` pixels, and FontSizeProvider scales
       * the app by moving `html { font-size }` — which absolute px ignore. So the
       * text-size stepper in /more → Appearance did nothing to a third of the
       * app's type. Anything below `text-xs` belongs on this rung, not in
       * brackets.
       */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease forwards',
        'scale-in': 'scaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.3s ease',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 1.5s linear infinite',
        'data-stream': 'dataStream 2s linear infinite',
        // Radix sets --radix-accordion-content-height on the content element;
        // animating to a fixed value instead would clip long sub-category lists.
        'accordion-down': 'accordionDown 0.2s ease-out',
        'accordion-up': 'accordionUp 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        dataStream: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        accordionDown: {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        accordionUp: {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
