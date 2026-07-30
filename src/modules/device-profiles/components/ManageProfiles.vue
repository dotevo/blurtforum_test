<script setup lang="ts">
/**
 * modules/device-profiles/components/ManageProfiles.vue
 *
 * Full admin panel for device profiles -- reached from CinemaRail's
 * "Zarządzaj profilami" rail item, itself only visible when the active
 * profile isAdmin (see CinemaRail.vue). Renders as a slide-in side panel
 * (same .side-panel-* convention as CinemaRail's own notifications/payout
 * panels), not a full-screen overlay -- consistent with how every other
 * "show me something" surface in cinema mode works.
 *
 * Also where Blurt account switching/logout live *on TV* -- see the
 * "Konto Blurt" section below. Deliberately admin-only and tucked away
 * here rather than in the main rail: switching which person is watching
 * (device profile) is the frequent, everyday action on a shared TV and
 * lives prominently in the rail (see CinemaRail's "Przełącz profil");
 * logging out of / switching the underlying Blurt account is a rarer,
 * more consequential action better gated behind admin.
 */
import { ref, computed } from 'vue';
import type { AuthUser } from '../../../types';
import {
  profiles, createProfile, updateProfile, deleteProfile,
  setPin, clearPin,
} from '../device-profiles';
import type { DeviceProfile, PegiRating } from '../types';
import PinPad from './PinPad.vue';
import { useDpadRow } from '../dpad-row';
import { useBodyScrollLock } from '../body-scroll-lock';

const props = defineProps<{
  auth: { user: AuthUser | null; accounts: AuthUser[] };
}>();

const emit = defineEmits<{
  close: [];
  openSwitchAccountModal: [];
  logout: [];
}>();

useBodyScrollLock();

const panelRef = ref<HTMLElement | null>(null);
const { refocusFirst } = useDpadRow(panelRef);

type Mode = 'list' | 'edit' | 'create';
const mode = ref<Mode>('list');
const editingId = ref<string | null>(null);
const deleteError = ref<string | null>(null);

const AVATAR_COLORS = ['#e0575b', '#4f8cff', '#2ea884', '#c98a2e', '#8b5cf6', '#dd4fa0'];
const PEGI_OPTIONS: { value: PegiRating | null; label: string }[] = [
  { value: null, label: 'Brak limitu (dorosły)' },
  { value: 'PEGI_3', label: 'PEGI 3' },
  { value: 'PEGI_7', label: 'PEGI 7' },
  { value: 'PEGI_12', label: 'PEGI 12' },
  { value: 'PEGI_16', label: 'PEGI 16' },
  { value: 'PEGI_18', label: 'PEGI 18' },
];

// Editable draft -- edits to an existing profile only actually apply on
// "Zapisz", so navigating away (or the admin changing their mind) doesn't
// leave a half-edited profile behind.
const draft = ref(freshDraft());

function freshDraft() {
  return {
    name: '', avatarColor: AVATAR_COLORS[0], isAdmin: false,
    maxRating: null as PegiRating | null, showVotes: true, showComments: true,
    dailyLimitMinutes: null as number | null, linkedUsernames: [] as string[],
  };
}

const editingProfile = computed<DeviceProfile | null>(() => profiles.value.find(p => p.id === editingId.value) ?? null);
const isLastAdmin = (p: DeviceProfile) => p.isAdmin && profiles.value.filter(pr => pr.isAdmin).length <= 1;

function openCreate(): void {
  editingId.value = null;
  draft.value = freshDraft();
  mode.value = 'create';
  void refocusAfterModeChange();
}

function openEdit(p: DeviceProfile): void {
  editingId.value = p.id;
  draft.value = {
    name: p.name, avatarColor: p.avatarColor, isAdmin: p.isAdmin,
    maxRating: p.maxRating, showVotes: p.showVotes, showComments: p.showComments,
    dailyLimitMinutes: p.dailyLimitMinutes, linkedUsernames: [...p.linkedUsernames],
  };
  pinSetupStep.value = null;
  mode.value = 'edit';
  void refocusAfterModeChange();
}

function backToList(): void {
  mode.value = 'list';
  editingId.value = null;
  pinSetupStep.value = null;
  void refocusAfterModeChange();
}

async function refocusAfterModeChange(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  refocusFirst();
}

