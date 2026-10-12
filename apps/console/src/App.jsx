/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import PublicHeader from './components/PublicHeader.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Orgs from './pages/Orgs.jsx';
import Accounts from './pages/Accounts.jsx';
import Users from './pages/Users.jsx';
import Roles from './pages/Roles.jsx';
import Policies from './pages/Policies.jsx';
import Keys from './pages/Keys.jsx';
import ServiceAccounts from './pages/ServiceAccounts.jsx';
import Workflows from './pages/Workflows.jsx';
import Authorize from './pages/Authorize.jsx';
import Audit from './pages/Audit.jsx';
import Landing from './pages/Landing.jsx';
import ApiDocs from './pages/ApiDocs.jsx';
import Docs from './pages/Docs.jsx';

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

// Trang ngoài: navigate chính bằng header phía trên.
function PublicLayout({ children }) {
  return (
    <div className="min-h-screen">
      <PublicHeader />
      <main className="mx-auto max-w-6xl px-4 pt-24 pb-12">{children}</main>
    </div>
  );
}

// Trang trong console (sau login): navigate chính bằng sidebar.
function ConsoleLayout({ children }) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <Topbar />
      <main className="lg:ml-[22%] px-4 lg:px-8 pt-20 lg:pt-8 pb-12 max-w-6xl">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/welcome" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/api-docs" element={<PublicLayout><ApiDocs /></PublicLayout>} />
      <Route path="/docs" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/dashboard" element={<Guard><ConsoleLayout><Dashboard /></ConsoleLayout></Guard>} />
      <Route path="/orgs" element={<Guard><ConsoleLayout><Orgs /></ConsoleLayout></Guard>} />
      <Route path="/accounts" element={<Guard><ConsoleLayout><Accounts /></ConsoleLayout></Guard>} />
      <Route path="/users" element={<Guard><ConsoleLayout><Users /></ConsoleLayout></Guard>} />
      <Route path="/roles" element={<Guard><ConsoleLayout><Roles /></ConsoleLayout></Guard>} />
      <Route path="/policies" element={<Guard><ConsoleLayout><Policies /></ConsoleLayout></Guard>} />
      <Route path="/keys" element={<Guard><ConsoleLayout><Keys /></ConsoleLayout></Guard>} />
      <Route path="/service-accounts" element={<Guard><ConsoleLayout><ServiceAccounts /></ConsoleLayout></Guard>} />
      <Route path="/workflows" element={<Guard><ConsoleLayout><Workflows /></ConsoleLayout></Guard>} />
      <Route path="/authorize" element={<Guard><ConsoleLayout><Authorize /></ConsoleLayout></Guard>} />
      <Route path="/audit" element={<Guard><ConsoleLayout><Audit /></ConsoleLayout></Guard>} />
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
