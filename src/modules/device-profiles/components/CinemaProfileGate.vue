<script setup lang="ts">
/**
 * modules/device-profiles/components/CinemaProfileGate.vue
 *
 * Mounted by App.vue instead of CinemaIndex/CinemaRail whenever
 * isTVPlatform is true and no device profile is active yet -- see
 * types.ts/device-profiles.ts for what a "device profile" is. Once a
 * profile is selected (immediately, or after a correct PIN), this emits
 * 'unlocked' and gets swapped out for the real, completely untouched
 * CinemaIndex/CinemaRail.
 *
 * Scope, deliberately: profile picker + PIN + just enough of a
 * profile-creation form to bootstrap the very first profile on a fresh
 * device (there being zero profiles is the only way anyone would ever be
 * stuck otherwise). The FULL "manage profiles" screen -- edit an existing
 * profile's PEGI cap/PIN/showVotes/showComments/daily limit, link/unlink
 * Blurt accounts, delete a profile -- is ManageProfiles.vue, admin-only.
 * Adding a profile from THIS screen is bootstrap-only (profiles.length===0);
 * once at least one profile exists, further additions only happen through
 * ManageProfiles.
 */
import { ref, onMounted, nextTick, watch } from 'vue';
import {
  profiles, loadProfiles, createProfile, selectProfile, verifyProfilePin, setPin,
} from '../device-profiles';
import PinPad from './PinPad.vue';
import { useDpadRow } from '../dpad-row';
import { useBodyScrollLock } from '../body-scroll-lock';

const emit = defineEmits<{ unlocked: [] }>();

useBodyScrollLock();

const ready = ref(false);
const mode = ref<'picker' | 'pin' | 'create'>('picker');
const containerRef = ref<HTMLElement | null>(null);
const { refocusFirst } = useDpadRow(containerRef);
watch(mode, () => nextTick(refocusFirst));

const pinTargetId = ref<string | null>(null);
const pinError = ref<string | null>(null);
const pinPadRef = ref<InstanceType<typeof PinPad> | null>(null);

const AVATAR_COLORS = ['#e0575b', '#4f8cff', '#2ea884', '#c98a2e', '#8b5cf6', '#dd4fa0'];
function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}
const newName = ref('');
const newColor = ref(randomAvatarColor());
const nameInputRef = ref<HTMLInputElement | null>(null);

// Setting a PIN for the new profile: masked, two-step (enter, then confirm)
// via the same PinPad used everywhere else -- NOT a plain visible text
// field like this used to be. `confirmedPin` is null until both steps
// match; that's what actually gets applied on submitCreate().
const pinSetupStep = ref<'first' | 'confirm' | null>(null);
const pinSetupMismatch = ref(false);
const confirmedPin = ref<string | null>(null);
let pendingFirstPin = '';
const createPinPadRef = ref<InstanceType<typeof PinPad> | null>(null);

function startPinSetup(): void {
  pinSetupStep.value = 'first';
  pinSetupMismatch.value = false;
  pendingFirstPin = '';
}
function onCreatePinStep(pin: string): void {
  if (pinSetupStep.value === 'first') {
    pendingFirstPin = pin;
    pinSetupStep.value = 'confirm';
  } else if (pinSetupStep.value === 'confirm') {
    if (pin === pendingFirstPin) {
      confirmedPin.value = pin;
      pinSetupStep.value = null;
    } else {
      pinSetupMismatch.value = true;
      createPinPadRef.value?.fail();
      pinSetupStep.value = 'first';
      pendingFirstPin = '';
    }
  }
}
function clearPinSetup(): void {
  confirmedPin.value = null;
  pinSetupStep.value = null;
}

onMounted(async () => {
  await loadProfiles();
  ready.value = true;
  if (profiles.value.length === 0) {
    mode.value = 'create';
    await nextTick();
    nameInputRef.value?.focus();
  } else {
    await nextTick();
    refocusFirst();
  }
});

function pickProfile(id: string): void {
  const p = profiles.value.find(pr => pr.id === id);
  if (!p) return;
  if (p.pinHash) {
    pinTargetId.value = id;
    pinError.value = null;
    mode.value = 'pin';
  } else {
    selectProfile(id);
    emit('unlocked');
  }
}