function toggleAccount(username: string, checked: boolean): void {
  const set = new Set(draft.value.linkedUsernames);
  if (checked) set.add(username); else set.delete(username);
  draft.value.linkedUsernames = [...set];
}

function saveDraft(): void {
  const name = draft.value.name.trim();
  if (!name) return;

  if (mode.value === 'create') {
    const p = createProfile({
      name, avatarColor: draft.value.avatarColor,
      maxRating: draft.value.maxRating, showVotes: draft.value.showVotes,
      showComments: draft.value.showComments, dailyLimitMinutes: draft.value.dailyLimitMinutes,
      linkedUsernames: draft.value.linkedUsernames,
    });
    // isAdmin on create is decided by device-profiles.ts itself (first-ever
    // profile only) -- if the admin explicitly wants THIS new profile to
    // also be an admin, honor that as a follow-up update.
    if (draft.value.isAdmin && !p.isAdmin) updateProfile(p.id, { isAdmin: true });
  } else if (editingProfile.value) {
    const current = editingProfile.value;
    // Never silently drop the device's last admin bit via this form.
    const nextIsAdmin = isLastAdmin(current) ? true : draft.value.isAdmin;
    updateProfile(current.id, {
      name, avatarColor: draft.value.avatarColor, isAdmin: nextIsAdmin,
      maxRating: draft.value.maxRating, showVotes: draft.value.showVotes,
      showComments: draft.value.showComments, dailyLimitMinutes: draft.value.dailyLimitMinutes,
      linkedUsernames: draft.value.linkedUsernames,
    });
  }
  backToList();
}

function onDelete(p: DeviceProfile): void {
  const res = deleteProfile(p.id);
  deleteError.value = res.ok ? null : (res.reason === 'last-admin'
    ? 'Nie można usunąć jedynego profilu administratora.'
    : 'Nie udało się usunąć profilu.');
}

// ── PIN set/change (two-step: enter, then confirm) ──────────────────────
const pinSetupStep = ref<'first' | 'confirm' | null>(null);
const pinMismatch = ref(false);
let pendingPin = '';
const pinPadRef = ref<InstanceType<typeof PinPad> | null>(null);

function startPinSetup(): void {
  pinSetupStep.value = 'first';
  pinMismatch.value = false;
  pendingPin = '';
}

function onPinStepComplete(pin: string): void {
  if (pinSetupStep.value === 'first') {
    pendingPin = pin;
    pinSetupStep.value = 'confirm';
  } else if (pinSetupStep.value === 'confirm') {
    if (pin === pendingPin) {
      if (editingProfile.value) void setPin(editingProfile.value.id, pin);
      pinSetupStep.value = null;
    } else {
      pinMismatch.value = true;
      pinPadRef.value?.fail();
      pinSetupStep.value = 'first';
      pendingPin = '';
    }
  }
}

function onClearPin(): void {
  if (editingProfile.value) clearPin(editingProfile.value.id);
}
</script>

