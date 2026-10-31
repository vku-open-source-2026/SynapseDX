/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Central loading primitives: Spinner, Dots, shimmer Skeletons,
 * table/card/list/page fallbacks, overlay + top route progress.
 * Every page should reuse these instead of raw "Loading…" text so
 * the whole console feels smooth and consistent.
 */
import React from 'react';
import { useLocation } from 'react-router-dom';

const SIZE = {
  xs: 'h-3.5 w-3.5 border-2',
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[3px]',
  xl: 'h-12 w-12 border-4',
};

export function Spinner({ size = 'md', className = '', label = 'Loading…' }) {
  const s = SIZE[size] || SIZE.md;
  return (
    <span role="status" aria-label={label} className={`sdx-spinner ${s} ${className}`} />
  );
}

export function Dots({ className = '', label = 'Loading…' }) {
  return (
    <span role="status" aria-label={label} className={`sdx-dots ${className}`}>
      <span />
      <span />
      <span />
    </span>
  );
}

/** Show children only after `ms` to avoid flashing on fast fetches. */
export function Delayed({ ms = 180, children, fallback = null }) {
  const [show, setShow] = React.useState(ms <= 0);
  React.useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  if (!show) return fallback;
  return children;
}

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`sdx-skeleton ${className}`} />;
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} aria-label="Loading content" role="status">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={i === lines - 1 ? 'h-4 w-2/3' : 'h-4 w-full'}
        />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} role="status" aria-label="Loading table">
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-2">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-9 ${c === 0 ? 'w-1/3' : 'flex-1'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ className = '' }) {
  return (
    <div className={`rounded-3xl bg-white shadow-md p-6 space-y-3 ${className}`} role="status" aria-label="Loading card">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-9 w-1/4" />
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

export function CardsSkeleton({ count = 4, className = '' }) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 ${className}`} role="status" aria-label="Loading cards">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 4, className = '' }) {
  return (
    <ul className={`space-y-2 ${className}`} role="status" aria-label="Loading list">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </li>
      ))}
    </ul>
  );
}

/** Route-change fallback: title bar + card grid shimmer. */
export function PageSkeleton({ rows = 5, cols = 3 }) {
  return (
    <div className="sdx-page-enter" role="status" aria-label="Loading page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="bg-white rounded-3xl shadow-md p-6">
        <Delayed ms={120}>
          <TableSkeleton rows={rows} cols={cols} />
        </Delayed>
      </div>
    </div>
  );
}

/** Small inline row loader (expanding rows, nested fetches). */
export function InlineLoader({ text = 'Loading…', size = 'sm' }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-normal-text" role="status">
      <Spinner size={size} label={text} />
      {text}
    </span>
  );
}

/** Full-screen overlay for sign-in / OIDC / blocking mutations. */
export function LoadingOverlay({ text = 'Loading…', transparent = false }) {
  return (
    <div
      role="status"
      aria-label={text}
      className={`fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 ${
        transparent ? 'bg-white/60 backdrop-blur-[2px]' : 'bg-background/80 backdrop-blur-[2px]'
      }`}
    >
      <Spinner size="xl" label={text} />
      <p className="text-sm text-normal-text">{text}</p>
    </div>
  );
}

/**
 * Thin gradient progress bar pinned to the top of the viewport.
 * Auto-plays on every route change, then fades out — gives instant
 * feedback even when a lazy chunk resolves in <300ms.
 */
export function RouteProgress() {
  const { pathname, search } = useLocation();
  const [active, setActive] = React.useState(false);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setActive(true);
    const t = setTimeout(() => setActive(false), 450);
    return () => clearTimeout(t);
  }, [pathname, search]);
  if (!active) return null;
  return (
    <div className="sdx-route-progress" role="status" aria-label="Loading page" />
  );
}

/** Scroll to top on every navigation so skeletons start in view. */
export function ScrollToTop() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }, [pathname]);
  return null;
}
