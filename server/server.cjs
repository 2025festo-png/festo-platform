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

cloudinary.config({
    cloud_name: 'ej5pmsyk',
    api_key: '714926149629346',
    api_secret: 'NeC18Bo_LGZ1VUJTXA_9JP5NdiU'
});

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseGuests(guests) {
    if (!guests) return [];
    if (Array.isArray(guests)) return guests;
    if (typeof guests === 'string') {
        try {
            return JSON.parse(guests);
        } catch (e) {
            return [];
        }
    }
    return [];
}

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

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                event_name TEXT NOT NULL,
                first_name TEXT,
                second_name TEXT,
                date DATE,
                venue TEXT,
                guests JSONB DEFAULT '[]',
                qr_code TEXT,
                layout JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabela events gati');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS memories (
                id SERIAL PRIMARY KEY,
                event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                text TEXT,
                table_number INTEGER,
                timestamp TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabela memories gati');

    } catch (error) {
        console.error('❌ Gabim në krijimin e tabelave:', error);
    }
}

initDatabase();

app.get('/api/test', (req, res) => {
    res.json({ message: 'Serveri funksionon! 🚀' });
});

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
        console.error('❌ Error creating event:', error);
        res.status(500).json({ error: error.message });
    }
});

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
        console.error('❌ Error fetching event:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/events/:eventId/guest/:name', async (req, res) => {
    try {
        const { eventId, name } = req.params;
        const decodedName = decodeURIComponent(name).trim();

        console.log(`🔍 Kërkohet: "${decodedName}" në eventin: ${eventId}`);

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
            return res.status(404).json({
                error: `I ftuari "${decodedName}" nuk u gjet`,
                availableGuests: guests.map(g => g.name)
            });
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
        console.error('❌ Error fetching events:', error);
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

app.get('/event/:eventId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/event.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Serveri FestO u nis në portën ${PORT}`);
});