<template>
  <div class="side-panel-overlay" @click="emit('close')"></div>
  <div ref="panelRef" class="side-panel">
    <div class="side-panel-header">
      <span>{{ mode === 'list' ? 'Zarządzaj profilami' : (mode === 'create' ? 'Nowy profil' : 'Edytuj profil') }}</span>
      <button class="side-panel-close" @click="mode === 'list' ? emit('close') : backToList()">
        <i class="fa-solid" :class="mode === 'list' ? 'fa-xmark' : 'fa-arrow-left'"></i>
      </button>
    </div>

    <div class="side-panel-body">
      <!-- List -->
      <div v-if="mode === 'list'" class="manage-list">
        <p v-if="deleteError" class="manage-error">{{ deleteError }}</p>
        <div v-for="p in profiles" :key="p.id" class="manage-row">
          <span class="profile-avatar manage-row-avatar" :style="{ backgroundColor: p.avatarColor }">
            {{ p.name.charAt(0).toUpperCase() }}
          </span>
          <div class="manage-row-info">
            <div class="manage-row-name">
              {{ p.name }}
              <span v-if="p.isAdmin" class="manage-badge">Admin</span>
              <i v-if="p.pinHash" class="fa-solid fa-lock manage-row-icon"></i>
            </div>
            <div class="manage-row-sub">
              {{ p.maxRating || 'Bez limitu PEGI' }} · {{ p.linkedUsernames.length }} kont(o/a) Blurt
            </div>
          </div>
          <button class="manage-btn" @click="openEdit(p)">Edytuj</button>
          <button class="manage-btn manage-btn--danger" @click="onDelete(p)">Usuń</button>
        </div>
        <button class="manage-btn manage-btn--primary manage-add" @click="openCreate">
          <i class="fa-solid fa-plus"></i> Dodaj profil
        </button>

        <div class="manage-blurt-section">
          <h2 class="manage-section-title">Konto Blurt</h2>
          <p v-if="auth.user" class="manage-hint">Zalogowano jako @{{ auth.user.username }}</p>
          <div class="manage-blurt-actions">
            <button class="manage-btn" @click="emit('openSwitchAccountModal')">
              <i class="fa-solid fa-users-viewfinder"></i> Przełącz konto Blurt
            </button>
            <button class="manage-btn manage-btn--danger" @click="emit('logout')">
              <i class="fa-solid fa-right-from-bracket"></i> Wyloguj z Blurt
            </button>
          </div>
        </div>
      </div>

      <!-- Create/Edit -->
      <div v-else class="manage-edit">
        <span class="profile-avatar manage-edit-avatar" :style="{ backgroundColor: draft.avatarColor }">
          {{ (draft.name.charAt(0) || '?').toUpperCase() }}
        </span>
        <div class="color-swatches">
          <button
            v-for="c in AVATAR_COLORS" :key="c"
            class="color-swatch" :class="{ 'color-swatch--active': c === draft.avatarColor }"
            :style="{ backgroundColor: c }"
            @click="draft.avatarColor = c"
          ></button>
        </div>
        <input v-model="draft.name" class="manage-input" type="text" placeholder="Imię" maxlength="20" />

        <label class="manage-checkbox">
          <input type="checkbox" v-model="draft.isAdmin" :disabled="!!editingProfile && isLastAdmin(editingProfile)" />
          Administrator
        </label>

        <!-- PIN -->
        <div class="manage-pin-block">
          <template v-if="pinSetupStep">
            <PinPad
              ref="pinPadRef"
              :title="pinSetupStep === 'first' ? 'Ustaw nowy PIN' : 'Powtórz PIN'"
              :subtitle="pinMismatch ? 'PIN-y się nie zgadzały, spróbuj ponownie' : null"
              @complete="onPinStepComplete"
            />
          </template>
          <template v-else-if="editingProfile">
            <button class="manage-btn" @click="startPinSetup">
              {{ editingProfile.pinHash ? 'Zmień PIN' : 'Ustaw PIN' }}
            </button>
            <button v-if="editingProfile.pinHash" class="manage-btn manage-btn--danger" @click="onClearPin">Usuń PIN</button>
          </template>
          <p v-else class="manage-hint">PIN można ustawić po zapisaniu nowego profilu.</p>
        </div>

        <label class="manage-field-label">Limit treści (PEGI)</label>
        <select v-model="draft.maxRating" class="manage-input">
          <option v-for="opt in PEGI_OPTIONS" :key="opt.label" :value="opt.value">{{ opt.label }}</option>
        </select>

        <label class="manage-checkbox"><input type="checkbox" v-model="draft.showVotes" /> Pokazuj głosy</label>
        <label class="manage-checkbox"><input type="checkbox" v-model="draft.showComments" /> Pokazuj komentarze</label>

        <label class="manage-field-label">Dzienny limit oglądania (minuty, puste = bez limitu)</label>
        <input
          class="manage-input" type="number" min="0" step="5"
          :value="draft.dailyLimitMinutes ?? ''"
          @input="draft.dailyLimitMinutes = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null"
        />

        <label class="manage-field-label">Podpięte konta Blurt</label>
        <div class="manage-accounts">
          <label v-for="acc in auth.accounts" :key="acc.username" class="manage-checkbox">
            <input
              type="checkbox"
              :checked="draft.linkedUsernames.includes(acc.username)"
              @change="toggleAccount(acc.username, ($event.target as HTMLInputElement).checked)"
            />
            @{{ acc.username }}
          </label>
          <p v-if="!auth.accounts.length" class="manage-hint">Brak zalogowanych kont Blurt.</p>
        </div>

        <div class="manage-edit-actions">
          <button class="manage-btn" @click="backToList">Anuluj</button>
          <button class="manage-btn manage-btn--primary" :disabled="!draft.name.trim()" @click="saveDraft">Zapisz</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Same convention as CinemaRail's .cinema-side-panel-* (notifications/payout
   panels) -- duplicated here (scoped styles don't cross component
   boundaries) rather than sharing a stylesheet, since this is a
   self-contained component. Slightly wider (420px vs 340px) to fit the
   profile-edit form's fields comfortably. */
