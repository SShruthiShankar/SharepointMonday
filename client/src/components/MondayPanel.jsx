import { useState } from 'react';
import { api } from '../api';

// Lets the user point at a Monday.com board (by URL) and the name of its "Post" link column,
// then drives the real Monday.com UI (via the logged-in browser session) to search each SKU
// and paste its SharePoint link into that column.
export default function MondayPanel({ updates }) {
  const [boardUrl, setBoardUrl] = useState('');
  const [matchColumnName, setMatchColumnName] = useState('');
  const [postColumnName, setPostColumnName] = useState('');
  const [columns, setColumns] = useState([]);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [columnsError, setColumnsError] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadColumns() {
    setColumnsError('');
    setColumns([]);
    setMatchColumnName('');
    setPostColumnName('');
    setLoadingColumns(true);
    try {
      const { data } = await api.get('/api/monday/columns', { params: { boardUrl } });
      setColumns(data.columns || []);
      if (data.columns?.length) {
        setMatchColumnName(data.columns[0]);
        setPostColumnName(data.columns[0]);
      }
    } catch (e) {
      setColumnsError(e.response?.data?.error || e.message);
    } finally {
      setLoadingColumns(false);
    }
  }

  async function submitUpdate() {
    setError('');
    setResults(null);
    setLoading(true);
    try {
      const { data } = await api.post('/api/monday/update', {
        boardUrl,
        matchColumnName,
        postColumnName,
        updates,
      });
      setResults(data.results);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = boardUrl.trim() && matchColumnName.trim() && postColumnName.trim() && updates.length > 0;

  return (
    <div className="panel monday-panel">
      <h3><span className="step-badge">4</span>Update Monday.com</h3>
      <div className="row">
        <input
          placeholder="Monday.com board URL (e.g. https://yourcompany.monday.com/boards/123456)"
          value={boardUrl}
          onChange={(e) => setBoardUrl(e.target.value)}
          style={{ flex: 2 }}
        />
        <button disabled={!boardUrl.trim() || loadingColumns} onClick={loadColumns} style={{ flex: '0 0 auto' }}>
          {loadingColumns ? 'Loading columns...' : 'Load columns'}
        </button>
      </div>
      {columnsError && <p className="error">{columnsError}</p>}
      {columns.length > 0 && (
        <div className="row column-pickers">
          <div style={{ flex: 1 }}>
            <label className="hint">Match SKU using column</label>
            <select value={matchColumnName} onChange={(e) => setMatchColumnName(e.target.value)} style={{ width: '100%' }}>
              {columns.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="hint">Update column with link</label>
            <select value={postColumnName} onChange={(e) => setPostColumnName(e.target.value)} style={{ width: '100%' }}>
              {columns.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <p className="hint">This will open the board in the browser, find each SKU in the match column, and paste its link into the update column.</p>
      <button className="primary" disabled={!canSubmit || loading} onClick={submitUpdate}>
        {loading ? 'Updating...' : `Update ${updates.length} item(s) on Monday.com`}
      </button>
      {error && <p className="error">{error}</p>}
      {results && (
        <table className="table">
          <thead><tr><th>SKU</th><th>Status</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.sku}>
                <td>{r.sku}</td>
                <td className={r.status}>{r.status}{r.error ? `: ${r.error}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
