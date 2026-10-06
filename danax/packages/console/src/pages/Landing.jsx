import React from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faKey,
  faLayerGroup,
  faRobot,
  faShieldHalved,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import PublicHeader from '../components/PublicHeader.jsx';

const FEATURES = [
  { icon: faShieldHalved, title: 'IAM kiểu AWS', text: 'Organization → Account → User → Role → Policy JSON (Allow/Deny, Condition), authorize + simulator + audit log.' },
  { icon: faKey, title: 'Token đa dạng', text: 'JWT ngắn hạn, refresh xoay vòng nguyên tử, API key, service account, OIDC Authentik/Keycloak.' },
  { icon: faBolt, title: 'API Gateway', text: 'Điểm vào duy nhất: auth, rate-limit Redis, principal propagation, tracing, /ready aggregate.' },
  { icon: faLayerGroup, title: 'Cụm dữ liệu lõi', text: 'Postgres + Redis + S3-compatible, schema versioned, seed idempotent, backup/restore.' },
  { icon: faRobot, title: 'Workflow n8n', text: 'Control-plane trên engine ngoài: templates versioned, activate/execute, trigger thật.' },
  { icon: faWandMagicSparkles, title: 'SDK + CLI + UI', text: 'JS/TS, Python, Go, CLI zero-dep và Console quản trị — cùng một API.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      <PublicHeader />

      <main className="mx-auto max-w-6xl px-4 pt-32 pb-16 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-main-text leading-tight">
          Nền tảng PaaS <span className="bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">mở</span>
          <br />
          cho hạ tầng của bạn
        </h1>
        <p className="mt-4 text-normal-text max-w-2xl mx-auto">
          synapsedx là Tier-1 PaaS open source (Apache-2.0): API gateway, IAM phong cách AWS,
          cụm dữ liệu lõi và workflow n8n — quản trị qua Console, SDK đa ngôn ngữ và CLI.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link to="/login" className="px-6 py-2.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end shadow-md">
            Mở Console
          </Link>
          <Link to="/api-docs" className="px-6 py-2.5 rounded-2xl bg-white font-medium text-main-text shadow-md">
            Khám phá API
          </Link>
        </div>
        <div className="mt-6 inline-block bg-white rounded-2xl shadow-sm px-4 py-2 text-xs font-mono text-main-text">
          docker compose up -d --build
        </div>

        <div className="mt-14 grid md:grid-cols-3 gap-4 text-left">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-white rounded-3xl shadow-md p-6">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-white bg-gradient-to-b from-main-start to-main-end mb-3">
                <FontAwesomeIcon icon={f.icon} />
              </div>
              <h3 className="font-semibold text-main-text">{f.title}</h3>
              <p className="text-sm text-normal-text mt-1">{f.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 bg-white rounded-3xl shadow-md p-8 text-left">
          <h2 className="text-2xl font-semibold text-main-text">Chạy trong 3 lệnh</h2>
          <pre className="mt-3 bg-background rounded-2xl p-4 text-xs font-mono overflow-x-auto text-main-text">
{`cp .env.example .env   # đổi secret change_me_*
docker compose up -d --build
open http://localhost:3000   # login demo@acme.local / org acme`}
          </pre>
        </div>
      </main>

      <footer className="pb-10 text-center text-xs text-normal-text">
        synapsedx · Apache-2.0 · Tier-1 PaaS
      </footer>
    </div>
  );
}
