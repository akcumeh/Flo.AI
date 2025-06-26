import cron from 'node-cron';
import { sendStreakReminders, resetInactiveStreaks } from './streakManager.js';

/**
 * Schedule daily tasks for streak management
 */
export function initializeStreakCronJobs() {
    // Send streak reminders at 22:00 (10 PM) daily
    cron.schedule('0 22 * * *', async () => {
        console.log('Running streak reminders at 22:00...');
        try {
            await sendStreakReminders();
            console.log('Streak reminders completed');
        } catch (error) {
            console.error('Error running streak reminders:', error);
        }
    }, {
        timezone: "Africa/Lagos" // Nigerian timezone
    });

    // Reset inactive streaks at 00:01 (12:01 AM) daily
    cron.schedule('1 0 * * *', async () => {
        console.log('Running streak resets at 00:01...');
        try {
            await resetInactiveStreaks();
            console.log('Streak resets completed');
        } catch (error) {
            console.error('Error running streak resets:', error);
        }
    }, {
        timezone: "Africa/Lagos" // Nigerian timezone
    });

    console.log('Streak cron jobs initialized successfully');
}