async function onPinComplete(pin: string): Promise<void> {
  if (!pinTargetId.value) return;
  const ok = await verifyProfilePin(pinTargetId.value, pin);
  if (ok) {
    selectProfile(pinTargetId.value);
    emit('unlocked');
  } else {
    pinError.value = 'Błędny PIN, spróbuj ponownie';
    pinPadRef.value?.fail();
  }
}

function cancelPin(): void {
  mode.value = 'picker';
  pinTargetId.value = null;
  pinError.value = null;
}

async function submitCreate(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  const wasFirstProfile = profiles.value.length === 0;
  const profile = createProfile({ name, avatarColor: newColor.value });
  if (confirmedPin.value) await setPin(profile.id, confirmedPin.value);

  if (wasFirstProfile) {
    // Nothing to pick from before this -- go straight in.
    selectProfile(profile.id);
    emit('unlocked');
    return;
  }
  mode.value = 'picker';
}
</script>

<template>
  <div ref="containerRef" class="profile-gate">
    <div v-if="!ready" class="profile-gate-loading">
      <i class="fa-solid fa-spinner fa-spin"></i>
    </div>

    <template v-else>
      <!-- Picker -->
      <div v-if="mode === 'picker'" class="profile-gate-picker">
        <h1 class="profile-gate-title">Kto ogląda?</h1>
        <div class="profile-tiles">
          <button
            v-for="p in profiles" :key="p.id"
            class="profile-tile"
            @click="pickProfile(p.id)"
          >
            <span class="profile-avatar" :style="{ backgroundColor: p.avatarColor }">
              {{ p.name.charAt(0).toUpperCase() }}
            </span>
            <span class="profile-name">{{ p.name }}</span>
            <i v-if="p.pinHash" class="fa-solid fa-lock profile-lock-badge"></i>
          </button>
        </div>
        <p class="profile-gate-hint">Dodawanie i edycja profili — z poziomu profilu administratora, w "Zarządzaj profilami".</p>
      </div>

      <!-- PIN -->
      <div v-else-if="mode === 'pin'" class="profile-gate-pin">
        <PinPad
          ref="pinPadRef"
          title="Wpisz PIN"
          :subtitle="pinError"
          @complete="onPinComplete"
        />
        <button class="profile-gate-back" @click="cancelPin">
          <i class="fa-solid fa-arrow-left"></i> Wróć do wyboru profilu
        </button>
      </div>

      <!-- Create -->
      <div v-else class="profile-gate-create">
        <h1 class="profile-gate-title">{{ profiles.length === 0 ? 'Witaj! Utwórz pierwszy profil' : 'Nowy profil' }}</h1>
        <div class="create-form">
          <span class="profile-avatar create-form-avatar" :style="{ backgroundColor: newColor }">
            {{ (newName.charAt(0) || '?').toUpperCase() }}
          </span>
          <div class="color-swatches">
            <button
              v-for="c in AVATAR_COLORS" :key="c"
              class="color-swatch" :class="{ 'color-swatch--active': c === newColor }"
              :style="{ backgroundColor: c }"
              @click="newColor = c"
            ></button>
          </div>
          <input
            ref="nameInputRef"
            v-model="newName"
            class="create-form-input"
            type="text"
            placeholder="Imię"
            maxlength="20"
            @keydown.enter="submitCreate"
          />

          <!-- PIN: masked, two-step (enter/confirm) via PinPad -- never a
               plain visible text field, same as everywhere else PINs are
               entered in this app. -->
          <div class="create-pin-block">
            <template v-if="pinSetupStep">
              <PinPad
                ref="createPinPadRef"
                :title="pinSetupStep === 'first' ? 'Ustaw PIN (opcjonalnie)' : 'Powtórz PIN'"
                :subtitle="pinSetupMismatch ? 'PIN-y się nie zgadzały, spróbuj ponownie' : null"
                @complete="onCreatePinStep"
              />
            </template>
            <template v-else-if="confirmedPin">
              <div class="create-pin-set-row">
                <i class="fa-solid fa-lock"></i> PIN ustawiony
                <button class="profile-gate-back" @click="clearPinSetup">Usuń</button>
              </div>
            </template>
            <button v-else class="profile-gate-back" @click="startPinSetup">
              <i class="fa-solid fa-lock"></i> Ustaw PIN (opcjonalnie)
            </button>
          </div>

          <div class="create-form-actions">
            <button v-if="profiles.length > 0" class="profile-gate-back" @click="mode = 'picker'">Anuluj</button>
            <button class="create-form-submit" :disabled="!newName.trim()" @click="submitCreate">Utwórz profil</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.profile-gate {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at top, #1a1d24 0%, #0b0d12 60%);
  color: var(--text-strong);
  /* Belt-and-braces: this component's own content (create form + PIN pad
     together can be taller than a short window) never leaks into a
     page-level scrollbar -- see body-scroll-lock.ts for the other half of
     this guarantee. */
  overflow-y: auto;
}
.profile-gate-loading { font-size: 2rem; color: var(--text-soft); }

