// ============================================================
// KONFIGURIMI I DNS (ZGJIDHJA GLOBALE PËR PROBLEMET IPV6/SUPABASE)
// ============================================================
if (globalThis.process && typeof URL !== 'undefined') {
    const dns = require('node:dns');
    if (dns && typeof dns.setDefaultResultOrder === 'function') {
        dns.setDefaultResultOrder('ipv4first');
    }
}

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// KONFIGURIMI CLOUDINARY
// ============================================================
cloudinary.config({
    cloud_name: 'ej5pmsyk',
    api_key: '714926149629346',
    api_secret: 'NeC18Bo_LGZ1VUJTXA_9JP5NdiU'
});

// ============================================================
// KONFIGURIMI MULTER (PËR UPLOAD)
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: function(req, file, cb) {
        const allowedTypes = [
            'video/mp4', 'video/quicktime', 'video/x-msvideo',
            'video/x-matroska', 'video/webm', 'video/ogg',
            'video/mov', 'video/avi', 'video/mkv'
        ];
        if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Formati i videos nuk mbështetet'));
        }
    }
});

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================================
// KONTROLLO DATABASE_URL
// ============================================================
console.log('🔍 Checking DATABASE_URL...');
console.log('📋 DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('📋 DATABASE_URL length:', process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0);

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set!');
    process.exit(1);
}

// Lexo URL-në dhe verifiko format
const dbUrl = process.env.DATABASE_URL;
console.log('📋 DATABASE_URL starts with:', dbUrl.substring(0, 30) + '...');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4 // Detyron përdorimin e IPv4
});

pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection error:', err);
    } else {
        console.log('✅ Database connected successfully');
    }
});

// ============================================================
// KRIJO TABELAT
// ============================================================
async function initDatabase() {
    try {
        // Tabela events
        await pool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id UUID PRIMARY KEY,
                event_name TEXT NOT NULL,
                first_name TEXT,
                second_name TEXT,
                date DATE,
                venue TEXT,
                guests JSONB NOT NULL,
                qr_code TEXT,
                layout JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabela events gati');

        // Tabela memories (urimet)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS memories (
                id UUID PRIMARY KEY,
                event_id UUID REFERENCES events(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                text TEXT,
                table_number INTEGER,
                timestamp TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabela memories gati');

        // Tabela media (foto/video)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS media (
                id UUID PRIMARY KEY,
                event_id UUID REFERENCES events(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                message TEXT,
                file_url TEXT NOT NULL,
                thumbnail_url TEXT,
                cloudinary_id TEXT,
                table_number INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabela media gati');

    } catch (error) {
        console.error('❌ Gabim në krijimin e tabelave:', error);
    }
}

initDatabase();

// ============================================================
// 1. API - KRIJO EVENT
// ============================================================
app.post('/api/events', async (req, res) => {
    try {
        const { eventName, firstName, secondName, date, venue, guests } = req.body;

        if (!eventName || !guests || !Array.isArray(guests)) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const eventId = uuidv4();
        const host = req.get('host');
        const protocol = req.get('x-forwarded-proto') || 'https';
        const qrUrl = `${protocol}://${host}/event/${eventId}`;

        const qrCode = await QRCode.toDataURL(qrUrl);

        // Gjenero layout-in e paracaktuar
        const defaultLayout = [];
        let tableNum = 1;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 5; c++) {
                defaultLayout.push({ table: tableNum++, row: r, col: c });
            }
        }

        // Sigurohemi që të dhënat JSON bëhen string përpara se të futen në databazë
        const guestsJson = JSON.stringify(guests);
        const layoutJson = JSON.stringify(defaultLayout);

        const result = await pool.query(
            `INSERT INTO events (id, event_name, first_name, second_name, date, venue, guests, qr_code, layout)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
             RETURNING id`,
            [eventId, eventName, firstName, secondName, date || null, venue || null, guestsJson, qrCode, layoutJson]
        );

        res.status(201).json({
            eventId: result.rows[0].id,
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
// 2. API - MERK EVENTIN
// ============================================================
app.get('/api/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT id, event_name, first_name, second_name, date, venue, guests, qr_code, layout, created_at FROM events WHERE id = $1',
            [eventId]
        );

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
            guests: event.guests,
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
// 3. API - KËRKO TË FTUAR
// ============================================================
app.get('/api/events/:eventId/guest/:name', async (req, res) => {
    try {
        const { eventId, name } = req.params;
        const decodedName = decodeURIComponent(name);

        // Kontrollojmë nëse eventi ekziston duke përdorur UUID
        const result = await pool.query(
            'SELECT guests FROM events WHERE id = $1::uuid',
            [eventId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = result.rows[0].guests;
        
        // Sigurohemi që guests është varg (array) përpara se të kërkojmë
        const guestList = Array.isArray(guests) ? guests : JSON.parse(guests);
        const guest = guestList.find(g => g.name.toLowerCase() === decodedName.toLowerCase());

        if (!guest) {
            return res.status(404).json({ error: 'I ftuari nuk u gjet në listë' });
        }

        res.json(guest);

    } catch (error) {
        console.error('❌ Error fetching guest:', error);
        res.status(500).json({ error: error.message });
    }
});
// ============================================================
// 4. API - MERK MEDIAT (FOTO/VIDEO) PËR NJË EVENT SPECIFIK
// ============================================================
app.get('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT id, event_id, name, type, message, file_url, thumbnail_url, table_number, created_at FROM media WHERE event_id = $1::uuid ORDER BY created_at DESC',
            [eventId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error fetching media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 5. API - MERK MEMORIES (URIMET) PËR NJË EVENT SPECIFIK
// ============================================================
app.get('/api/events/:eventId/memories', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT id, event_id, name, text, table_number, timestamp FROM memories WHERE event_id = $1::uuid ORDER BY timestamp DESC',
            [eventId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error fetching memories:', error);
        res.status(500).json({ error: error.message });
    }
});
// ============================================================
// API - MERK TË GJITHA EVENTET PËR ADMIN
// ============================================================
app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, event_name, first_name, second_name, date, venue, created_at FROM events ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error fetching admin events:', error);
        res.status(500).json({ error: error.message });
    }
});
// ============================================================
// API - SHËRBE FAQEN EVENT.HTML PËR TË FTUARIT
// ============================================================
app.get('/event/:eventId', (req, res) => {
    try {
        // Shërbehet skedari event.html që ndodhet brenda dosjes public
        res.sendFile(path.join(__dirname, '../public', 'event.html'));
    } catch (error) {
        console.error('❌ Gabim në ngarkimin e faqes së eventit:', error);
        res.status(500).send('Gabim në server gjatë ngarkimit të faqes.');
    }
});

// NIS SERVERIN
app.listen(PORT, () => {
    console.log(`🚀 Serveri FestO u nis me sukses në portën ${PORT}`);
});
