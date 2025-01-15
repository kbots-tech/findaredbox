const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const path = require('path');
const validator = require('validator');
const cron = require('node-cron'); // For scheduling backups
const { exec } = require('child_process'); // To run shell commands
const fs = require('fs');
const app = express();
const PORT = 3008;

// Middleware for parsing JSON and form data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create a MySQL connection pool
//Note database schema will not be posted on github but available at my descrition upon request.
const db = mysql.createPool({
    host: 'host',
    user: 'user',
    password: 'pass',
    database: 'pass',
    port: 3307
}).promise();

// Backup directory and configuration
const BACKUP_DIR = path.join(__dirname, 'backups');
const DB_NAME = 'user';
const DB_USER = 'pass';
const DB_PASS = 'pass';
const MAX_BACKUPS = 10;

// Ensure the backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Backup function
function backupDatabase() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `${DB_NAME}_${timestamp}.sql`);
    const dumpCommand = `mysqldump -u ${DB_USER} -p${DB_PASS} ${DB_NAME} > ${backupFile}`;

    exec(dumpCommand, (err) => {
        if (err) {
            console.error('Error creating backup:', err);
            return;
        }

        console.log(`Backup created: ${backupFile}`);

        // Rotate backups
        const backups = fs.readdirSync(BACKUP_DIR).sort((a, b) => fs.statSync(path.join(BACKUP_DIR, a)).mtime - fs.statSync(path.join(BACKUP_DIR, b)).mtime);

        if (backups.length > MAX_BACKUPS) {
            const oldestBackup = path.join(BACKUP_DIR, backups[0]);
            fs.unlinkSync(oldestBackup);
            console.log(`Removed oldest backup: ${oldestBackup}`);
        }
    });
}

// Schedule daily backups at midnight
cron.schedule('0 0 * * *', backupDatabase);

// Existing routes (unchanged)
app.get('/search', async (req, res) => {
    const { state, city, county, market_name, status, id} = req.query;

    let whereClause = [];
    let values = [];

    if (state) {
        whereClause.push('state = ?');
        values.push(state);
    }
    if (city) {
        whereClause.push('city = ?');
        values.push(city);
    }
    if (county) {
        whereClause.push('county = ?');
        values.push(county);
    }
    if (market_name) {
        whereClause.push('market_name LIKE ?');
        values.push(`%${market_name}%`);
    }
    if (status) {
        whereClause.push('status = ?');
        values.push(status);
    }

    if (id) {
        whereClause.push('banner_id = ?');
        values.push(id);
    }

    const where = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

    try {
        const query = `
            SELECT 
                id,
                open_date,
                address,
                banner_name,
                market_name,
                status,
                notes,
                lat,
                lon
            FROM stores
            ${where};
        `;
        console.log(query);
        console.log(values);
        const [rows] = await db.query(query, values);
        res.json(rows);
    } catch (err) {
        console.error('Error executing query:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Movie search route
app.get('/movies', async (req, res) => {
    const { product_id, starring, long_name, description, genres, studio, release_month, release_day, release_year } = req.query;

    let whereClauses = [];
    let values = [];

    if (product_id) {
        whereClauses.push('product_id = ?');
        values.push(product_id);
    }
    if (starring) {
        whereClauses.push('JSON_CONTAINS(starring, ?)');
        values.push(JSON.stringify([starring]));
    }
    if (long_name) {
        whereClauses.push('long_name LIKE ?');
        values.push(`%${long_name}%`);
    }
    if (description) {
        whereClauses.push('description LIKE ?');
        values.push(`%${description}%`);
    }
    if (genres) {
        whereClauses.push('JSON_CONTAINS(genres, ?)');
        values.push(JSON.stringify({ [genres]: true }));
    }
    if (studio) {
        whereClauses.push('studio LIKE ?');
        values.push(`%${studio}%`);
    }

    if (release_year) {
        whereClauses.push('YEAR(release_date) = ?');
        values.push(release_year);
    }
    if (release_month) {
        whereClauses.push('MONTH(release_date) = ?');
        values.push(release_month);
    }
    if (release_day) {
        whereClauses.push('DAY(release_date) = ?');
        values.push(release_day);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
        const query = `SELECT * FROM products ${whereClause};`;
        const [rows] = await db.query(query, values);

        const formattedRows = rows.map((row) => {
            // Parse and format genres if it's a string
            if (row.genres) {
                if (typeof row.genres === 'string') {
                    try {
                        const genreObj = JSON.parse(row.genres);
                        row.genres = Object.keys(genreObj).join(', ');
                    } catch (e) {
                        console.error('Error parsing genres:', e);
                        row.genres = row.genres; // Keep as-is if parsing fails
                    }
                } else if (typeof row.genres === 'object') {
                    // If it's already an object, format it directly
                    row.genres = Object.keys(row.genres).join(', ');
                }
            }

            // Format description for HTML
            if (row.description) {
                row.description = row.description.replace(/\\r\\n/g, '<br>').replace(/\\/g, '');
            }

            return row;
        });

        res.json(formattedRows);
    } catch (err) {
        console.error('Error executing query:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.post('/update', async (req, res) => {
    const { id, status, notes } = req.body;

    // Validate input
    if (!id || !status) {
        return res.status(400).json({ error: 'Store ID and status are required.' });
    }

    // Whitelist valid statuses
    const validStatuses = ['Operational', 'Turned Off', 'Removed', 'Never Existed', 'Error (See notes for error code)'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value.' });
    }

    // Sanitize inputs to prevent JavaScript injection
    const sanitizedNotes = notes ? validator.escape(notes) : '';
    const sanitizedId = validator.escape(id);

    // Update the store in the database
    try {
        const query = `
            UPDATE stores
            SET status = ?, notes = ?
            WHERE id = ?;
        `;
        const [result] = await db.query(query, [status, sanitizedNotes, sanitizedId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Store not found.' });
        }

        res.json({ message: 'Store updated successfully.' });
    } catch (err) {
        console.error('Error updating store:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
