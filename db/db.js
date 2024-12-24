import mongoose from 'mongoose';

export const connectDB = async (MONGO_URI) => {
    try {
        await mongoose.connect(MONGO_URI, 
           
        );
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        process.exit(1);
    }
};

export default connectDB;