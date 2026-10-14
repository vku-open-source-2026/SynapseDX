/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Card, PageTitle } from './ui.jsx';

// Last-resort guard: without this, a single render throw anywhere unmounts
// the whole tree (white screen) with no way back except a manual reload.
// The boundary is keyed by pathname in App.jsx so navigating resets it.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[console] render failed:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Card className="my-8">
        <PageTitle title="This page failed to render" sub="The error was logged — reload or head back to the Dashboard" />
        <pre className="bg-background rounded-2xl p-3 text-xs overflow-x-auto text-main-text mb-4">
          {error.message || String(error)}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-2xl text-sm font-medium text-white bg-gradient-to-b from-main-start to-main-end"
          >
            Reload
          </button>
          <Link
            to="/dashboard"
            className="px-4 py-2 rounded-2xl text-sm font-medium bg-slate-100 text-main-text"
          >
            Back to Dashboard
          </Link>
        </div>
      </Card>
    );
  }
}
