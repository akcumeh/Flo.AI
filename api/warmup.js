import { connectDB } from '../db/db.js';
import dotenv from 'dotenv';
import { ensureConnection } from '../db/connection.js';

dotenv.config();

// Simple handler that connects to the database and returns quickly
export default async function handler(req, res) {
    try {
        // Connect to database (warms up the connection)
        await ensureConnection();

        // Return success
        res.status(200).json({ status: 'warmed up', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Warm-up error:', error);
        res.status(500).json({ error: 'Warm-up failed', message: error.message });
    }
}