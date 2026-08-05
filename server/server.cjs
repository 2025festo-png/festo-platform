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
// KONFIGURIMI MULTER
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: function(req, file, cb) {
        if (file.mimetype.startsWith('video/')) {
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
// LIDHJA ME NEON
// ============================================================
console.log('🔍 Checking DATABASE_URL...');

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection error:', err);
    } else {
        console.log('✅ Database connected successfully');
    }
});

// ============================================================
// FUNKSIONI NDIHMËS PËR GUESTS
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
// API - KRIJO EVENT
// ============================================================
app.post('/api/events', async (req, res) => {
    try {
        const { eventName, firstName, secondName, date, venue, guests } = req.body;

        console.log('📥 Creating event:', eventName);

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

        await pool.query(
            `UPDATE events SET qr_code = $1 WHERE id = $2`,
            [qrCode, eventId]
        );

        res.status(201).json({
            eventId: eventId,
            qrCode: qrCode,
            qrUrl: qrUrl,
            message: 'Eventi u krijua me sukses!'
        });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API - MERK EVENTIN
// ============================================================
app.get('/api/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT * FROM events WHERE id = $1',
            [eventId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const event = result.rows[0];
        const guests = parseGuests(event.guests);

        res.json({
            id: event.id,
            eventName: event.event_name,
            firstName: event.first_name,
            secondName: event.second_name,
            date: event.date,
            venue: event.venue,
            guests: guests,
            qrCode: event.qr_code,
            layout: event.layout,
            createdAt: event.created_at
        });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API - KËRKO TË FTUAR
// ============================================================
app.get('/api/events/:eventId/guest/:name', async (req, res) => {
    try {
        const { eventId, name } = req.params;
        const decodedName = decodeURIComponent(name).trim();

        const result = await pool.query(
            'SELECT guests FROM events WHERE id = $1',
            [eventId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = parseGuests(result.rows[0].guests);

        if (guests.length === 0) {
            return res.status(404).json({ error: 'Nuk ka të ftuar' });
        }

        const guest = guests.find(g => g.name.toLowerCase() === decodedName.toLowerCase());

        if (!guest) {
            return res.status(404).json({ error: 'I ftuari nuk u gjet' });
        }

        const tableGuests = guests.filter(g => g.table === guest.table);

        res.json({
            guest: guest,
            tableGuests: tableGuests,
            tableNumber: guest.table
        });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API - MERK MEDIAT
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
// API - MERK KUJTIMET (MEMORIES)
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
// API - UPLOAD VIDEO
// ============================================================
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nuk u gjet asnjë video' });
        }

        console.log('📥 Video received:', req.file.originalname);

        const file = req.file;
        const eventId = req.body.eventId || 'unknown';

        const uploadStream = cloudinary.uploader.upload_stream({
            resource_type: 'video',
            folder: `festo_videos/${eventId}`,
            public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '')}`,
            transformation: [
                { width: 854, height: 480, crop: 'limit' },
                { quality: 'auto:low' },
                { format: 'mp4' },
                { bit_rate: '800k' },
                { video_codec: 'h264' }
            ]
        }, (error, result) => {
            if (error) {
                console.error('❌ Cloudinary error:', error);
                return res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
            }

            res.json({
                success: true,
                url: result.secure_url,
                public_id: result.public_id,
                duration: result.duration
            });
        });

        const bufferStream = new Readable();
        bufferStream.push(file.buffer);
        bufferStream.push(null);
        bufferStream.pipe(uploadStream);

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
    }
});

// ============================================================
// API - RUAJ MEDIA
// ============================================================
app.post('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, type, message, fileUrl, thumbnailUrl, cloudinaryId, tableNumber } = req.body;

        console.log('📥 Saving media:', { eventId, name, type });

        if (!name || !type || !fileUrl) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const mediaId = uuidv4();

        const result = await pool.query(
            `INSERT INTO media (id, event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [mediaId, eventId, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
        );

        res.status(201).json({
            id: result.rows[0].id,
            message: 'Media u ruajt me sukses!'
        });

    } catch (error) {
        console.error('❌ Error saving media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API - LEJ KUJTIM (URIM)
// ============================================================
app.post('/api/events/:eventId/memory', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, text, table } = req.body;

        if (!name || !text) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const memoryId = uuidv4();

        const result = await pool.query(
            `INSERT INTO memories (id, event_id, name, text, table_number)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [memoryId, eventId, name, text, table || 1]
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
// API - ADMIN - MERK TË GJITHA EVENTET
// ============================================================
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
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API - ADMIN - FSHIJ EVENT
// ============================================================
app.delete('/api/admin/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
        res.json({ message: 'Eventi u fshi me sukses' });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// SHËRBEJE FAQEN E EVENTIT
// ============================================================
app.get('/event/:eventId', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/event.html'));
});

// ============================================================
// SHËRBEJE FAQEN KRYESORE
// ============================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============================================================
// NIS SERVERIN
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Serveri FestO u nis në portën ${PORT}`);
});
