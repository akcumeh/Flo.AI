import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

let isConnected = false;

export const ensureConnection = async (): Promise<void> => {
    if (isConnected && mongoose.connection.readyState === 1) {
        return;
    }

    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('Missing required environment variable: MONGODB_URI');

    try {
        await mongoose.connect(uri, {
            family: 4,
            directConnection: false,
            serverSelectionTimeoutMS: 5000,
        });
        isConnected = true;
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        throw error;
    }
};

export default ensureConnection;
