export async function streakRemindersHandler(req, res) {
    // Verify the request is from an authorized source
    const authToken = req.headers.authorization?.split(' ')[1];
    if (authToken !== process.env.CRON_SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await sendStreakReminders();
        res.status(200).json({
            success: true,
            message: 'Streak reminders sent successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Cron job error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}