.side-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 2100;
  background: rgba(0,0,0,0.4);
}
.side-panel {
  position: fixed;
  top: 0;
  left: 72px;
  height: 100vh;
  width: 420px;
  max-width: calc(100vw - 72px);
  background: var(--surface-1);
  border-right: 1px solid var(--surface-border);
  box-shadow: 10px 0 30px rgba(0,0,0,0.35);
  z-index: 2101;
  display: flex;
  flex-direction: column;
  color: var(--text-strong);
}
.side-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--surface-border);
  font-weight: bold;
  flex-shrink: 0;
}
.side-panel-close {
  background: none; border: none; color: var(--text-soft);
  font-size: 16px; padding: 4px 8px; border-radius: 6px;
}
.side-panel-close:hover, .side-panel-close:focus-visible { color: var(--brand); background: var(--surface-2); outline: none; }
.side-panel-body { flex: 1; overflow-y: auto; padding: 16px; }
@media (max-width: 768px) {
  .side-panel { left: 0; width: 100vw; max-width: 100vw; }
}

.manage-error { color: #e0575b; margin-bottom: 12px; }

.manage-list { display: flex; flex-direction: column; gap: 12px; }
.manage-row {
  display: flex; align-items: center; gap: 12px;
  background: var(--card-bg); border: 1px solid var(--surface-border);
  border-radius: 10px; padding: 10px 12px; flex-wrap: wrap;
}
.manage-row-avatar { width: 40px; height: 40px; font-size: 1rem; border-radius: 8px; flex-shrink: 0; }
.manage-row-info { flex: 1; min-width: 120px; }
.manage-row-name { font-weight: 700; display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
.manage-row-sub { font-size: 0.75rem; color: var(--text-soft); margin-top: 2px; }
.manage-row-icon { color: var(--text-soft); }
.manage-badge {
  font-size: 0.6rem; text-transform: uppercase; letter-spacing: .04em;
  background: var(--brand); color: #fff; padding: 2px 6px; border-radius: 4px;
}
.manage-add { align-self: flex-start; margin-top: 4px; }

.manage-btn {
  background: var(--surface-3); border: 1px solid var(--surface-border);
  color: var(--text-strong); padding: 8px 14px; border-radius: 8px; font-size: 0.82rem;
}
.manage-btn:hover, .manage-btn:focus-visible { box-shadow: 0 0 0 3px var(--brand); outline: none; }
.manage-btn--primary { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 700; }
.manage-btn--primary:disabled { opacity: 0.5; }
.manage-btn--danger { color: #e0575b; }

.manage-blurt-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--surface-border); }
.manage-section-title { font-size: 0.85rem; margin: 0 0 8px; color: var(--text-soft); text-transform: uppercase; letter-spacing: .04em; }
.manage-blurt-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }

.manage-edit { display: flex; flex-direction: column; gap: 12px; }
.manage-edit-avatar { width: 72px; height: 72px; font-size: 1.6rem; align-self: center; }
.color-swatches { display: flex; gap: 10px; align-self: center; }
.color-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; }
.color-swatch--active { border-color: var(--text-strong); }

.manage-input {
  background: var(--surface-3); border: 1px solid var(--surface-border);
  color: var(--text-strong); padding: 10px 12px; border-radius: 8px; font-size: 0.9rem;
}
.manage-field-label { font-size: 0.72rem; color: var(--text-soft); margin-top: 4px; }
.manage-checkbox { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
.manage-hint { font-size: 0.78rem; color: var(--text-soft); }
.manage-accounts { display: flex; flex-direction: column; gap: 6px; }
.manage-pin-block { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.manage-edit-actions { display: flex; gap: 12px; margin-top: 12px; }

.profile-avatar {
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; color: #fff; border-radius: 8px;
}
</style>
