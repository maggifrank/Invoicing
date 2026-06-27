// src/supabase.js
// Single Supabase client instance shared across the entire app.
// Loaded once — all modules import from here.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── Environment detection ──────────────────────────────────────
const TEST_HOST = 'test--enchanting-sfogliatella-b979c6.netlify.app'; // ← update to your test site hostname

function detectEnv() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'dev';
  if (host === TEST_HOST) return 'dev';
  return 'prod';
}

const ENV_CONFIG = {
  dev: {
    url:     'https://joxtepnlerhepcsbqzct.supabase.co',
    anonKey: 'sb_publishable_2kGd_k2FKQqPXVovHW4Kow_mHCaPvis',
  },
  prod: {
    url:     'https://jymsciwhjkahbeurvgdk.supabase.co',
    anonKey: 'sb_publishable_gtZrH7Pz5YOxqHq_fnKK4Q_OQNukt_f',
  },
};

export const ENV = detectEnv();
const config = ENV_CONFIG[ENV];

export const sb = createClient(config.url, config.anonKey);
