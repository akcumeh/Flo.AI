// api/warmup.js
import { connectDB } from '../db/db.js';
import dotenv from 'dotenv';

dotenv.config();

// Simple handler that connects to the database and returns quickly
export default async function handler(req, res) {
    try {
        // Connect to database (warms up the connection)
        await connectDB(process.env.MONGODB_URI);

        // Return success
        res.status(200).json({ status: 'warmed up', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Warm-up error:', error);
        res.status(500).json({ error: 'Warm-up failed', message: error.message });
    }
}