.profile-gate-title {
  font-size: 1.8rem;
  font-weight: 700;
  margin: 0 0 36px;
  text-align: center;
}

.profile-gate-picker { display: flex; flex-direction: column; align-items: center; }
.profile-tiles { display: flex; gap: 28px; flex-wrap: wrap; justify-content: center; max-width: 900px; }
.profile-gate-hint { margin-top: 28px; font-size: 0.8rem; color: var(--text-soft); }

.profile-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  background: transparent;
  border: none;
  color: var(--text-soft);
  padding: 6px;
  border-radius: 12px;
  position: relative;
}
.profile-tile:hover, .profile-tile:focus-visible {
  color: var(--text-strong);
  outline: none;
}
.profile-tile:focus-visible .profile-avatar,
.profile-tile:hover .profile-avatar {
  box-shadow: 0 0 0 4px var(--brand);
  transform: scale(1.06);
}
.profile-avatar {
  width: 112px; height: 112px;
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 2.4rem;
  font-weight: 700;
  color: #fff;
  transition: transform .12s ease, box-shadow .12s ease;
}
.profile-avatar--add { background: var(--surface-2); color: var(--text-soft); font-size: 1.8rem; }
.profile-name { font-size: 1rem; font-weight: 600; }
.profile-lock-badge {
  position: absolute; top: 4px; right: 4px;
  background: rgba(0,0,0,.6);
  border-radius: 50%;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px;
}

.profile-gate-pin { display: flex; flex-direction: column; align-items: center; gap: 24px; }
.profile-gate-back {
  background: none; border: none; color: var(--text-soft);
  font-size: 0.9rem; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 6px;
}
.profile-gate-back:hover, .profile-gate-back:focus-visible { color: var(--text-strong); background: var(--surface-2); outline: none; }

.profile-gate-create { display: flex; flex-direction: column; align-items: center; padding: 24px 0; }
.create-form { display: flex; flex-direction: column; align-items: center; gap: 16px; width: 320px; }
.create-form-avatar { width: 88px; height: 88px; font-size: 2rem; margin-bottom: 4px; }
.color-swatches { display: flex; gap: 10px; }
.color-swatch {
  width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer;
}
.color-swatch--active { border-color: var(--text-strong); }
.create-form-input {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
  color: var(--text-strong);
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 1rem;
}
.create-form-input:focus { outline: none; box-shadow: 0 0 0 3px var(--brand); }
.create-pin-block { display: flex; justify-content: center; width: 100%; }
.create-pin-set-row { display: flex; align-items: center; gap: 10px; font-size: 0.9rem; color: var(--text-soft); }
.create-form-actions { display: flex; gap: 12px; margin-top: 8px; width: 100%; }
.create-form-submit {
  flex: 1;
  background: var(--brand);
  color: #fff;
  border: none;
  padding: 12px 18px;
  border-radius: 8px;
  font-weight: 700;
}
.create-form-submit:disabled { opacity: 0.5; }
</style>
