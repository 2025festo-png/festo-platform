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
// ============================================================
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
        const qrUrl = `${protocol}://${host}/event/${eventId}`;
        const qrCode = await QRCode.toDataURL(qrUrl);

        await pool.query(`UPDATE events SET qr_code = $1 WHERE id = $2`, [qrCode, eventId]);

        res.status(201).json({
            eventId: eventId,
            qrCode: qrCode,
            qrUrl: qrUrl,
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
            'SELECT id, event_name, first_name, second_name, date, venue, guests, created_at FROM events ORDER BY created_at DESC'
        );

        const events = result.rows.map(e => ({
            id: e.id,
            eventName: e.event_name,
            firstName: e.first_name,
            secondName: e.second_name,
            date: e.date,
            venue: e.venue,
            guests: parseGuests(e.guests),
            createdAt: e.created_at
        }));

        res.json(events);
    } catch (error) {
        console.error('❌ Error fetching events:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR EVENTIN (publik)
// ============================================================
app.get('/api/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const event = result.rows[0];
        res.json({
            id: event.id,
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

        const result = await pool.query('SELECT guests FROM events WHERE id = $1', [eventId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(result.rows[0].guests);
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

        // ✅ Sigurohemi që eventi ekziston përpara se të ruajmë media për të,
        // që të mos humbasë ngarkimi në heshtje nëse eventId është gabim.
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: `Eventi me ID "${eventId}" nuk u gjet` });
        }

        const result = await pool.query(
            `INSERT INTO media (event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [eventId, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
        );

        res.status(201).json({ id: result.rows[0].id, message: 'Media u ruajt me sukses!' });
    } catch (error) {
        console.error('❌ Error saving media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// MERR MEDIAT (publik)
// ============================================================
app.get('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT * FROM media WHERE event_id = $1 ORDER BY created_at DESC',
            [eventId]
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
app.post('/api/events/:eventId/memory', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, text, table } = req.body;

        // ✅ Validim i qartë
        if (!name || !text) {
            return res.status(400).json({ error: 'Të dhëna të paplota: mungon name ose text' });
        }

        // ✅ Sigurohemi që eventi ekziston
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: `Eventi me ID "${eventId}" nuk u gjet` });
        }

        const result = await pool.query(
            `INSERT INTO memories (event_id, name, text, table_number)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [eventId, name, text, table || 1]
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
// MERR KUJTIMET (publik)
// ============================================================
app.get('/api/events/:eventId/memories', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT * FROM memories WHERE event_id = $1 ORDER BY timestamp DESC',
            [eventId]
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
            'SELECT id, event_name, first_name, second_name, date, venue, guests, created_at FROM events ORDER BY created_at DESC'
        );

        const events = result.rows.map(e => ({
            id: e.id,
            eventName: e.event_name,
            firstName: e.first_name,
            secondName: e.second_name,
            date: e.date,
            venue: e.venue,
            guests: parseGuests(e.guests),
            createdAt: e.created_at
        }));

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
// FRONTEND ROUTES
// ============================================================
app.get('/event/:eventId', (req, res) => {
    res.sendFile(path.join(publicPath, 'event.html'));
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
