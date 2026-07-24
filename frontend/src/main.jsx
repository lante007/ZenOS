import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight } from 'lucide-react';
import { tenantConfig } from './config';
import './styles.css';

function LandingPage() {
  return (
    <main className="landing-shell">
      <section className="landing-band" aria-label="Zenex Foundation Evidence Intelligence">
        <div className="landing-mark">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
        </div>

        <div className="landing-copy">
          <h1>{tenantConfig.orgName} Evidence Intelligence</h1>
          <p>Thirty years of Foundation Phase evidence, classified and decision-ready.</p>
          <a className="primary-action" href="/login">
            <span>Sign In</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </a>
        </div>

        <div className="powered-line">Powered by Auxeira EvidenceOS</div>
      </section>
    </main>
  );
}

function App() {
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);
