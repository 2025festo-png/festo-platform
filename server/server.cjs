const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');

// 🔐 Moduli i hyrjes (kredencialet verifikohen VETËM në server)
const { attachAuth, requireAuth } = require('./festo.auth.cjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required for Render + express-rate-limit)
app.set('trust proxy', 1);

// ============================================================
// 🛡️ HELMET v8 — CSP e zgjeruar për Google Fonts + jsPDF CDN
// ============================================================
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com",
                "https://cdn.jsdelivr.net",
                "https://js.cloudflare.com"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com",
                "https://cdn.jsdelivr.net"
            ],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            mediaSrc: ["'self'", "https:", "blob:"],
            connectSrc: ["'self'", "https:"],
            fontSrc: [
                "'self'",
                "https:",
                "data:",
                "https://fonts.gstatic.com"
            ],
            frameSrc: ["'self'"]
        }
    }
}));

// ============================================================
// KONFIGURIMI CLOUDINARY
// ============================================================
cloudinary.config({
    cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    api_key: (process.env.CLOUDINARY_API_KEY || '').trim(),
    api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim()
});

// ============================================================
// KONFIGURIMI MULTER
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Formati i skedarit nuk mbështetet'));
        }
    }
});

// ============================================================
// 🛡️ RATE LIMITING PËR UPLOAD
// ============================================================
const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: { error: 'Shumë kërkesa, provo përsëri më vonë.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
});

// 🛡️ Rate-limit për urime/mesazhe (parandalon spam nga një mysafir/IP)
const messageLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: { error: 'Shumë mesazhe të dërguara. Provo përsëri pas pak minutash.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
});

// 🛡️ Rate-limit për login (mbrojtje nga brute-force te kredencialet e adminit)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Shumë prova hyrjeje. Provo përsëri pas 15 minutash.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
});

// ============================================================
// RRUGËT PËR FAQET - PRODUCTION (RENDER)
// ============================================================
const publicPath = path.join(process.cwd(), 'public');

app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.static(publicPath, { index: false }));

// ============================================================
// 🔐 RRUGËT E HYRJES
// ⚠️ loginLimiter vendoset PARA attachAuth(app) — Express e ekzekuton sipas
// rendit të regjistrimit, kështu që mbron /api/login pa prekur festo.auth.cjs.
// ============================================================
app.use('/api/login', loginLimiter);
attachAuth(app);

// ============================================================
// FUNKSIONI NDIHMËS PËR PARSIMIN E GUESTS
// ============================================================
function parseGuests(guests) {
    if (!guests) return [];
    if (Array.isArray(guests)) return guests;
    if (typeof guests === 'string') {
        try { return JSON.parse(guests); } catch (e) { return []; }
    }
    return [];
}

// ============================================================
// 🚫 FILTRIM BAZË I PËRMBAJTJES (mesazhe/urime nga mysafirët)
// Ky ËSHTË vetëm mekanizmi — LISTA e fjalëve e mban ti, te Render →
// Environment → BLOCKED_WORDS, e ndarë me presje, p.sh.:
//   BLOCKED_WORDS=fjala1,fjala2,shprehja e tretë
// Pa e vendosur këtë variabël, filtri thjesht s'bën asgjë (i çaktivizuar).
// Krahasimi injoron shkronja të mëdha/vogla dhe theksat (á, ë, ç, etj.)
// ============================================================
const BLOCKED_WORDS = (process.env.BLOCKED_WORDS || '')
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean);

