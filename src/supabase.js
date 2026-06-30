// src/supabase.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── Environment detection ──────────────────────────────────────
const TEST_HOST = 'test--enchanting-sfogliatella-b979c6.netlify.app';

function detectEnv() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'dev';
  if (host === TEST_HOST) return 'test';
  return 'prod';
}

const ENV_CONFIG = {
  dev: {
    url:          'https://joxtepnlerhepcsbqzct.supabase.co',
    anonKey:      'sb_publishable_2kGd_k2FKQqPXVovHW4Kow_mHCaPvis',
    companionUrl: 'http://localhost:8888',
  },
  test: {
    url:          'https://joxtepnlerhepcsbqzct.supabase.co',
    anonKey:      'sb_publishable_2kGd_k2FKQqPXVovHW4Kow_mHCaPvis',
    companionUrl: 'https://test--timaskraning.netlify.app',
  },
  prod: {
    url:          'https://xmgbjchkjlclknkjjjkh.supabase.co',
    anonKey:      'sb_publishable_IbiaMr5gsGUU8qtoeak5RQ_4fqZGFcV',
    companionUrl: 'https://logger.talva.is',
  },
};

export const ENV           = detectEnv();
const config               = ENV_CONFIG[ENV];
export const COMPANION_URL = config.companionUrl;

export const sb = createClient(config.url, config.anonKey);
