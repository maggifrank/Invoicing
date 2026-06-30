// src/pages/settings.js

import { sb } from '../supabase.js';
import { currentUser } from '../auth.js';
import { showToast } from '../components/toast.js';
import { setLoading } from '../components/spinner.js';
import { getCycleForDate, cyclePeriodLabel, isoDate } from '../utils.js';

export function mount(container, profile) {
  const p = profile ?? {};

  container.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem">
      <div class="section-label">Your details (appear on every invoice)</div>
      <div class="field">
        <label class="label">Full name</label>
        <input class="input" type="text" id="s-name" placeholder="Fullt nafn" value="${esc(p.issuer_name)}" />
      </div>
      <div class="field input-row">
        <div>
          <label class="label">Kennitala</label>
          <input class="input" type="text" id="s-kennitala" placeholder="Kennitala" value="${esc(p.issuer_kennitala)}" />
        </div>
        <div>
          <label class="label">VSK númer</label>
          <input class="input" type="text" id="s-vsk" placeholder="(blank if not registered)" value="${esc(p.issuer_vsk)}" />
        </div>
      </div>
      <div class="field">
        <label class="label">Address</label>
        <input class="input" type="text" id="s-address" placeholder="Heimilisfang" value="${esc(p.issuer_address)}" />
      </div>
      <div class="field">
        <label class="label">City</label>
        <input class="input" type="text" id="s-city" placeholder="Póstnúmer og bær" value="${esc(p.issuer_city)}" />
      </div>
      <div class="field">
        <label class="label">Email</label>
        <input class="input" type="email" id="s-email" placeholder="nafn@len.is" value="${esc(p.issuer_email)}" />
      </div>
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <div class="section-label">Default bank details</div>
      <div class="field">
        <label class="label">Account number (kennitala)</label>
        <input class="input" type="text" id="s-bank-account" placeholder="Kennitala" value="${esc(p.bank_account)}" />
      </div>
      <div class="field input-row-3">
        <div>
          <label class="label">Útibú</label>
          <input class="input" type="text" id="s-utibú" placeholder="Banki" value="${esc(p.bank_utibú)}" />
        </div>
        <div>
          <label class="label">Hb</label>
          <input class="input" type="text" id="s-hb" placeholder="Hb" value="${esc(p.bank_hb)}" />
        </div>
        <div>
          <label class="label">Reikn.nr.</label>
          <input class="input" type="text" id="s-reikningur" placeholder="Reikningsnúmer" value="${esc(p.bank_reikningur)}" />
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <div class="section-label">Defaults</div>
      <div class="field input-row">
        <div>
          <label class="label">Default hourly rate (ISK)</label>
          <input class="input" type="number" id="s-rate" placeholder="Tímagjald" value="${esc(p.default_rate)}" />
        </div>
        <div>
          <label class="label">Default invoice prefix</label>
          <input class="input" type="text" id="s-prefix" placeholder="YRAB" value="${esc(p.invoice_prefix)}" />
        </div>
      </div>
      <div class="field">
        <label class="label">VSK rate (%)</label>
        <div class="setting-desc" style="margin-bottom:0.5rem">Leave at 0 if not VSK registered. Set to 24 when registered with Skatturinn.</div>
        <input class="input" type="number" id="s-vsk-rate" placeholder="0" min="0" max="100"
          value="${esc(p.vsk_rate ?? 0)}" style="width:100px" />
      </div>
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <div class="section-label">Payment cycle</div>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Cycle start day</div>
          <div class="setting-desc">The day of the month your pay period begins.</div>
        </div>
        <select class="input" id="s-cycle-day" style="width:72px" onchange="updateCyclePreview()">
          ${Array.from({ length: 28 }, (_, i) => i + 1)
            .map(d => `<option value="${d}"${d === (p.cycle_start_day ?? 21) ? ' selected' : ''}>${d}</option>`)
            .join('')}
        </select>
      </div>
      <div class="cycle-preview" id="s-cycle-preview">${buildCyclePreview(p.cycle_start_day ?? 21)}</div>
    </div>

    <div class="card" style="margin-bottom:1rem">
      <div class="section-label">Invoice notifications</div>
      <div class="field">
        <label class="label">Draft preview email</label>
        <div class="setting-desc" style="margin-bottom:0.5rem">Staging invoices generated on the 22nd (and manual drafts) will be sent here.</div>
        <input class="input" type="email" id="s-preview-email" placeholder="nafn@len.is" value="${esc(p.preview_email)}" />
      </div>
      <div class="setting-row" style="padding-top:0.75rem">
        <div class="setting-info">
          <div class="setting-name">Copy to self on send</div>
          <div class="setting-desc">Receive a copy of every real invoice when sent to the client.</div>
        </div>
        <input type="checkbox" id="s-copy-self" ${p.copy_to_self ? 'checked' : ''}
          style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;flex-shrink:0" />
      </div>
    </div>

    <button class="btn btn-primary" id="s-save-btn" onclick="saveSettings()">Save settings</button>

    <div class="card" style="margin-top:1rem">
      <div class="section-label">Invite user</div>
      <div class="setting-desc" style="margin-bottom:0.75rem">
        Send an invite email to a new user. They'll receive a link to set their password.
      </div>
      <div style="display:flex;gap:0.5rem">
        <input class="input" type="email" id="s-invite-email" placeholder="nafn@len.is" style="flex:1"
          onkeydown="if(event.key==='Enter') sendInvite()" />
        <button class="btn btn-primary" id="s-invite-btn" onclick="sendInvite()"
          style="width:auto;padding:0.7rem 1rem;font-size:0.85rem;white-space:nowrap">
          Send invite
        </button>
      </div>
    </div>
  `;
}

export async function saveSettings(profile) {
  const btn = document.getElementById('s-save-btn');
  setLoading(btn, true, 'Saving…');

  const updates = {
    id:               currentUser.id,
    issuer_name:      document.getElementById('s-name').value.trim(),
    issuer_kennitala: document.getElementById('s-kennitala').value.trim(),
    issuer_vsk:       document.getElementById('s-vsk').value.trim()       || null,
    issuer_address:   document.getElementById('s-address').value.trim(),
    issuer_city:      document.getElementById('s-city').value.trim(),
    issuer_email:     document.getElementById('s-email').value.trim(),
    bank_account:     document.getElementById('s-bank-account').value.trim(),
    bank_utibú:       document.getElementById('s-utibú').value.trim(),
    bank_hb:          document.getElementById('s-hb').value.trim(),
    bank_reikningur:  document.getElementById('s-reikningur').value.trim(),
    default_rate:     parseInt(document.getElementById('s-rate').value)    || null,
    invoice_prefix:   document.getElementById('s-prefix').value.trim()    || null,
    vsk_rate:         parseFloat(document.getElementById('s-vsk-rate').value) || 0,
    cycle_start_day:  parseInt(document.getElementById('s-cycle-day').value),
    preview_email:    document.getElementById('s-preview-email').value.trim() || null,
    copy_to_self:     document.getElementById('s-copy-self').checked,
  };

  const { error } = await sb.from('profiles').upsert(updates);
  setLoading(btn, false, 'Save settings');

  if (error) { showToast('Could not save settings', 'error'); console.error(error); return; }

  if (profile) Object.assign(profile, updates);
  showToast('Settings saved');
}

export function updateCyclePreview() {
  const day = parseInt(document.getElementById('s-cycle-day')?.value ?? 21);
  const el  = document.getElementById('s-cycle-preview');
  if (el) el.textContent = buildCyclePreview(day);
}

function buildCyclePreview(day) {
  const { start, end } = getCycleForDate(new Date(), day);
  return `Current cycle: ${cyclePeriodLabel(isoDate(start), isoDate(end))}`;
}

function esc(val) {
  return String(val ?? '').replace(/"/g, '&quot;');
}
