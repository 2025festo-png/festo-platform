const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ============================================================
// CLOUDINARY DHE MULTER
// ============================================================
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');

// KONFIGURIMI I CLOUDINARY - VENDOS KËTU TË DHËNAT E TUA!
cloudinary.config({
    cloud_name: 'ej5pmsyk',    // ← Zëvendëso me emrin tënd
    api_key: '714926149629346',          // ← Zëvendëso me API Key
    api_secret: 'NeC18Bo_LGZ1VUJTXA_9JP5NdiU'     // ← Zëvendëso me API Secret
});

// KONFIGURIMI I MULTER
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 500 * 1024 * 1024 // 500MB max
    },
    fileFilter: function(req, file, cb) {
        // Lejo të gjitha formatet e videove
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

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.static('public'));

// Database (JSON file)
const DATA_FILE = path.join(__dirname, 'data', 'events.json');

// Lexo të dhënat
function readData() {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { events: [] };
    }
}

// Ruaj të dhënat
function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// TEST ROUTE
// ============================================================
app.get('/api/test', (req, res) => {
    res.json({ message: 'Serveri funksionon! 🚀' });
});

// ============================================================
// KRIJO EVENT
// ============================================================
app.post('/api/events', (req, res) => {
    const { eventName, firstName, secondName, date, venue, guests } = req.body;

    if (!eventName || !guests || !Array.isArray(guests)) {
        return res.status(400).json({ error: 'Të dhënat janë të paplota' });
    }

    const eventId = uuidv4();
  const host = req.get('host');
const protocol = req.get('x-forwarded-proto') || 'https';
const qrUrl = `${protocol}://${host}/event/${eventId}`;

    QRCode.toDataURL(qrUrl, (err, qrCode) => {
        if (err) {
            return res.status(500).json({ error: 'Nuk mund të gjenerohet QR kodi' });
        }

        const defaultLayout = [];
        let tableNum = 1;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 5; c++) {
                defaultLayout.push({ table: tableNum++, row: r, col: c });
            }
        }

        const newEvent = {
            id: eventId,
            eventName: eventName,
            firstName: firstName || '',
            secondName: secondName || '',
            date: date || new Date().toISOString().split('T')[0],
            venue: venue || 'Vend i pacaktuar',
            guests: guests.map(g => ({
                id: uuidv4(),
                name: g.name,
                table: g.table
            })),
            memories: [],
            layout: defaultLayout,
            qrCode,
            createdAt: new Date().toISOString()
        };

        const data = readData();
        data.events.push(newEvent);
        writeData(data);

        res.status(201).json({
            eventId: newEvent.id,
            qrCode: newEvent.qrCode,
            qrUrl: qrUrl,
            message: 'Eventi u krijua me sukses!'
        });
    });
});

// ============================================================
// MERK EVENTIN
// ============================================================
app.get('/api/events/:eventId', (req, res) => {
    const { eventId } = req.params;
    const data = readData();
    const event = data.events.find(e => e.id === eventId);

    if (!event) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    const { qrCode, ...eventData } = event;
    res.json(eventData);
});

// ============================================================
// KËRKO TË FTUAR
// ============================================================
app.get('/api/events/:eventId/guest/:name', (req, res) => {
    const { eventId, name } = req.params;
    const data = readData();
    const event = data.events.find(e => e.id === eventId);

    if (!event) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    const guest = event.guests.find(g =>
        g.name.toLowerCase() === name.toLowerCase().trim()
    );

    if (!guest) {
        return res.status(404).json({ error: 'I ftuari nuk u gjet' });
    }

    const tableGuests = event.guests.filter(g => g.table === guest.table);

    res.json({
        guest: guest,
        tableGuests: tableGuests,
        tableNumber: guest.table
    });
});

