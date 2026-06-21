create extension if not exists pgcrypto;

create table if not exists public.portal_records (
  id uuid primary key default gen_random_uuid(),
  app text not null,
  type text not null,
  record_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app, type, record_id)
);

create index if not exists portal_records_app_type_idx
  on public.portal_records (app, type);

alter table public.portal_records enable row level security;

-- Geen public policies nodig: de Render Node-server gebruikt een server-side secret key.
