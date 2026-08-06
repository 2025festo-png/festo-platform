app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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
// LIDHJA ME NEON
// ============================================================
pool.connect((err) => {
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
});

} catch (error) {
        console.error('❌ Error:', error);
        console.error('❌ Error creating event:', error);
res.status(500).json({ error: error.message });
}
});
app.get('/api/events/:eventId', async (req, res) => {
});

} catch (error) {
        console.error('❌ Error:', error);
        console.error('❌ Error fetching event:', error);
res.status(500).json({ error: error.message });
}
});
app.get('/api/events/:eventId/guest/:name', async (req, res) => {
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
        console.error('❌ Error searching guest:', error);
res.status(500).json({ error: error.message });
}
});
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
}, (error, result) => {
if (error) {
console.error('❌ Cloudinary error:', error);
                return res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
                return res.status(500).json({ error: 'Gabim në ngarkimin e videos: ' + error.message });
}

res.json({
app.post('/api/upload-video', upload.single('video'), async (req, res) => {

} catch (error) {
console.error('❌ Upload error:', error);
        res.status(500).json({ error: 'Gabim në ngarkimin e videos' });
        res.status(500).json({ error: 'Gabim në ngarkimin e videos: ' + error.message });
}
});

// ============================================================
// API - RUAJ MEDIA
// API - RUAJ MEDIA (FOTO/VIDEO)
// ============================================================
app.post('/api/events/:eventId/media', async (req, res) => {
try {
app.post('/api/events/:eventId/media', async (req, res) => {
return res.status(400).json({ error: 'Të dhënat janë të paplota' });
}

        const mediaId = uuidv4();
        // Kontrollo nëse eventi ekziston
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Eventi nuk u gjet' });
        }

const result = await pool.query(
            `INSERT INTO media (id, event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `INSERT INTO media (event_id, name, type, message, file_url, thumbnail_url, cloudinary_id, table_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id`,
            [mediaId, eventId, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
            [eventId, name, type, message || '', fileUrl, thumbnailUrl || null, cloudinaryId || null, tableNumber || 1]
);

res.status(201).json({
app.post('/api/events/:eventId/media', async (req, res) => {
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
// API - LEJ KUJTIM (URIM)
// ============================================================
app.post('/api/events/:eventId/memory', async (req, res) => {
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
// API - ADMIN - MERK TË GJITHA EVENTET
// ============================================================
app.get('/api/admin/events', async (req, res) => {
res.json(events);

} catch (error) {
        console.error('❌ Error:', error);
        console.error('❌ Error fetching events:', error);
res.status(500).json({ error: error.message });
}
});
app.get('/api/admin/events', async (req, res) => {
app.delete('/api/admin/events/:eventId', async (req, res) => {
try {
const { eventId } = req.params;
        
        // Fshi mediat e lidhura me eventin
        await pool.query('DELETE FROM media WHERE event_id = $1', [eventId]);
        // Fshi kujtimet e lidhura me eventin
        await pool.query('DELETE FROM memories WHERE event_id = $1', [eventId]);
        // Fshi eventin
await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
        
res.json({ message: 'Eventi u fshi me sukses' });
} catch (error) {
        console.error('❌ Error:', error);
        console.error('❌ Error deleting event:', error);
res.status(500).json({ error: error.message });
}
});
