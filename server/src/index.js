import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import msAuthRouter from './routes/msAuth.js';
import sharepointRouter from './routes/sharepoint.js';
import mondayAuthRouter from './routes/mondayAuth.js';
import mondayRouter from './routes/monday.js';

const app = express();
const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Note: login state lives in the persistent Playwright browser profiles (server/.browser-data),
// not in cookies/sessions here, so no session middleware is needed.
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth/microsoft', msAuthRouter);
app.use('/api/sharepoint', sharepointRouter);
app.use('/api/auth/monday', mondayAuthRouter);
app.use('/api/monday', mondayRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
