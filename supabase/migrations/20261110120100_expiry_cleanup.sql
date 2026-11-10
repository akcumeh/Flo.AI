create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
    'flo-expire-ephemeral-state',
    '*/10 * * * *',
    $$
    delete from request_states where created_at < now() - interval '24 hours';
    delete from payment_states where created_at < now() - interval '1 hour';
    delete from media_groups where created_at < now() - interval '24 hours';
    delete from exam_sessions where expires_at < now();
    $$
);
