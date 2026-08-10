/**
 * FestO — hyrja me kredenciale (verifikim në server + cookie sesioni http-only)
 * ---------------------------------------------------------------------------
 * Shtoje këtë skedar në backend-in tuaj (Express) dhe lidhe në server.js:
 *
 *   const { attachAuth, requireAuth } = require('./festo-auth');
 *   app.use(express.json());
 *   attachAuth(app);                       // /api/login, /api/logout, /api/session
 *   app.use('/api/admin', requireAuth);    // mbron panelin e adminit
 *   app.post('/api/events', requireAuth, ...);   // mbron krijimin e eventeve
 *   app.delete('/api/admin/events/:id', requireAuth, ...);
 *
 * Variablat e ambientit (Render → Environment):
 *   ADMIN_USERNAME  = admin
 *   ADMIN_PASSWORD  = <fjalëkalimi i fortë>
 *   SESSION_SECRET  = <32+ karaktere random>
 *
 * Kredencialet NUK ndodhen në kodin e klientit — vetëm në server.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'festo_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 ditë

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Mungon variabla e ambientit: ${name}`);
  return value;
}

// Krahasim timing-safe: hash-ojmë të dyja anët për gjatësi të njëjtë.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  return crypto
    .createHmac('sha256', requiredEnv('SESSION_SECRET'))
    .update(payload)
    .digest('base64url');
}

function createToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + MAX_AGE_MS }),
    'utf8'
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  let expected;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  if (signature.length !== expected.length || !safeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookieOptions(maxAgeMs) {
  const secure = process.env.NODE_ENV === 'production';
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    secure ? 'Secure' : null,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function getSession(req) {
  return verifyToken(readCookie(req, COOKIE_NAME));
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ error: 'E paautorizuar' });
}

function attachAuth(app) {
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ ok: false });
    }

    const okUser = safeEqual(username.trim(), requiredEnv('ADMIN_USERNAME'));
    const okPass = safeEqual(password, requiredEnv('ADMIN_PASSWORD'));

    if (!okUser || !okPass) {
      // Mesazh i përgjithshëm — pa zbuluar se cila fushë ishte gabim.
      return res.status(401).json({ ok: false });
    }

    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(createToken(username.trim()))}; ${cookieOptions(MAX_AGE_MS)}`
    );
    return res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieOptions(0)}`);
    return res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = getSession(req);
    return res.json({ authenticated: Boolean(session), username: session ? session.u : null });
  });
}

module.exports = { attachAuth, requireAuth, getSession, COOKIE_NAME };
