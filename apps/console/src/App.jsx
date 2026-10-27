/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { Suspense, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import ServicesSidebar from './components/ServicesSidebar.jsx';
import Topbar from './components/Topbar.jsx';
import PublicHeader from './components/PublicHeader.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { ScopeProvider } from './components/Scope.jsx';
import { PageSkeleton, RouteProgress, ScrollToTop } from './components/loading.jsx';
import Login from './pages/Login.jsx';
import OidcCallback from './pages/OidcCallback.jsx';
import Landing from './pages/Landing.jsx';

// Lazy-load heavy console pages so the first paint stays fast and every
// route change shows a skeleton instead of a blank flash.
const Dashboard = React.lazy(() => import('./pages/Dashboard.jsx'));
const Orgs = React.lazy(() => import('./pages/Orgs.jsx'));
const Accounts = React.lazy(() => import('./pages/Accounts.jsx'));
const Users = React.lazy(() => import('./pages/Users.jsx'));
const Roles = React.lazy(() => import('./pages/Roles.jsx'));
const Policies = React.lazy(() => import('./pages/Policies.jsx'));
const Keys = React.lazy(() => import('./pages/Keys.jsx'));
const ServiceAccounts = React.lazy(() => import('./pages/ServiceAccounts.jsx'));
const Workflows = React.lazy(() => import('./pages/Workflows.jsx'));
const SynapseBase = React.lazy(() => import('./pages/SynapseBase.jsx'));
const SynapseQueue = React.lazy(() => import('./pages/SynapseQueue.jsx'));
const SynapseStream = React.lazy(() => import('./pages/SynapseStream.jsx'));
const SynapseFaststore = React.lazy(() => import('./pages/SynapseFaststore.jsx'));
const SynapseInference = React.lazy(() => import('./pages/SynapseInference.jsx'));
const LinkedData = React.lazy(() => import('./pages/LinkedData.jsx'));
const Authorize = React.lazy(() => import('./pages/Authorize.jsx'));
const Audit = React.lazy(() => import('./pages/Audit.jsx'));
const ApiDocs = React.lazy(() => import('./pages/ApiDocs.jsx'));
const Docs = React.lazy(() => import('./pages/Docs.jsx'));

import { appLoginUrl, isCanonicalAppHost } from './lib/site.js';

function Guard({ children }) {
  const { auth } = useAuth();
  const loc = useLocation();
  if (!auth) {
    // Multi-domain: web chinh (@) khong giu session — day ve canonical app (cloud.*) theo env.
    if (!isCanonicalAppHost()) {
      window.location.href = appLoginUrl();
      return null;
    }
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  }
  return children;
}

// Public pages: primary navigation via the header above.
function PublicLayout({ children }) {
  return (
    <div className="min-h-screen">
      <PublicHeader />
      <main className="mx-auto max-w-6xl px-4 pt-24 pb-12 sdx-page-enter">{children}</main>
    </div>
  );
}

// In-console pages (after sign-in): primary navigation via dual sidebars (Core on left, Services on right).
function ConsoleLayout({ children }) {
  const [servicesOpen, setServicesOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('synapsedx.console.services_open');
      if (saved !== null) return saved === 'true';
      return typeof window !== 'undefined' ? window.innerWidth >= 1440 : true;
    } catch {
      return true;
    }
  });

  const toggleServices = () => {
    setServicesOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('synapsedx.console.services_open', String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen">
      <ScopeProvider>
        <Sidebar />
        <ServicesSidebar open={servicesOpen} onToggle={toggleServices} />
        <Topbar servicesOpen={servicesOpen} onToggleServices={toggleServices} />
        <main
          className={`transition-all duration-200 ${
            servicesOpen ? 'console-layout-dual' : 'console-layout-single'
          } px-4 lg:px-6 pt-20 pb-12 min-w-0 sdx-page-enter`}
        >
          <div className="max-w-6xl mx-auto w-full">
            {children}
          </div>
        </main>
      </ScopeProvider>
    </div>
  );
}

// Docs pages: public when anonymous, console layout (sidebar) once signed in.
function DocsLayout({ children }) {
  const { auth } = useAuth();
  return auth ? <ConsoleLayout>{children}</ConsoleLayout> : <PublicLayout>{children}</PublicLayout>;
}

// Reset the error boundary on navigation: a recovered route must not keep
// showing a previous page's fallback.
function ResettingBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <ResettingBoundary>
      <ScrollToTop />
      <RouteProgress />
      <Suspense fallback={<LazyFallback />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/welcome" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/oidc/callback" element={<OidcCallback />} />
          <Route path="/api-docs" element={<DocsLayout><ApiDocs /></DocsLayout>} />
          <Route path="/docs" element={<DocsLayout><Docs /></DocsLayout>} />
          <Route path="/dashboard" element={<Guard><ConsoleLayout><Dashboard /></ConsoleLayout></Guard>} />
          <Route path="/orgs" element={<Guard><ConsoleLayout><Orgs /></ConsoleLayout></Guard>} />
          <Route path="/accounts" element={<Guard><ConsoleLayout><Accounts /></ConsoleLayout></Guard>} />
          <Route path="/users" element={<Guard><ConsoleLayout><Users /></ConsoleLayout></Guard>} />
          <Route path="/roles" element={<Guard><ConsoleLayout><Roles /></ConsoleLayout></Guard>} />
          <Route path="/policies" element={<Guard><ConsoleLayout><Policies /></ConsoleLayout></Guard>} />
          <Route path="/keys" element={<Guard><ConsoleLayout><Keys /></ConsoleLayout></Guard>} />
          <Route path="/service-accounts" element={<Guard><ConsoleLayout><ServiceAccounts /></ConsoleLayout></Guard>} />
          <Route path="/workflows" element={<Guard><ConsoleLayout><Workflows /></ConsoleLayout></Guard>} />
          <Route path="/base" element={<Guard><ConsoleLayout><SynapseBase /></ConsoleLayout></Guard>} />
          <Route path="/queue" element={<Guard><ConsoleLayout><SynapseQueue /></ConsoleLayout></Guard>} />
          <Route path="/stream" element={<Guard><ConsoleLayout><SynapseStream /></ConsoleLayout></Guard>} />
          <Route path="/faststore" element={<Guard><ConsoleLayout><SynapseFaststore /></ConsoleLayout></Guard>} />
          <Route path="/inference" element={<Guard><ConsoleLayout><SynapseInference /></ConsoleLayout></Guard>} />
          <Route path="/lds" element={<Guard><ConsoleLayout><LinkedData /></ConsoleLayout></Guard>} />
          <Route path="/authorize" element={<Guard><ConsoleLayout><Authorize /></ConsoleLayout></Guard>} />
          <Route path="/audit" element={<Guard><ConsoleLayout><Audit /></ConsoleLayout></Guard>} />
          <Route path="*" element={<Landing />} />
        </Routes>
      </Suspense>
    </ResettingBoundary>
  );
}

function LazyFallback() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 pt-24 pb-12">
        <PageSkeleton />
      </div>
    </div>
  );
}
