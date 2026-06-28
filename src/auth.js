// src/auth.js
// Handles all authentication state and UI.

import { sb, ENV } from './supabase.js';
import { showToast } from './components/toast.js';
import { setLoading } from './components/spinner.js';

export let currentUser = null;

// Called once on app start. Resolves when auth state is known.
export async function initAuth(onSignedIn, onSignedOut) {
  // Check if this is a password reset or invite redirect
  const hash   = window.location.hash;
  const params = new URLSearchParams(hash.replace('#', '?'));
  const type   = params.get('type');

  // Handle via auth state change so we catch both hash and PKCE flows
  sb.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;

    // Show password form for recovery and invite events
    if (_event === 'PASSWORD_RECOVERY' || _event === 'USER_UPDATED' && type === 'recovery') {
      showResetPasswordUI('Set new password');
      return;
    }

    if (_event === 'SIGNED_IN' && (type === 'invite' || type === 'recovery')) {
      // First sign-in from invite or recovery link — show password form
      showResetPasswordUI(type === 'invite' ? 'Set your password' : 'Set new password');
      // Clear the hash so refreshing doesn't re-trigger
      history.replaceState(null, '', window.location.pathname);
      return;
    }

    if (currentUser) onSignedIn(currentUser);
    else onSignedOut();
  });

  const { data: { session } } = await sb.auth.getSession();
  currentUser = session?.user ?? null;

  // If no auth state change fired yet and no token in URL, resolve immediately
  if (!type) {
    if (currentUser) onSignedIn(currentUser);
    else onSignedOut();
  }
}

export async function signOut() {
  await sb.auth.signOut();
}

// ── Password reset UI ──────────────────────────────────────────
function showResetPasswordUI(title = 'Set new password') {
  const screen = document.getElementById('auth-screen');
  screen.style.display = 'flex';
  document.getElementById('app-screen').style.display  = 'none';
  document.getElementById('loading-overlay').style.display = 'none';

  const wordmark = document.querySelector('.auth-wordmark')?.innerHTML ?? 'App';
  screen.innerHTML = `
    <div class="auth-wordmark">${wordmark}</div>
    <p class="auth-tagline">${title}</p>
    <div class="auth-card">
      <div class="field">
        <label class="label" for="reset-password">New password</label>
        <input class="input" type="password" id="reset-password"
          placeholder="••••••••" autocomplete="new-password" />
      </div>
      <div class="field">
        <label class="label" for="reset-password-confirm">Confirm password</label>
        <input class="input" type="password" id="reset-password-confirm"
          placeholder="••••••••" autocomplete="new-password" />
      </div>
      <button class="btn btn-primary" id="reset-submit-btn">Set password</button>
      <div id="reset-message" class="auth-error"></div>
    </div>
  `;

  document.getElementById('reset-submit-btn').addEventListener('click', handlePasswordReset);
  document.getElementById('reset-password-confirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') handlePasswordReset();
  });
}

async function handlePasswordReset() {
  const password = document.getElementById('reset-password').value;
  const confirm  = document.getElementById('reset-password-confirm').value;
  const btn      = document.getElementById('reset-submit-btn');
  const msgEl    = document.getElementById('reset-message');

  msgEl.textContent = '';

  if (!password || !confirm) {
    msgEl.textContent = 'Please fill in both fields.';
    return;
  }
  if (password !== confirm) {
    msgEl.textContent = 'Passwords do not match.';
    return;
  }
  if (password.length < 8) {
    msgEl.textContent = 'Password must be at least 8 characters.';
    return;
  }

  setLoading(btn, true, 'Saving…');
  const { error } = await sb.auth.updateUser({ password });
  setLoading(btn, false, 'Set password');

  if (error) {
    msgEl.textContent = error.message;
    return;
  }

  // Clear the hash from the URL
  history.replaceState(null, '', window.location.pathname);

  // Sign out so they log in fresh with the new password
  await sb.auth.signOut();

  // Replace reset UI with login screen
  location.reload();
}

// ── Auth UI ────────────────────────────────────────────────────
let _authMode = 'login';

export function mountAuthUI() {
  document.getElementById('auth-login-tab')
    ?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('auth-signup-tab')
    ?.addEventListener('click', () => switchAuthTab('signup'));
  document.getElementById('auth-submit-btn')
    ?.addEventListener('click', handleAuthSubmit);
  document.getElementById('auth-password')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });
  document.getElementById('auth-forgot-btn')
    ?.addEventListener('click', handleForgotPassword);
}

async function handleForgotPassword() {
  const email = document.getElementById('auth-email')?.value.trim();
  if (!email) { setAuthMessage('Enter your email address first.', 'error'); return; }

  const btn = document.getElementById('auth-forgot-btn');
  setLoading(btn, true, 'Sending…');

  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/',
  });

  setLoading(btn, false, 'Forgot password?');

  if (error) { setAuthMessage(error.message, 'error'); return; }
  setAuthMessage('Password reset email sent — check your inbox.', 'success');
}

function switchAuthTab(mode) {
  _authMode = mode;
  document.getElementById('auth-login-tab')
    ?.classList.toggle('active', mode === 'login');
  document.getElementById('auth-signup-tab')
    ?.classList.toggle('active', mode === 'signup');
  document.getElementById('auth-submit-btn').textContent =
    mode === 'login' ? 'Sign in' : 'Create account';
  setAuthMessage('', '');
}

async function handleAuthSubmit() {
  const email    = document.getElementById('auth-email')?.value.trim();
  const password = document.getElementById('auth-password')?.value;
  const btn      = document.getElementById('auth-submit-btn');

  setAuthMessage('', '');
  if (!email || !password) { setAuthMessage('Please fill in all fields.', 'error'); return; }

  setLoading(btn, true, _authMode === 'login' ? 'Signing in…' : 'Creating account…');

  let error;
  if (_authMode === 'login') {
    ({ error } = await sb.auth.signInWithPassword({ email, password }));
  } else {
    ({ error } = await sb.auth.signUp({ email, password }));
  }

  setLoading(btn, false, _authMode === 'login' ? 'Sign in' : 'Create account');

  if (error) { setAuthMessage(error.message, 'error'); return; }
  if (_authMode === 'signup') {
    setAuthMessage('Check your email to confirm your account.', 'success');
  }
}

function setAuthMessage(msg, type) {
  const el = document.getElementById('auth-message');
  if (!el) return;
  el.textContent = msg;
  el.className   = type === 'error' ? 'auth-error' : 'auth-success';
}
