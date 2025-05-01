// admin.js - Script to manage user tokens
import dotenv from "dotenv";
import { connectDB } from "./db/db.js";
import { getUser, updateUser } from "./utils/utils.js";

// Load environment variables
dotenv.config();

async function main() {
    try {
        // Connect to the database first
        await connectDB(process.env.MONGODB_URI);
        console.log("Connected to database");

        // Get user by ID (format: prefix-userId)
        const userId = "tg-489613046"; // Change this to any user ID
        const user = await getUser(userId);

        if (!user) {
            console.error(`User ${userId} not found`);
            process.exit(1);
        }

        console.log(`User found: ${user.name}, Current tokens: ${user.tokens}`);

        // Deduct tokens
        await deductTokens(user, -4); // Change amount as needed

        console.log("Operation completed successfully");
        process.exit(0);
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

async function deductTokens(user, amount) {
    // Ensure amount is a positive number
    amount = Math.abs(amount);

    // Calculate new token balance (never below zero)
    const newBalance = Math.max(0, user.tokens - amount);

    // Update user in database
    await updateUser(user.userId, { tokens: newBalance });

    console.log(`Deducted ${amount} tokens from user ${user.name} (${user.userId})`);
    console.log(`Previous balance: ${user.tokens}, New balance: ${newBalance}`);

    return newBalance;
}

// Run the script
main();