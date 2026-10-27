import { useEffect, useState } from 'react';
import { api } from './api';
import MondayPanel from './components/MondayPanel';
import './App.css';

function LoginChip({ label, status, onLogin }) {
  return (
    <div className={`login-chip ${status?.loggedIn ? 'is-ok' : ''}`}>
      <span className={`dot ${status?.loggedIn ? 'dot-ok' : 'dot-off'}`} />
      <strong>{label}</strong>
      {status?.loggedIn ? (
        <span className="ok">Connected{status.user ? ` · ${status.user.name || status.user.username || status.user.email}` : ''}</span>
      ) : (
        <button className="loginBtn" onClick={onLogin}>Login</button>
      )}
    </div>
  );
}

function StepHeading({ number, children }) {
  return (
    <h3>
      {number != null && <span className="step-badge">{number}</span>}
      {children}
    </h3>
  );
}

function App() {
  const [siteUrl, setSiteUrl] = useState('');
  const [siteUrlApplied, setSiteUrlApplied] = useState('');
  const [msStatus, setMsStatus] = useState(null);
  const [mondayStatus, setMondayStatus] = useState(null);
  const [skuText, setSkuText] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null); // [{sku, found, webUrl}]
  const [error, setError] = useState('');

async function fetchStatus() {
    const [ms, md] = await Promise.all([
      api.get('/api/auth/microsoft/status').then((r) => r.data),
      api.get('/api/auth/monday/status').then((r) => r.data),
    ]);
    return { ms, md };
  }

  async function refreshStatus() {
    const { ms, md } = await fetchStatus();
    setMsStatus(ms);
    setMondayStatus(md);
  }

  useEffect(() => { refreshStatus(); }, []);

  // After opening the login window, the user needs time to actually type credentials, so we
  // keep polling (rather than checking once) until that service reports logged in, or we give up.
  function pollUntilLoggedIn(which) {
    let attempts = 0;
    const maxAttempts = 60; // ~5 minutes at 5s interval
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const { ms, md } = await fetchStatus();
        setMsStatus(ms);
        setMondayStatus(md);
        const done = which === 'ms' ? ms.loggedIn : md.loggedIn;
        if (done || attempts >= maxAttempts) clearInterval(interval);
      } catch {
        if (attempts >= maxAttempts) clearInterval(interval);
      }
    }, 5000);
  }

  async function loginMicrosoft() {
    await api.post('/api/auth/microsoft/login', { siteUrl: siteUrl || undefined });
    pollUntilLoggedIn('ms');
  }

  async function loginMonday() {
    await api.post('/api/auth/monday/login');
    pollUntilLoggedIn('monday');
  }

  function applySiteUrl(e) {
    e.preventDefault();
    setResults(null);
    setSiteUrlApplied(siteUrl.trim());
  }

  const skus = skuText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  async function runSearch() {
    setError('');
    setSearching(true);
    setResults(null);
    try {
      const { data } = await api.post('/api/sharepoint/search-skus', {
        siteUrl: siteUrlApplied,
        skus,
      });
      setResults(data.results.map((r) => ({ ...r, link: r.webUrl || '', include: r.found })));
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setSearching(false);
    }
  }

  function updateResultField(index, field, value) {
    setResults((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  // Exports the current results table as a .csv file, which opens directly in Excel as a
  // normal spreadsheet (no extra library/dependency needed for this).
  function downloadResultsAsExcel() {
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['SKU', 'Found', 'Link'];
    const rows = results.map((r) => [r.sku, r.found ? 'Yes' : 'No', r.link || '']);
    const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sku-sharepoint-links.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const confirmedUpdates = (results || [])
    .filter((r) => r.include && r.link)
    .map((r) => ({ sku: r.sku, link: r.link }));

  const bothLoggedIn = msStatus?.loggedIn && mondayStatus?.loggedIn;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <div className="brand-title">SKU Link Automation</div>
            <div className="brand-subtitle">SharePoint → Monday.com</div>
          </div>
        </div>
        <div className="topbar-status">
          <LoginChip label="Microsoft" status={msStatus} onLogin={loginMicrosoft} />
          <LoginChip label="Monday.com" status={mondayStatus} onLogin={loginMonday} />
          <button className="refreshBtn" onClick={refreshStatus}>Refresh</button>
        </div>
      </header>

      <div className="container">
        <p className="hint">Clicking Login opens a real browser window (it may appear behind this one — check your taskbar). If you're already signed in there, it connects within a few seconds; otherwise sign in manually and this page will update automatically (or click "Refresh").</p>

        <div className="panel">
          <h3>SharePoint site</h3>
          <p className="hint">Enter this before logging in to Microsoft, so the login window opens directly on your site.</p>
          <form onSubmit={applySiteUrl} className="row">
            <input
              placeholder="https://yourtenant.sharepoint.com/sites/yoursite"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit">Load</button>
          </form>
        </div>

        {!bothLoggedIn && <p className="notice">Please login to both Microsoft and Monday.com above to continue.</p>}

        {bothLoggedIn && (
          <>
            <div className="panel">
              <StepHeading number={1}>Enter SKU numbers</StepHeading>
              <textarea
                rows={4}
                placeholder="Enter one or more SKUs, separated by commas or new lines"
                value={skuText}
                onChange={(e) => setSkuText(e.target.value)}
              />
              <p className="hint">{skus.length} SKU(s) entered</p>
            </div>

            {siteUrlApplied && (
              <div className="panel">
                <StepHeading number={2}>Search SharePoint</StepHeading>
                <p className="hint">Searches every document library on <strong>{siteUrlApplied}</strong> for folders named after each SKU.</p>
                <button className="primary" disabled={skus.length === 0 || searching} onClick={runSearch}>
                  {searching ? 'Searching...' : 'Search SharePoint for SKU folders'}
                </button>
              </div>
            )}

            {error && <p className="error">{error}</p>}

            {results && (
              <div className="panel">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <StepHeading number={3}>Confirm results</StepHeading>
                  <button onClick={downloadResultsAsExcel}>⬇ Download as Excel (.csv)</button>
                </div>
                <table className="table">
                  <thead><tr><th>Include</th><th>SKU</th><th>Found</th><th>Link</th></tr></thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={r.sku}>
                        <td><input type="checkbox" checked={r.include} onChange={(e) => updateResultField(i, 'include', e.target.checked)} /></td>
                        <td>{r.sku}</td>
                        <td className={r.found ? 'updated' : 'not_found'}>{r.found ? '✓ Found' : '✗ Not found'}</td>
                        <td><input value={r.link} onChange={(e) => updateResultField(i, 'link', e.target.value)} style={{ width: '100%' }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <MondayPanel updates={confirmedUpdates} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

export default App;
