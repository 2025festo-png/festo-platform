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
// LIDHJA ME SUPABASE (POSTGRESQL)
// ============================================================
const { Pool } = require('pg');

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

        const result = await pool.query(
            `INSERT INTO events (id, event_name, first_name, second_name, date, venue, guests, qr_code, layout)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [eventId, eventName, firstName, secondName, date, venue, JSON.stringify(guests), qrCode, JSON.stringify(defaultLayout)]
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

        const result = await pool.query(
            'SELECT guests FROM events WHERE id = $1',
            [eventId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        const guests = result.rows[0].guests;
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
        console.error('❌ Error searching guest:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 4. API - LEJ KUJTIM (URIM)
// ============================================================
app.post('/api/events/:eventId/memory', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, text, table } = req.body;

        if (!name || !text) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const memoryId = uuidv4();
        await pool.query(
            `INSERT INTO memories (id, event_id, name, text, table_number)
             VALUES ($1, $2, $3, $4, $5)`,
            [memoryId, eventId, name, text, table || 1]
        );

        res.status(201).json({
            id: memoryId,
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
// 5. API - MERK KUJTIMET
// ============================================================
app.get('/api/events/:eventId/memories', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT id, name, text, table_number, timestamp FROM memories WHERE event_id = $1 ORDER BY timestamp DESC',
            [eventId]
        );

        const memories = result.rows.map(m => ({
            id: m.id,
            name: m.name,
            text: m.text,
            table: m.table_number,
            timestamp: m.timestamp
        }));

        res.json(memories);

    } catch (error) {
        console.error('❌ Error fetching memories:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 6. API - UPLOAD VIDEO (ME KOMPRESIM NË CLOUDINARY)
// ============================================================
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nuk u gjet asnjë video' });
        }

        const file = req.file;
        const eventId = req.body.eventId || 'unknown';

        // Konfiguro transformimin për kompresim optimal
        const uploadStream = cloudinary.uploader.upload_stream({
            resource_type: 'video',
            folder: `festo_videos/${eventId}`,
            public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '')}`,
            transformation: [
                { width: 854, height: 480, crop: 'limit' },  // 480p për kompresim
                { quality: 'auto:low' },                      // Kompresim automatik
                { format: 'mp4' },                            // Konverto në MP4
                { bit_rate: '800k' },                         // 800kbps bitrate
                { video_codec: 'h264' },                      // Kodek efikas
                { aspect_ratio: '16:9', crop: 'fill' }       // Format 16:9
            ],
            eager: [
                { width: 320, height: 180, crop: 'fill', format: 'jpg' }  // Thumbnail
            ]
        }, (error, result) => {
            if (error) {
                console.error('Gabim në Cloudinary:', error);
                return res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
            }

            res.json({
                success: true,
                url: result.secure_url,
                thumbnail: result.eager && result.eager[0] ? result.eager[0].secure_url : null,
                public_id: result.public_id,
                duration: result.duration,
                format: result.format,
                size: result.bytes
            });
        });

        // Kthe buffer-in në stream dhe ngarko
        const bufferStream = new Readable();
        bufferStream.push(file.buffer);
        bufferStream.push(null);
        bufferStream.pipe(uploadStream);

    } catch (error) {
        console.error('Gabim:', error);
        res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
    }
});

// ============================================================
// 7. API - RUAJ MEDIA NË SUPABASE
// ============================================================
app.post('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const { name, type, message, fileUrl, thumbnailUrl, cloudinaryId, tableNumber } = req.body;

        if (!name || !type || !fileUrl) {
            return res.status(400).json({ error: 'Të dhënat janë të paplota' });
        }

        const mediaId = uuidv4();
        await pool.query(
            `INSERT INTO media (id, event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [mediaId, eventId, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
        );

        res.status(201).json({
            id: mediaId,
            message: 'Media u ruajt me sukses!'
        });

    } catch (error) {
        console.error('❌ Error saving media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 8. API - MERK MEDIAT E NJË EVENTI
// ============================================================
app.get('/api/events/:eventId/media', async (req, res) => {
    try {
        const { eventId } = req.params;
        const result = await pool.query(
            'SELECT id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number, created_at FROM media WHERE event_id = $1 ORDER BY created_at DESC',
            [eventId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('❌ Error fetching media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 9. API - FSHIJ MEDIA
// ============================================================
app.delete('/api/admin/media/:mediaId', async (req, res) => {
    try {
        const { mediaId } = req.params;

        // Merr cloudinary_id për të fshirë nga Cloudinary
        const result = await pool.query('SELECT cloudinary_id FROM media WHERE id = $1', [mediaId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Media nuk u gjet' });
        }

        const cloudinaryId = result.rows[0].cloudinary_id;

        // Fshi nga Cloudinary nëse ka
        if (cloudinaryId) {
            try {
                await cloudinary.uploader.destroy(cloudinaryId, { resource_type: 'video' });
            } catch (cloudError) {
                console.error('Gabim në fshirjen nga Cloudinary:', cloudError);
            }
        }

        // Fshi nga databaza
        await pool.query('DELETE FROM media WHERE id = $1', [mediaId]);

        res.json({ message: 'Media u fshi me sukses' });

    } catch (error) {
        console.error('❌ Error deleting media:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 10. ADMIN - MERK TË GJITHA EVENTET
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
            guests: e.guests,
            createdAt: e.created_at
        }));

        res.json(events);

    } catch (error) {
        console.error('❌ Error fetching events:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 11. ADMIN - FSHIJ EVENT (ME FSHIRJE TË TË GJITHA TË DHËNAVE)
// ============================================================
app.delete('/api/admin/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;

        // Kontrollo nëse eventi ekziston
        const checkResult = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

        // Fshi mediat nga Cloudinary (nëse ka)
        const mediaResult = await pool.query('SELECT cloudinary_id FROM media WHERE event_id = $1', [eventId]);
        for (const media of mediaResult.rows) {
            if (media.cloudinary_id) {
                try {
                    await cloudinary.uploader.destroy(media.cloudinary_id, { resource_type: 'video' });
                } catch (cloudError) {
                    console.error('Gabim në fshirjen nga Cloudinary:', cloudError);
                }
            }
        }

        // Fshi të gjitha të dhënat e lidhura (CASCADE do të fshijë memories dhe media)
        await pool.query('DELETE FROM events WHERE id = $1', [eventId]);

        res.json({ message: 'Eventi dhe të gjitha të dhënat e lidhura u fshinë me sukses' });

    } catch (error) {
        console.error('❌ Error deleting event:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 12. SHËRBEJE FAQEN E EVENTIT
// ============================================================
app.get('/event/:eventId', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/event.html'));
});

// ============================================================
// FILLO SERVERIN
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Serveri po punon në http://localhost:${PORT}`);
    console.log('📋 Gati për të krijuar evente!');
});
