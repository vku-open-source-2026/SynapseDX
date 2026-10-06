import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
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

function Guard({ children }) {
  const { auth } = useAuth();
  const loc = useLocation();
  if (!auth) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return children;
}

function Shell({ children }) {
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
      <Route path="/welcome" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/api-docs" element={<Shell><ApiDocs /></Shell>} />
      <Route path="/docs" element={<Shell><Docs /></Shell>} />
      <Route path="/" element={<Guard><Shell><Dashboard /></Shell></Guard>} />
      <Route path="/orgs" element={<Guard><Shell><Orgs /></Shell></Guard>} />
      <Route path="/accounts" element={<Guard><Shell><Accounts /></Shell></Guard>} />
      <Route path="/users" element={<Guard><Shell><Users /></Shell></Guard>} />
      <Route path="/roles" element={<Guard><Shell><Roles /></Shell></Guard>} />
      <Route path="/policies" element={<Guard><Shell><Policies /></Shell></Guard>} />
      <Route path="/keys" element={<Guard><Shell><Keys /></Shell></Guard>} />
      <Route path="/service-accounts" element={<Guard><Shell><ServiceAccounts /></Shell></Guard>} />
      <Route path="/workflows" element={<Guard><Shell><Workflows /></Shell></Guard>} />
      <Route path="/authorize" element={<Guard><Shell><Authorize /></Shell></Guard>} />
      <Route path="/audit" element={<Guard><Shell><Audit /></Shell></Guard>} />
      <Route path="*" element={<Guard><Shell><Dashboard /></Shell></Guard>} />
    </Routes>
  );
}