function normalizeForFilter(text) {
    return String(text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // heq shenjat diakritike (á→a, ë→e, etj.)
}

function containsBlockedWord(text) {
    if (!text || BLOCKED_WORDS.length === 0) return false;
    const normalized = normalizeForFilter(text);
    return BLOCKED_WORDS.some(word => word && normalized.includes(normalizeForFilter(word)));
}

// ============================================================
// 🎟️ TOKENI I ORGANIZATORIT (çiftit) — pa nevojë për migrim DB
// Gjenerohet si "nënshkrim" i ID-së së eventit; kushdo që ka linkun
// e saktë (me ?token=...) mund të menaxhojë VETËM galerinë e atij
// eventi — jo listën e të ftuarve, jo eventet e tjerë.
// ⚠️ Për siguri më të fortë, vendos ORGANIZER_TOKEN_SECRET si variabël
// mjedisi në Render. Nëse mungon, përdoret një "fallback" bazuar te
// DATABASE_URL, që është gjithsesi sekret dhe s'e njeh dot dikush nga jashtë.
const ORGANIZER_TOKEN_SECRET =
    process.env.ORGANIZER_TOKEN_SECRET ||
    process.env.DATABASE_URL ||
    'festo-organizer-fallback-secret';

function getOrganizerToken(eventId) {
    return crypto
        .createHmac('sha256', ORGANIZER_TOKEN_SECRET)
        .update(String(eventId))
        .digest('base64url')
        .slice(0, 20);
}

function isValidOrganizerToken(eventId, token) {
    if (!token) return false;
    const expected = getOrganizerToken(eventId);
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function requireOrganizerToken(req, res, next) {
    (async () => {
        try {
            const { eventId } = req.params;
            const token = req.query.token || (req.body && req.body.token);
            const event = await resolveEvent(eventId);
            if (!event) {
                return res.status(404).json({ error: 'Eventi nuk u gjet' });
            }
            if (!isValidOrganizerToken(event.id, token)) {
                return res.status(403).json({ error: 'Qasje e paautorizuar. Linku i organizatorit nuk është i vlefshëm.' });
            }
            req.resolvedEvent = event;
            next();
        } catch (error) {
            console.error('❌ Error verifying organizer token:', error);
            res.status(500).json({ error: error.message });
        }
    })();
}

// ============================================================
// LIDHJA ME NEON DATABASE
// ============================================================
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    idleTimeoutMillis: 0
});

pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection error:', err);
    } else {
        console.log('✅ Database connected successfully to Neon');
    }
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
});

pool.on('connect', () => {
    console.log('✅ New DB connection established');
});

// ============================================================
// 🔒 ID PUBLIKE E EVENTIT — zëvendëson numrin sekuencial në URL
// që dikush të mos mund të "hamendësojë" eventet e tjerëve duke
// provuar /event/1, /event/2, /event/3... (ID enumeration).
// Migrim i lehtë, i sigurt për ripërsëritje — shton kolonën vetëm
// nëse mungon, s'prek asnjë të dhënë ekzistuese.
// ============================================================
pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS public_id TEXT')
    .then(() => pool.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS events_public_id_idx ON events (public_id) WHERE public_id IS NOT NULL'
    ))
    .catch(err => console.error('⚠️ Migrimi i public_id dështoi:', err.message));

function generatePublicId() {
    // ~12 karaktere, e paparashikueshme — s'zbulon asgjë për numrin e brendshëm
    return crypto.randomBytes(9).toString('base64url');
}

// Sigurohet që një rresht eventi ka public_id; nëse jo, e gjeneron dhe e ruan.
// Kështu edhe eventet e krijuara para këtij ndryshimi marrin automatikisht
// një ID publike herën e parë që preken (nga admini ose nga një kërkesë guest).
async function ensurePublicId(eventRow) {
    if (eventRow.public_id) return eventRow.public_id;
    const publicId = generatePublicId();
    await pool.query('UPDATE events SET public_id = $1 WHERE id = $2', [publicId, eventRow.id]);
    eventRow.public_id = publicId;
    return publicId;
}

