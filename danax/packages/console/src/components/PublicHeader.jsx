import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBars, faRightToBracket, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';

const LINKS = [
  { to: '/', label: 'Trang chủ' },
  { to: '/api-docs', label: 'API Docs' },
  { to: '/docs', label: 'Docs' },
];

export default function PublicHeader() {
  const [open, setOpen] = useState(false);
  const { auth } = useAuth();
  return (
    <header className="fixed z-50 top-0 left-0 w-full bg-white/70 backdrop-blur-md shadow-sm">
      <div className="flex items-center justify-between px-4 mx-auto max-w-6xl h-16">
        <Link
          to="/"
          className="text-xl font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent"
        >
          danax
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="px-3 py-1.5 text-normal-text hover:text-main-blue">
              {l.label}
            </Link>
          ))}
          <Link
            to={auth ? '/dashboard' : '/login'}
            className="ml-2 px-4 py-1.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end"
          >
            <FontAwesomeIcon icon={faRightToBracket} className="mr-1" />
            {auth ? 'Console' : 'Đăng nhập'}
          </Link>
        </nav>
        <button onClick={() => setOpen(!open)} className="md:hidden text-xl text-normal-text">
          <FontAwesomeIcon icon={open ? faXmark : faBars} />
        </button>
      </div>
      {open && (
        <div className="md:hidden bg-white border-t border-slate-100 px-4 py-2 shadow-md">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} onClick={() => setOpen(false)} className="block py-2 text-main-text text-sm">
              {l.label}
            </Link>
          ))}
          <Link
            to={auth ? '/dashboard' : '/login'}
            onClick={() => setOpen(false)}
            className="block py-2 text-sm font-medium text-main-blue"
          >
            {auth ? 'Vào Console' : 'Đăng nhập'}
          </Link>
        </div>
      )}
    </header>
  );
}
