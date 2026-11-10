create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create table users (
    user_id text primary key,
    name text not null,
    email text,
    tokens integer not null default 10,
    streak integer not null default 0,
    convo_history jsonb not null default '[]'::jsonb,
    convos jsonb not null default '[]'::jsonb,
    last_token_reward timestamptz not null default now(),
    last_active_date timestamptz,
    last_streak_update timestamptz,
    last_streak_reminder timestamptz,
    last_streak_reward timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger users_set_updated_at before update on users
    for each row execute function set_updated_at();

create index users_streak_idx on users (streak) where streak > 0;
create index users_last_active_idx on users (last_active_date);
create index users_created_at_idx on users (created_at);

create table transactions (
    reference text primary key,
    user_id text not null,
    amount bigint not null,
    tokens integer not null,
    email text,
    method text check (method in ('card', 'bank_transfer')),
    status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
    gateway_response jsonb,
    metadata jsonb,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '1 hour'),
    completed_at timestamptz
);

create index transactions_user_idx on transactions (user_id, created_at desc);
create index transactions_status_idx on transactions (status);
create index transactions_completed_idx on transactions (completed_at) where status = 'success';

create table verification_states (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    reference text not null,
    status text not null default 'verified' check (status in ('verified', 'failed')),
    tokens integer not null,
    verified_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (user_id, reference)
);

create table payment_states (
    id uuid primary key default gen_random_uuid(),
    user_id text not null unique,
    step text not null default 'init'
        check (step in ('init', 'bundle_select', 'email', 'save_card', 'processing', 'completed', 'cancelled')),
    method text check (method in ('card', 'bank')),
    amount integer not null default 1000,
    tokens integer not null default 10,
    email text,
    save_card boolean not null default false,
    reference text,
    created_at timestamptz not null default now()
);

create table request_states (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    token_cost integer not null default 1,
    message_id text,
    status text not null default 'processing'
        check (status in ('processing', 'completed', 'cancelled', 'failed')),
    prompt text,
    is_media boolean not null default false,
    media_type text check (media_type in ('photo', 'document')),
    media_file_id text,
    media_mime_type text,
    media_file_name text,
    error text,
    thinking_message_id bigint,
    chat_id text,
    created_at timestamptz not null default now()
);

create index request_states_message_idx on request_states (user_id, message_id);
create index request_states_status_idx on request_states (user_id, status, created_at);
create index request_states_created_idx on request_states (created_at);

create table media_groups (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    media_group_id text not null,
    status text not null default 'collecting'
        check (status in ('collecting', 'processing', 'completed', 'cancelled', 'failed')),
    caption text not null default '',
    media_items jsonb not null default '[]'::jsonb,
    token_cost integer not null default 2,
    result text,
    error text,
    expires_at timestamptz,
    last_activity timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index media_groups_lookup_idx on media_groups (user_id, media_group_id, status);
create index media_groups_created_idx on media_groups (created_at);

create table exam_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    platform text not null check (platform in ('tg', 'wa')),
    mode text not null default 'prep' check (mode in ('prep', 'create')),
    status text not null default 'collecting'
        check (status in ('collecting', 'choosing', 'quizzing', 'completed')),
    file_ids jsonb not null default '[]'::jsonb,
    requested_count integer not null default 0,
    generated_count integer not null default 0,
    questions jsonb not null default '[]'::jsonb,
    current_index integer not null default 0,
    answers jsonb not null default '[]'::jsonb,
    score integer not null default 0,
    charged boolean not null default false,
    files_released boolean not null default false,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger exam_sessions_set_updated_at before update on exam_sessions
    for each row execute function set_updated_at();

create index exam_sessions_user_idx on exam_sessions (user_id, status);
create index exam_sessions_expires_idx on exam_sessions (expires_at);

create table quiz_results (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    mode text not null default 'prep',
    score integer not null,
    total integer not null,
    failed_topics text[] not null default '{}',
    source_docs text[] not null default '{}',
    created_at timestamptz not null default now()
);

create index quiz_results_user_idx on quiz_results (user_id, created_at desc);

alter table users enable row level security;
alter table transactions enable row level security;
alter table verification_states enable row level security;
alter table payment_states enable row level security;
alter table request_states enable row level security;
alter table media_groups enable row level security;
alter table exam_sessions enable row level security;
alter table quiz_results enable row level security;
