/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Poppins', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      'main-blue': '#4FACFE',
      'second-blue': '#00F2FE',
      'main-start': '#00F2FE',
      'main-end': '#4FACFE',
      'normal-text': '#6C7580',
      'main-text': '#4B5563',
      background: '#f6f7fb',
      emerald: { 500: '#10b981', 600: '#059669' },
      red: { 400: '#f77170', 500: '#ef4444', 600: '#dc2626' },
      amber: { 400: '#fbbf24', 500: '#f59e0b' },
      slate: { 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 500: '#64748b' },
    },
  },
  plugins: [],
};