// Gjen eventin nga parametri i URL-së — pranon ose public_id (rasti normal, i ri)
// ose numrin e vjetër sekuencial (për kompatibilitet me linqe/QR të krijuara më parë).
async function resolveEvent(idParam) {
    if (!idParam) return null;
    const isNumeric = /^\d+$/.test(String(idParam));
    const query = isNumeric
        ? 'SELECT * FROM events WHERE id = $1'
        : 'SELECT * FROM events WHERE public_id = $1';
    const result = await pool.query(query, [idParam]);
    if (result.rows.length === 0) return null;
    const event = result.rows[0];
    await ensurePublicId(event);
    return event;
}

// ============================================================
// 🗑️ POLITIKË RUAJTJEJE — fshin automatikisht foto/video të vjetra
// (kursen hapësirë/kosto në Cloudinary). E ÇAKTIVIZUAR si parazgjedhje —
// aktivizohet VETËM nëse vendos MEDIA_RETENTION_DAYS si variabël mjedisi
// në Render (p.sh. MEDIA_RETENTION_DAYS=180 → fshin media më të vjetra se
// 6 muaj). Nuk prek urimet as vetë eventin/listën e të ftuarve.
// ============================================================
const MEDIA_RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS, 10);

async function cleanupOldMedia() {
    if (!MEDIA_RETENTION_DAYS || MEDIA_RETENTION_DAYS <= 0) return;
    try {
        const cutoff = new Date(Date.now() - MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            'SELECT id, cloudinary_id, type FROM media WHERE created_at < $1',
            [cutoff]
        );
        for (const item of result.rows) {
            if (item.cloudinary_id) {
                try {
                    await cloudinary.uploader.destroy(item.cloudinary_id, {
                        resource_type: item.type === 'video' ? 'video' : 'image'
                    });
                } catch (err) {
                    console.error('⚠️ Cleanup: nuk u fshi nga Cloudinary:', err.message);
                }
            }
            await pool.query('DELETE FROM media WHERE id = $1', [item.id]);
        }
        if (result.rows.length > 0) {
            console.log(`🗑️ Cleanup automatik: u fshinë ${result.rows.length} media më të vjetra se ${MEDIA_RETENTION_DAYS} ditë.`);
        }
    } catch (err) {
        console.error('❌ Gabim në cleanup automatik të medias:', err.message);
    }
}

if (MEDIA_RETENTION_DAYS > 0) {
    console.log(`🗑️ Politika e ruajtjes aktive: media më e vjetër se ${MEDIA_RETENTION_DAYS} ditë do të fshihet automatikisht.`);
    cleanupOldMedia();
    setInterval(cleanupOldMedia, 24 * 60 * 60 * 1000);
}

// ============================================================
// API PUBLIKE
// ============================================================
app.get('/api/test', (req, res) => {
    res.json({ message: 'Serveri funksionon! 🚀' });
});

