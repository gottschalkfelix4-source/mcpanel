/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Minecraft-Palette
        grass: { top: '#8fc242', light: '#7FB238', DEFAULT: '#5B8731', dark: '#3F5F22' },
        dirt: { light: '#A97A55', DEFAULT: '#866043', dark: '#5C4130' },
        stone: {
          50: '#f2f2f4',
          100: '#d9d9de',
          200: '#b3b3bb',
          300: '#8c8c96',
          350: '#7a7a85',
          400: '#6b6b75',
          450: '#5f5f69',
          500: '#4f4f58',
          550: '#3f3f47',
          600: '#3b3b43',
          700: '#2c2c33',
          750: '#242429',
          800: '#1e1e23',
          850: '#191a1e',
          875: '#16161b',
          890: '#14141a',
          900: '#141417',
          950: '#0d0d0f',
          // Vertiefte Flächen: Eingaben, Diagramme, Fortschrittsschienen
          well: '#0f0f12',
        },
        redstone: '#E8453C',
        gold: '#FFAA00',
        diamond: '#4AEDD9',
        emerald: '#17DD62',
        lapis: '#3C44AA',
        netherite: '#443A3B',
        xp: '#7FE028',
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
        display: ['Silkscreen', '"Press Start 2P"', 'monospace'],
        sans: ['Rubik', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Erhabener Block: heller Lichtrand oben links, Schatten unten rechts
        bevel:
          'inset 2px 2px 0 0 rgba(255,255,255,0.13), inset -2px -2px 0 0 rgba(0,0,0,0.5), 0 6px 18px -8px rgba(0,0,0,0.8)',
        'bevel-lift':
          'inset 2px 2px 0 0 rgba(255,255,255,0.16), inset -2px -2px 0 0 rgba(0,0,0,0.5), 0 22px 40px -18px rgba(0,0,0,0.95), 0 0 26px -10px rgba(127,178,56,0.5)',
        // Vertiefte Fläche
        well: 'inset 2px 2px 0 0 rgba(0,0,0,0.6)',
        inner: 'inset 2px 2px 0 0 rgba(0,0,0,0.5)',
        block: '0 4px 0 0 rgba(0,0,0,0.5)',
        'block-sm': '0 3px 0 0 rgba(0,0,0,0.5)',
        'block-pressed': '0 1px 0 0 rgba(0,0,0,0.5)',
        glow: '0 0 20px -4px rgba(127,178,56,0.6)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'none' } },
        'pop-in': { from: { opacity: '0', transform: 'scale(0.94)' }, to: { opacity: '1', transform: 'none' } },
        'slide-in': { from: { opacity: '0', transform: 'translateX(-8px)' }, to: { opacity: '1', transform: 'none' } },
        'pulse-soft': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        // Pulsierender Ring am Status-Punkt
        ring: {
          '0%': { boxShadow: '0 0 0 0 rgba(23,221,98,.55)' },
          '70%': { boxShadow: '0 0 0 9px rgba(23,221,98,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(23,221,98,0)' },
        },
        // Ladeplatzhalter
        shimmer: {
          '0%': { backgroundPosition: '-320px 0' },
          '100%': { backgroundPosition: '320px 0' },
        },
        // Schwebender Block auf der Anmeldeseite
        bob: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
        float: {
          '0%': { transform: 'translateY(20px) rotate(0deg)', opacity: '0' },
          '12%': { opacity: '.5' },
          '88%': { opacity: '.5' },
          '100%': { transform: 'translateY(-620px) rotate(180deg)', opacity: '0' },
        },
        // Karte leuchtet kurz auf, wenn der Server online geht
        flash: {
          '0%': { boxShadow: '0 0 0 0 rgba(127,178,56,0), 0 6px 18px -8px rgba(0,0,0,.8)' },
          '25%': { boxShadow: '0 0 34px -2px rgba(127,178,56,.75), 0 6px 18px -8px rgba(0,0,0,.8)' },
          '100%': { boxShadow: '0 0 0 0 rgba(127,178,56,0), 0 6px 18px -8px rgba(0,0,0,.8)' },
        },
        // Laufende Diagonalstreifen im Fortschrittsbalken
        stripe: { '0%': { backgroundPosition: '0 0' }, '100%': { backgroundPosition: '28px 0' } },
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease-out',
        'pop-in': 'pop-in 0.2s ease-out',
        'slide-in': 'slide-in 0.32s ease-out backwards',
        'pulse-soft': 'pulse-soft 1s ease-in-out infinite',
        ring: 'ring 2.2s ease-out infinite',
        shimmer: 'shimmer 1.2s linear infinite',
        bob: 'bob 4.2s ease-in-out infinite',
        flash: 'flash 0.9s ease-out',
        stripe: 'stripe 0.5s linear infinite',
      },
    },
  },
  plugins: [],
};