// ============================================================
// LEJ KUJTIM
// ============================================================
app.post('/api/events/:eventId/memory', (req, res) => {
    const { eventId } = req.params;
    const { name, text, table } = req.body;

    if (!name || !text || !table) {
        return res.status(400).json({ error: 'Të dhënat janë të paplota' });
    }

    const data = readData();
    const event = data.events.find(e => e.id === eventId);

    if (!event) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    const memory = {
        id: uuidv4(),
        name,
        text,
        table: parseInt(table),
        timestamp: new Date().toISOString()
    };

    event.memories.push(memory);
    writeData(data);

    res.status(201).json(memory);
});

// ============================================================
// MERK KUJTIMET
// ============================================================
app.get('/api/events/:eventId/memories', (req, res) => {
    const { eventId } = req.params;
    const data = readData();
    const event = data.events.find(e => e.id === eventId);

    if (!event) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    res.json(event.memories);
});

// ============================================================
// ADMIN - MERK TË GJITHA EVENTET
// ============================================================
app.get('/api/admin/events', (req, res) => {
    const data = readData();
    const events = data.events.map(({ qrCode, ...event }) => event);
    res.json(events);
});

// ============================================================
// ADMIN - FSHIJ EVENT
// ============================================================
app.delete('/api/admin/events/:eventId', (req, res) => {
    const { eventId } = req.params;
    const data = readData();
    const index = data.events.findIndex(e => e.id === eventId);

    if (index === -1) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    data.events.splice(index, 1);
    writeData(data);
    res.json({ message: 'Eventi u fshi me sukses' });
});

// ============================================================
// ADMIN - PËRDITËSO TË FTUAR
// ============================================================
app.put('/api/admin/events/:eventId/guests', (req, res) => {
    const { eventId } = req.params;
    const { guests } = req.body;

    if (!guests || !Array.isArray(guests)) {
        return res.status(400).json({ error: 'Lista e të ftuarve është e pavlefshme' });
    }

    const data = readData();
    const event = data.events.find(e => e.id === eventId);

    if (!event) {
        return res.status(404).json({ error: 'Eventi nuk u gjet' });
    }

    event.guests = guests.map(g => ({
        id: g.id || uuidv4(),
        name: g.name,
        table: g.table
    }));

    writeData(data);
    res.json({ message: 'Lista u përditësua me sukses', guests: event.guests });
});

// ============================================================
// UPLOAD VIDEO NË CLOUDINARY
// ============================================================
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nuk u gjet asnjë video' });
        }

        const file = req.file;
        const eventId = req.body.eventId || 'unknown';
        
        // Krijo një stream për të ngarkuar videon në Cloudinary
        const uploadStream = cloudinary.uploader.upload_stream({
            resource_type: 'video',
            folder: `festo_videos/${eventId}`,
            public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '')}`,
            transformation: [
                { width: 1280, height: 720, crop: 'limit' },
                { format: 'mp4' }  // Konverto automatikisht në MP4
            ]
        }, (error, result) => {
            if (error) {
                console.error('Gabim në Cloudinary:', error);
                return res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
            }
            
            res.json({
                success: true,
                url: result.secure_url,
                thumbnail: result.secure_url.replace('.mp4', '.jpg'),
                public_id: result.public_id,
                duration: result.duration,
                format: result.format
            });
        });

        // Kthe buffer-in e skedarit në një stream
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
// FSHIJ VIDEO NGA CLOUDINARY
// ============================================================
app.delete('/api/delete-video/:publicId', async (req, res) => {
    try {
        const { publicId } = req.params;
        
        cloudinary.uploader.destroy(publicId, { resource_type: 'video' }, (error, result) => {
            if (error) {
                return res.status(500).json({ error: 'Gabim në fshirjen e videos' });
            }
            res.json({ success: true, message: 'Video u fshi me sukses' });
        });
    } catch (error) {
        res.status(500).json({ error: 'Gabim në fshirjen e videos' });
    }
});

// ============================================================
// SERVERI I FAQES STATIKE
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