// ============================================================
// KRIJO EVENT 🔐
// ============================================================
app.post('/api/events', requireAuth, async (req, res) => {
    try {
        const { eventName, firstName, secondName, date, venue, guests } = req.body;

        if (!eventName || !guests || !Array.isArray(guests) || guests.length === 0) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const host = req.get('host');
        const protocol = req.get('x-forwarded-proto') || 'https';

        const defaultLayout = [];
        let tableNum = 1;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 5; c++) {
                defaultLayout.push({ table: tableNum++, row: r, col: c });
            }
        }

        const result = await pool.query(
            `INSERT INTO events (event_name, first_name, second_name, date, venue, guests, layout)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [eventName, firstName || '', secondName || '', date, venue || '', JSON.stringify(guests), JSON.stringify(defaultLayout)]
        );

        const eventId = result.rows[0].id;
        const publicId = generatePublicId();
        const qrUrl = `${protocol}://${host}/event/${publicId}`;
        const qrCode = await QRCode.toDataURL(qrUrl);

        await pool.query(`UPDATE events SET qr_code = $1, public_id = $2 WHERE id = $3`, [qrCode, publicId, eventId]);

        // 🔗 Linku special për organizatorin (çiftin) — menaxhon vetëm galerinë e këtij eventi
        const organizerToken = getOrganizerToken(eventId);
        const organizerUrl = `${protocol}://${host}/organizer/${publicId}?token=${organizerToken}`;

        res.status(201).json({
            eventId: publicId,
            qrCode: qrCode,
            qrUrl: qrUrl,
            organizerUrl: organizerUrl,
            message: 'Eventi u krijua me sukses!'
        });
    } catch (error) {
        console.error('❌ Error creating event:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR TË GJITHA EVENTET 🔐
// ============================================================
app.get('/api/events', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, event_name, first_name, second_name, date, venue, guests, created_at, public_id FROM events ORDER BY created_at DESC'
        );

        const events = await Promise.all(result.rows.map(async e => ({
            id: e.id,
            eventName: e.event_name,
            firstName: e.first_name,
            secondName: e.second_name,
            date: e.date,
            venue: e.venue,
            guests: parseGuests(e.guests),
            createdAt: e.created_at,
            organizerToken: getOrganizerToken(e.id),
            publicId: await ensurePublicId(e)
        })));

        res.json(events);
    } catch (error) {
        console.error('❌ Error fetching events:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR EVENTIN (publik) — pranon ID publike (ose numrin e vjetër)
// ============================================================
app.get('/api/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const event = await resolveEvent(eventId);

        if (!event) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        res.json({
            id: event.public_id,
            eventName: event.event_name,
            firstName: event.first_name,
            secondName: event.second_name,
            date: event.date,
            venue: event.venue,
            guests: parseGuests(event.guests),
            qrCode: event.qr_code,
            layout: event.layout,
            createdAt: event.created_at
        });
    } catch (error) {
        console.error('❌ Error fetching event:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// KËRKO TË FTUAR (publik)
// ============================================================
app.get('/api/events/:eventId/guest/:name', async (req, res) => {
    try {
        const { eventId, name } = req.params;
        const decodedName = decodeURIComponent(name).trim().toLowerCase();

        const event = await resolveEvent(eventId);

        if (!event) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(event.guests);
        const guest = guests.find(g => g.name && g.name.trim().toLowerCase() === decodedName);

        if (!guest) {
            return res.status(404).json({ error: `I ftuari "${req.params.name}" nuk u gjet në listë.` });
        }

        const tableGuests = guests.filter(g => g.table === guest.table);
        res.json({ guest: guest, tableGuests: tableGuests, tableNumber: guest.table });
    } catch (error) {
        console.error('❌ Error searching guest:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// UPLOAD VIDEO (publik, me rate limiting)
// ============================================================
app.post('/api/upload-video', uploadLimiter, upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nuk u gjet asnjë video' });

        const base64 = req.file.buffer.toString('base64');
        const dataUri = `data:${req.file.mimetype};base64,${base64}`;

        const result = await cloudinary.uploader.upload(dataUri, {
            resource_type: 'video'
        });

        res.json({ success: true, url: result.secure_url, public_id: result.public_id });
    } catch (error) {
        console.error('❌ UPLOAD ERROR:', error);
        res.status(500).json({ error: error.message, http_code: error.http_code || null });
    }
});

// ============================================================
// UPLOAD PHOTO (publik, me rate limiting)
// ============================================================
app.post('/api/upload-photo', uploadLimiter, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nuk u gjet asnjë foto' });

        const base64 = req.file.buffer.toString('base64');
        const dataUri = `data:${req.file.mimetype};base64,${base64}`;

        const result = await cloudinary.uploader.upload(dataUri, {
            resource_type: 'image'
        });

        res.json({ success: true, url: result.secure_url, public_id: result.public_id });
    } catch (error) {
        console.error('❌ UPLOAD ERROR:', error);
        res.status(500).json({ error: error.message, http_code: error.http_code || null });
    }
});

// ============================================================
// RUAJ MEDIA (publik)
// ============================================================
app.post('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, type, message, fileUrl, thumbnailUrl, cloudinaryId, tableNumber } = req.body;

        // ✅ Validim i qartë — nëse mungon diçka thelbësore, kthe gabim tani,
        // jo insert të pjesshëm/të dështuar në heshtje.
        if (!name || !type || !fileUrl) {
            return res.status(400).json({ error: 'Të dhëna të paplota: mungon name, type ose fileUrl' });
        }

        // 🚫 Filtrim bazë përmbajtjeje (nëse BLOCKED_WORDS është konfiguruar)
        if (containsBlockedWord(name) || containsBlockedWord(message)) {
            return res.status(400).json({ error: 'Përmbajtja përmban tekst të papërshtatshëm. Ju lutem ndryshojeni.' });
        }

        // ✅ Sigurohemi që eventi ekziston përpara se të ruajmë media për të,
        // që të mos humbasë ngarkimi në heshtje nëse eventId është gabim.
        const event = await resolveEvent(eventId);
        if (!event) {
            return res.status(404).json({ error: `Eventi me ID "${eventId}" nuk u gjet` });
        }

        const result = await pool.query(
            `INSERT INTO media (event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [event.id, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
        );

        res.status(201).json({ id: result.rows[0].id, message: 'Media u ruajt me sukses!' });
    } catch (error) {
        console.error('❌ Error saving media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR MEDIAT (publik) — vetëm fushat e nevojshme për mysafirin,
// pa event_id/cloudinary_id (të brendshme, s'duhet t'i shohë askush)
// ============================================================
app.get('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const event = await resolveEvent(eventId);
        if (!event) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }
        const result = await pool.query(
            'SELECT id, name, type, message, file_url, thumbnail_url, table_number, created_at FROM media WHERE event_id = $1 ORDER BY created_at DESC',
            [event.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error fetching media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// RUAJ KUJTIM (publik)
// ============================================================
app.post('/api/events/:eventId/memory', messageLimiter, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, text, table } = req.body;

        // ✅ Validim i qartë
        if (!name || !text) {
            return res.status(400).json({ error: 'Të dhëna të paplota: mungon name ose text' });
        }

        // 🚫 Filtrim bazë përmbajtjeje (nëse BLOCKED_WORDS është konfiguruar)
        if (containsBlockedWord(name) || containsBlockedWord(text)) {
            return res.status(400).json({ error: 'Mesazhi përmban përmbajtje të papërshtatshme. Ju lutem ndryshojeni.' });
        }

        // ✅ Sigurohemi që eventi ekziston
        const event = await resolveEvent(eventId);
        if (!event) {
            return res.status(404).json({ error: `Eventi me ID "${eventId}" nuk u gjet` });
        }

        const result = await pool.query(
            `INSERT INTO memories (event_id, name, text, table_number)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [event.id, name, text, table || 1]
        );

        res.status(201).json({
            id: result.rows[0].id,
            name,
            text,
            table: table || 1,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error saving memory:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR KUJTIMET (publik) — vetëm fushat e nevojshme, pa event_id
// ============================================================
app.get('/api/events/:eventId/memories', async (req, res) => {
    try {
        const { eventId } = req.params;
        const event = await resolveEvent(eventId);
        if (!event) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }
        const result = await pool.query(
            'SELECT id, name, text, table_number, timestamp FROM memories WHERE event_id = $1 ORDER BY timestamp DESC',
            [event.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error fetching memories:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ADMIN 🔐
// ============================================================
app.use('/api/admin', requireAuth);

app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, event_name, first_name, second_name, date, venue, guests, created_at, public_id FROM events ORDER BY created_at DESC'
        );

        const events = await Promise.all(result.rows.map(async e => ({
            id: e.id,
            eventName: e.event_name,
            firstName: e.first_name,
            secondName: e.second_name,
            date: e.date,
            venue: e.venue,
            guests: parseGuests(e.guests),
            createdAt: e.created_at,
            organizerToken: getOrganizerToken(e.id),
            publicId: await ensurePublicId(e)
        })));

        res.json(events);
    } catch (error) {
        console.error('❌ Error fetching admin events:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
        res.json({ message: 'Eventi u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error deleting event:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 🔄 RIGJENERO LINKUN/QR-N (ADMIN) 🔐
// Krijon ID publike të re + QR të ri për eventin. Linku/QR-i i
// VJETËR ndalon menjëherë së funksionuari (edhe guest, edhe organizatori,
// meqë linku i organizatorit e ka public_id-në brenda vetes).
// Përdoret kur një link/QR i vjetër është "djegur" (i shpërndarë gabimisht
// ose i rrezikuar), pa pasur nevojë të fshihet e të rikrijohet vetë eventi.
// ============================================================
app.post('/api/admin/events/:eventId/regenerate-link', async (req, res) => {
    try {
        const { eventId } = req.params;

        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const host = req.get('host');
        const protocol = req.get('x-forwarded-proto') || 'https';

        const newPublicId = generatePublicId();
        const qrUrl = `${protocol}://${host}/event/${newPublicId}`;
        const qrCode = await QRCode.toDataURL(qrUrl);

        await pool.query('UPDATE events SET public_id = $1, qr_code = $2 WHERE id = $3', [newPublicId, qrCode, eventId]);

        const organizerToken = getOrganizerToken(eventId);
        const organizerUrl = `${protocol}://${host}/organizer/${newPublicId}?token=${organizerToken}`;

        res.json({
            message: 'Linku u rigjenerua — linku/QR-i i vjetër nuk funksionon më.',
            publicId: newPublicId,
            qrCode,
            qrUrl,
            organizerUrl
        });
    } catch (error) {
        console.error('❌ Error regenerating link:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// SHTO NJË TË FTUAR NË EVENT 🔐 (admin)
// ============================================================
app.post('/api/admin/events/:eventId/guests', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, table } = req.body;

        if (!name || !table) {
            return res.status(400).json({ error: 'Emri dhe tavolina janë të detyrueshme' });
        }

        const result = await pool.query('SELECT guests FROM events WHERE id = $1', [eventId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(result.rows[0].guests);
        const newGuest = { name: name.trim(), table: Number(table) };
        guests.push(newGuest);

        await pool.query('UPDATE events SET guests = $1 WHERE id = $2', [JSON.stringify(guests), eventId]);

        res.status(201).json({ message: 'I ftuari u shtua', guest: newGuest, index: guests.length - 1, guests });
    } catch (error) {
        console.error('❌ Error adding guest:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// EDITO NJË TË FTUAR (sipas indeksit të tij në listë) 🔐 (admin)
// ============================================================
app.put('/api/admin/events/:eventId/guests/:guestIndex', async (req, res) => {
    try {
        const { eventId, guestIndex } = req.params;
        const { name, table } = req.body;
        const idx = parseInt(guestIndex, 10);

        const result = await pool.query('SELECT guests FROM events WHERE id = $1', [eventId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(result.rows[0].guests);
        if (idx < 0 || idx >= guests.length) {
            return res.status(404).json({ error: 'I ftuari nuk u gjet' });
        }

        if (name !== undefined) guests[idx].name = name.trim();
        if (table !== undefined) guests[idx].table = Number(table);

        await pool.query('UPDATE events SET guests = $1 WHERE id = $2', [JSON.stringify(guests), eventId]);

        res.json({ message: 'I ftuari u përditësua', guest: guests[idx], guests });
    } catch (error) {
        console.error('❌ Error updating guest:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// FSHI NJË TË FTUAR (sipas indeksit) 🔐 (admin)
// ============================================================
app.delete('/api/admin/events/:eventId/guests/:guestIndex', async (req, res) => {
    try {
        const { eventId, guestIndex } = req.params;
        const idx = parseInt(guestIndex, 10);

        const result = await pool.query('SELECT guests FROM events WHERE id = $1', [eventId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(result.rows[0].guests);
        if (idx < 0 || idx >= guests.length) {
            return res.status(404).json({ error: 'I ftuari nuk u gjet' });
        }

        guests.splice(idx, 1);
        await pool.query('UPDATE events SET guests = $1 WHERE id = $2', [JSON.stringify(guests), eventId]);

        res.json({ message: 'I ftuari u fshi', guests });
    } catch (error) {
        console.error('❌ Error deleting guest:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 🖼️ GALERIA E EVENTIT (ADMIN) — shiko & fshi media/urime
// ============================================================

// Merr të gjithë galerinë (media + kujtime) të një eventi — për panelin e organizatorit
app.get('/api/admin/events/:eventId/gallery', async (req, res) => {
    try {
        const { eventId } = req.params;

        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const [mediaResult, memoriesResult] = await Promise.all([
            pool.query('SELECT * FROM media WHERE event_id = $1 ORDER BY created_at DESC', [eventId]),
            pool.query('SELECT * FROM memories WHERE event_id = $1 ORDER BY timestamp DESC', [eventId])
        ]);

        res.json({ media: mediaResult.rows, memories: memoriesResult.rows });
    } catch (error) {
        console.error('❌ Error fetching admin gallery:', error);
        res.status(500).json({ error: error.message });
    }
});

// Pastron TËRË galerinë (foto/video + urime) e një eventi njëherësh —
// për rast urgjence (p.sh. përmbajtje e papërshtatshme masive) ose thjesht
// "reset" pas shkarkimit të kujtimeve. E pakthyeshme.
app.delete('/api/admin/events/:eventId/gallery', async (req, res) => {
    try {
        const { eventId } = req.params;

        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const mediaResult = await pool.query('SELECT cloudinary_id, type FROM media WHERE event_id = $1', [eventId]);
        for (const item of mediaResult.rows) {
            if (item.cloudinary_id) {
                try {
                    await cloudinary.uploader.destroy(item.cloudinary_id, {
                        resource_type: item.type === 'video' ? 'video' : 'image'
                    });
                } catch (err) {
                    console.error('⚠️ Nuk u fshi nga Cloudinary (vazhdohet me DB):', err.message);
                }
            }
        }

        await pool.query('DELETE FROM media WHERE event_id = $1', [eventId]);
        await pool.query('DELETE FROM memories WHERE event_id = $1', [eventId]);

        res.json({ message: 'Gjithë galeria u pastrua me sukses' });
    } catch (error) {
        console.error('❌ Error clearing gallery:', error);
        res.status(500).json({ error: error.message });
    }
});

// Fshi një foto/video nga galeria (edhe nga Cloudinary, edhe nga DB)
app.delete('/api/admin/events/:eventId/media/:mediaId', async (req, res) => {
    try {
        const { eventId, mediaId } = req.params;

        const result = await pool.query(
            'SELECT * FROM media WHERE id = $1 AND event_id = $2',
            [mediaId, eventId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Media nuk u gjet' });
        }

        const item = result.rows[0];

        // Fshij nga Cloudinary nëse ka cloudinary_id — nëse dështon, s'e ndalim
        // fshirjen nga DB (nuk duam të mbetet "gozhduar" në panel).
        if (item.cloudinary_id) {
            try {
                await cloudinary.uploader.destroy(item.cloudinary_id, {
                    resource_type: item.type === 'video' ? 'video' : 'image'
                });
            } catch (cloudErr) {
                console.error('⚠️ Nuk u fshi dot nga Cloudinary (vazhdohet me DB):', cloudErr.message);
            }
        }

        await pool.query('DELETE FROM media WHERE id = $1', [mediaId]);

        res.json({ message: 'Media u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error deleting media:', error);
        res.status(500).json({ error: error.message });
    }
});

// Fshi një kujtim/urim nga galeria
app.delete('/api/admin/events/:eventId/memories/:memoryId', async (req, res) => {
    try {
        const { eventId, memoryId } = req.params;

        const result = await pool.query(
            'DELETE FROM memories WHERE id = $1 AND event_id = $2 RETURNING id',
            [memoryId, eventId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Kujtimi nuk u gjet' });
        }

        res.json({ message: 'Kujtimi u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error deleting memory:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 👰🤵 PANELI I ORGANIZATORIT (ÇIFTI) — vetëm galeria e eventit të tyre
// Qasja bëhet me link special (?token=...), jo me user/fjalëkalim admini.
// Çdo rrugë verifikohet vetëm për eventId-në përkatëse te ky link.
// ============================================================
app.get('/api/organizer/events/:eventId/verify', requireOrganizerToken, async (req, res) => {
    try {
        const event = req.resolvedEvent;
        res.json({
            valid: true,
            eventId: event.public_id,
            eventName: event.event_name,
            firstName: event.first_name,
            secondName: event.second_name
        });
    } catch (error) {
        console.error('❌ Error verifying organizer token:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/organizer/events/:eventId/gallery', requireOrganizerToken, async (req, res) => {
    try {
        const event = req.resolvedEvent;

        const [mediaResult, memoriesResult] = await Promise.all([
            pool.query(
                'SELECT id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number, created_at FROM media WHERE event_id = $1 ORDER BY created_at DESC',
                [event.id]
            ),
            pool.query(
                'SELECT id, name, text, table_number, timestamp FROM memories WHERE event_id = $1 ORDER BY timestamp DESC',
                [event.id]
            )
        ]);

        res.json({ media: mediaResult.rows, memories: memoriesResult.rows });
    } catch (error) {
        console.error('❌ Error fetching organizer gallery:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/organizer/events/:eventId/media/:mediaId', requireOrganizerToken, async (req, res) => {
    try {
        const event = req.resolvedEvent;
        const { mediaId } = req.params;

        const result = await pool.query(
            'SELECT * FROM media WHERE id = $1 AND event_id = $2',
            [mediaId, event.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Media nuk u gjet' });
        }

        const item = result.rows[0];

        if (item.cloudinary_id) {
            try {
                await cloudinary.uploader.destroy(item.cloudinary_id, {
                    resource_type: item.type === 'video' ? 'video' : 'image'
                });
            } catch (cloudErr) {
                console.error('⚠️ Nuk u fshi dot nga Cloudinary (vazhdohet me DB):', cloudErr.message);
            }
        }

        await pool.query('DELETE FROM media WHERE id = $1', [mediaId]);

        res.json({ message: 'Media u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error deleting media (organizer):', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/organizer/events/:eventId/memories/:memoryId', requireOrganizerToken, async (req, res) => {
    try {
        const event = req.resolvedEvent;
        const { memoryId } = req.params;

        const result = await pool.query(
            'DELETE FROM memories WHERE id = $1 AND event_id = $2 RETURNING id',
            [memoryId, event.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Kujtimi nuk u gjet' });
        }

        res.json({ message: 'Kujtimi u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error deleting memory (organizer):', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// FRONTEND ROUTES
// ============================================================
app.get('/event/:eventId', (req, res) => {
    res.sendFile(path.join(publicPath, 'event.html'));
});

app.get('/organizer/:eventId', (req, res) => {
    res.sendFile(path.join(publicPath, 'organizer.html'));
});

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ============================================================
// TEST CLOUDINARY
// ============================================================
app.get('/api/test-cloudinary', async (req, res) => {
    try {
        const result = await cloudinary.api.ping();
        res.json({
            ok: true,
            ping: result,
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            secret_configured: !!(process.env.CLOUDINARY_API_SECRET)
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error_message: err.message,
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY
        });
    }
});

// ============================================================
// 404
// ============================================================
app.use((req, res) => {
    res.status(404).send('Faqja nuk u gjet');
});

// ============================================================
// NIS SERVERIN
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveri FestO u nis në portën ${PORT}`);
    console.log(`📂 Public path: ${publicPath}`);
});
