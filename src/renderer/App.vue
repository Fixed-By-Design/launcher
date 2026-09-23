<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LauncherState } from '../shared/contracts'
import { memoryOptions, plainReleaseNotes } from '../shared/presentation'
const api = window.launcher!
const state = ref<LauncherState>({ access: 'signed-out', busy: false, cancellable: false, running: false, runtimeReady: false, minecraftNeedsLogin: true, message: api ? 'Chargement…' : 'Ouvre l’application pour te connecter.', messageType: 'info', memoryMode: 'auto', memoryMb: 4096, maxMemoryMb: 4096, recommendedMemoryMb: 4096, launcherVersion: '0.1.0', update: 'idle', microsoftConfigured: false })
const settings = ref(false)
const settingsDialog = ref<HTMLDialogElement>()
const settingsButton = ref<HTMLButtonElement>()
const memorySelect = ref<HTMLSelectElement>()
const codePanel = ref<HTMLElement>()
const copied = ref(false)
const scenes = [
  { src: './scenes/towers.png', label: 'Vos constructions', alt: 'Deux tours reliées par une passerelle au bord d’un lac', position: '56% center' },
  { src: './scenes/fireworks.png', label: 'Les soirées ensemble', alt: 'Des joueurs réunis sous un feu d’artifice sur Fixed SMP', position: '53% center' },
  { src: './scenes/panorama.png', label: 'Un monde à explorer', alt: 'Vue panoramique sur les montagnes, les rivières et les constructions du serveur', position: '38% center' },
]
const scene = ref(1)
const failure = ref('')
let unsubscribe: (() => void) | undefined
onMounted(async () => {
  if (!api) return
  unsubscribe = api.onState(value => { state.value = value; failure.value = '' })
  await act(async () => { state.value = await api.state() })
})
onUnmounted(() => unsubscribe?.())
async function act(action: () => Promise<unknown>) {
  failure.value = ''
  try { await action(); return true }
  catch { failure.value = state.value.messageType === 'error' ? state.value.message : 'L’action n’a pas abouti. Réessaie.'; return false }
}
const allowed = computed(() => state.value.access === 'allowed')
const denied = computed(() => state.value.access === 'denied')
const pending = computed(() => state.value.access === 'pending')
const unavailable = computed(() => state.value.access === 'unavailable')
const title = computed(() => denied.value ? 'Compte non autorisé' : unavailable.value ? 'Connexion indisponible' : pending.value ? 'À toi de jouer' : 'Bienvenue sur Fixed SMP')
const description = computed(() => denied.value ? 'Utilise le compte Discord avec lequel tu es membre de Fixed SMP.' : unavailable.value ? 'Impossible de vérifier ton accès. Ta session est conservée.' : pending.value ? 'Termine la connexion Discord dans la fenêtre de ton navigateur.' : 'Connecte-toi avec le compte Discord membre de Fixed SMP. Tu ajouteras ensuite ton compte Minecraft Java.')
const disabled = computed(() => state.value.busy || state.value.running)
const needsMicrosoft = computed(() => state.value.minecraftNeedsLogin || !state.value.minecraftName)
const hasError = computed(() => !!failure.value || state.value.messageType === 'error')
const statusMessage = computed(() => {
  if (hasError.value) return failure.value || state.value.message
  if (state.value.deviceCode) return state.value.cancellable ? 'En attente de validation dans le navigateur…' : state.value.message
  if (pending.value || denied.value || unavailable.value) return ''
  const redundant = ['Tout est prêt pour jouer.', 'Prêt pour la prochaine aventure.', 'Minecraft est en cours d’exécution.', 'Connecte-toi pour accéder à ton launcher.', 'Connexion réussie.']
  return redundant.includes(state.value.message) ? '' : state.value.message
})
const memoryLock = computed(() => state.value.running ? 'Ferme Minecraft pour modifier la mémoire.' : 'Attends la fin de la préparation pour modifier la mémoire.')
async function maintain() {
  settingsDialog.value?.close()
  if (api) await act(() => api.install())
}
const playLabel = computed(() => state.value.running ? 'Partie en cours'
  : state.value.busy ? state.value.operation === 'microsoft' ? 'Connexion Microsoft…' : 'Préparation en cours…'
  : needsMicrosoft.value ? state.value.minecraftName ? 'Reconnecter Microsoft' : 'Connecter Minecraft'
  : !state.value.release ? 'Réessayer'
  : !state.value.runtimeReady ? state.value.installedVersion ? 'Reprendre et jouer' : 'Installer et jouer'
  : 'Jouer')
const play = () => api && act(() => needsMicrosoft.value ? api.microsoftLogin() : !state.value.release ? api.refresh() : api.play())
const notes = computed(() => plainReleaseNotes(state.value.release?.notes || ''))
const memories = computed(() => memoryOptions(state.value.maxMemoryMb, state.value.memoryMb))
const memoryValue = computed(() => state.value.memoryMode === 'auto' ? 'auto' : String(state.value.memoryMb))
const memoryLabel = (value: number) => (value / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go'
const expiry = computed(() => state.value.deviceCodeExpiresAt ? new Date(state.value.deviceCodeExpiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '')
const lastUpdateCheck = computed(() => state.value.updateCheckedAt ? new Date(state.value.updateCheckedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '')
async function openSettings() {
  settings.value = true
  failure.value = ''
  settingsDialog.value?.showModal()
  await nextTick()
  if (!memorySelect.value?.disabled) memorySelect.value?.focus()
}
function closeSettings() {
  settings.value = false
  if (state.value.deviceCode) codePanel.value?.focus({ preventScroll: true })
  else settingsButton.value?.focus()
}
async function changeMemory(event: Event) {
  const select = event.target as HTMLSelectElement
  if (api) await act(() => api.setMemory(select.value === 'auto' ? 'auto' : Number(select.value)))
  select.value = memoryValue.value
}
async function copyCode() {
  if (api) copied.value = await act(() => api.copyDeviceCode())
}
watch(allowed, value => {
  scene.value = value ? 2 : 1
  if (!value) settingsDialog.value?.close()
})
watch(() => state.value.deviceCode, async code => {
  copied.value = false
  if (!code) return
  settingsDialog.value?.close()
  await nextTick()
  codePanel.value?.focus({ preventScroll: true })
  codePanel.value?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="identity"><img src="/icon.png" width="32" height="32" alt=""><span>FIXED BY DESIGN</span></div>
      <div class="top-actions">
        <span class="community-label">{{ allowed ? 'Discord · ' + state.discordName : 'Launcher communautaire' }}</span>
        <button v-if="allowed" ref="settingsButton" class="icon-button" aria-label="Paramètres" aria-haspopup="dialog" :aria-expanded="settings" @click="openSettings">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/></svg>
          Paramètres
        </button>
      </div>
    </header>
    <aside v-if="state.update === 'error' || state.update === 'available' || state.update === 'ready'" class="update-banner" :class="{ 'is-error': state.update === 'error' }" aria-label="Mise à jour du launcher">
      <p role="status">{{ state.update === 'error' ? state.updateMessage || 'Mise à jour du launcher indisponible.' : state.update === 'ready' ? (state.running ? 'Mise à jour prête. Ferme Minecraft pour redémarrer le launcher.' : state.busy ? 'Mise à jour prête. Attends la fin de l’opération.' : 'Une mise à jour du launcher est prête.') : 'Téléchargement de la mise à jour du launcher…' }}</p>
      <button v-if="state.update === 'error'" class="text-button" :disabled="!api" @click="api && act(() => api.checkUpdate())">Réessayer</button>
      <button v-if="state.update === 'ready'" class="secondary" :disabled="!api || disabled" @click="api && act(() => api.applyUpdate())">Redémarrer pour mettre à jour</button>
    </aside>

    <main class="gate" :class="{ dashboard: allowed, 'has-device-code': !!state.deviceCode }">
      <div v-if="!allowed" class="gate-copy">
        <span class="eyebrow">MINECRAFT · JAVA EDITION</span>
        <h1>{{ title }}</h1>
        <p class="intro">{{ description }}</p>
        <button v-if="!denied && !unavailable" class="primary discord" :disabled="!api || state.busy" @click="api && act(() => api.discordLogin())">
          <svg width="23" height="18" viewBox="0 0 24 20" fill="currentColor" aria-hidden="true"><path d="M20 2a19 19 0 0 0-5-1l-.6 1.3a18 18 0 0 0-5 0L9 1a19 19 0 0 0-5 1C1 6 0 10 1 15a19 19 0 0 0 6 3l1-2-2-1 .5-.4a16 16 0 0 0 11 0l.5.4-2 1 1 2a19 19 0 0 0 6-3c1-5 0-9-3-13ZM8 12c-1 0-1.6-1-1.6-2S7 8 8 8s1.6 1 1.6 2S9 12 8 12Zm8 0c-1 0-1.6-1-1.6-2S15 8 16 8s1.6 1 1.6 2S17 12 16 12Z"/></svg>
          {{ pending ? 'Connexion en cours…' : 'Continuer avec Discord' }}
        </button>
        <button v-else class="primary" :disabled="!api || state.busy" @click="api && act(() => denied ? api.discordLogin() : api.refresh())">{{ denied ? 'Changer de compte Discord' : 'Réessayer' }}</button>
        <div v-if="pending" class="gate-actions">
          <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.openDiscordLogin())">Rouvrir le navigateur ↗</button>
          <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.cancelOperation())">Annuler</button>
        </div>
        <p v-else-if="!denied && !unavailable" class="muted privacy">Connexion mémorisée sur cet appareil.</p>
        <p v-if="statusMessage" class="status-message" :class="{ 'is-error': hasError }" :role="hasError ? 'alert' : 'status'">{{ statusMessage }}</p>
      </div>

      <div v-else class="gate-copy launch-copy">
        <div class="pack-heading"><span class="eyebrow">MINECRAFT JAVA</span><span v-if="state.release" class="version-tag">Modpack {{ state.release.version }}</span></div>
        <h1 :class="{ 'visually-hidden': state.deviceCode }">Fixed SMP<span class="title-dot">.</span></h1>
        <p v-if="!state.deviceCode" class="intro">Un monde à construire ensemble.</p>
        <ol v-if="!state.runtimeReady || needsMicrosoft" class="setup-steps" aria-label="Préparer le jeu">
          <li class="complete"><span aria-hidden="true">✓</span> Discord</li><li :class="{ complete: !needsMicrosoft }" :aria-current="needsMicrosoft ? 'step' : undefined">{{ needsMicrosoft ? '2' : '✓' }} · Minecraft</li><li :aria-current="!needsMicrosoft ? 'step' : undefined">3 · Installation</li>
        </ol>
        <section v-if="state.deviceCode" ref="codePanel" class="device-code" tabindex="-1" aria-labelledby="code-title">
          <h2 id="code-title">Connexion Microsoft</h2>
          <p>Saisis ce code sur microsoft.com/link<span v-if="expiry"> avant {{ expiry }}</span>.</p>
          <strong>{{ state.deviceCode }}</strong>
          <div class="device-actions">
            <button class="secondary" :disabled="!state.cancellable" @click="copyCode">{{ copied ? 'Code copié' : 'Copier le code' }}</button>
            <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.openMicrosoftLogin())">Ouvrir la page Microsoft ↗</button>
            <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.cancelOperation())">Annuler</button>
          </div>
          <span v-if="copied" class="visually-hidden" role="status">Le code est dans le presse-papiers.</span>
        </section>
        <div v-else class="account minecraft-account">
          <div class="account-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M3 7l9 5v10"/></svg></div>
          <div class="account-name"><span class="muted">Compte Minecraft</span><strong>{{ state.minecraftName || 'Pas encore connecté' }}</strong></div>
          <button v-if="state.minecraftName" class="text-button" :disabled="disabled || !state.microsoftConfigured" aria-label="Choisir un autre compte Minecraft" @click="api && act(() => api.microsoftLogin())">Changer</button>
        </div>
        <section class="launch-panel" aria-label="Lancement du jeu">
          <button v-if="!state.deviceCode" class="primary play" :disabled="!api || disabled || !state.microsoftConfigured" @click="play"><span aria-hidden="true">{{ state.running ? '■' : needsMicrosoft ? '↗' : '▶' }}</span>{{ playLabel }}</button>
          <div class="launch-info" :class="{ 'error-panel': hasError }">
            <p v-if="statusMessage" :class="{ 'is-error': hasError }" :role="hasError ? 'alert' : 'status'">{{ statusMessage }}</p>
            <div v-if="state.busy && !state.deviceCode" class="progress" role="progressbar" aria-label="Progression de l’étape en cours" :aria-valuenow="state.progress" aria-valuemin="0" aria-valuemax="100"><span :class="{ indeterminate: state.progress === undefined }" :style="{ width: state.progress === undefined ? '30%' : state.progress + '%' }"></span></div>
            <span v-if="state.busy && !state.deviceCode && state.progress !== undefined" class="muted">{{ Math.round(state.progress) }} % de cette étape</span>
            <button v-if="state.cancellable && !state.deviceCode" class="text-button cancel-operation" @click="api && act(() => api.cancelOperation())">Annuler l’opération</button>
            <button v-if="hasError && !disabled && !needsMicrosoft" class="text-button" @click="api && act(() => api.openLogs())">Ouvrir les journaux ↗</button>
          </div>
        </section>
        <p v-if="!state.microsoftConfigured" class="notice">Connexion Microsoft indisponible dans cette version du launcher.</p>
      </div>

      <div class="landscape photo-gallery">
        <img class="scene-photo" :src="scenes[scene].src" :alt="scenes[scene].alt" :style="{ objectPosition: scenes[scene].position }">
        <div class="scene-shade"></div>
        <div class="scene-heading"><span>SUR NOTRE SERVEUR</span><span>0{{ scene + 1 }} / 03</span></div>
        <div class="scene-bottom"><p>{{ scenes[scene].label }}<span>.</span></p><div class="scene-picker" role="group" aria-label="Captures du serveur"><button v-for="(image, index) in scenes" :key="image.src" :aria-label="image.label" :aria-pressed="scene === index" :class="{ selected: scene === index }" @click="scene = index"><img :src="image.src" alt=""></button></div></div>
      </div>
      <div v-if="allowed && notes" class="dashboard-support">
        <details class="release-notes"><summary>Nouveautés du modpack <span>{{ state.release?.version }}</span></summary><div class="notes-body"><p tabindex="0" aria-label="Notes de version">{{ notes }}</p><button class="text-button" @click="api && act(() => api.openReleaseNotes())">Voir la publication sur Modrinth ↗</button></div></details>
      </div>
    </main>

    <footer>
      <span>Launcher {{ state.launcherVersion }}</span>
      <span v-if="state.update === 'checking' || state.update === 'current'" role="status" :title="lastUpdateCheck ? 'Dernière vérification : ' + lastUpdateCheck : undefined">{{ state.update === 'checking' ? 'Vérification…' : 'Launcher à jour' }}</span>
      <button v-if="state.update === 'idle' || state.update === 'current'" class="text-button" :disabled="!api" @click="api && act(() => api.checkUpdate())">Vérifier les mises à jour</button>
    </footer>

    <dialog ref="settingsDialog" class="settings-dialog" aria-labelledby="settings-title" @close="closeSettings">
      <div class="dialog-heading"><h2 id="settings-title">Paramètres</h2><button class="text-button" @click="settingsDialog?.close()">Fermer <span aria-hidden="true">×</span></button></div>
      <div class="settings">
        <section class="settings-section" aria-labelledby="memory-title">
          <div class="setting-row"><div><label id="memory-title" for="memory">Mémoire du jeu</label><p id="memory-help" class="muted">Enregistrée automatiquement.</p></div><select id="memory" ref="memorySelect" :value="memoryValue" :disabled="disabled" aria-describedby="memory-help" @change="changeMemory"><option value="auto">Auto · {{ memoryLabel(state.recommendedMemoryMb) }}</option><option v-for="memory in memories" :key="memory" :value="memory">{{ memoryLabel(memory) }}</option></select></div>
          <details class="memory-details"><summary>Comment choisir ?</summary><p>Auto utilise la moitié de la RAM, jusqu’à 8 Go. Tu peux aussi choisir une valeur fixe, jusqu’à {{ memoryLabel(state.maxMemoryMb) }} sur cet appareil.</p></details>
          <p v-if="state.preferredMemoryMb && state.preferredMemoryMb > state.memoryMb && state.memoryMode === 'manual'" class="notice">Ton choix de {{ memoryLabel(state.preferredMemoryMb) }} reste enregistré. {{ memoryLabel(state.memoryMb) }} sont utilisables sur cet appareil.</p>
          <p v-if="disabled" class="notice">{{ memoryLock }}</p>
        </section>
        <section class="settings-section" aria-labelledby="installation-title">
          <div class="section-heading"><h3 id="installation-title">Installation</h3><span class="muted">{{ state.installedVersion ? 'Modpack ' + state.installedVersion : 'Pas encore installé' }}</span></div>
          <div class="maintenance-actions"><button class="secondary" :disabled="state.busy" @click="api && act(() => api.openFolder())">Dossier du jeu ↗</button><button class="secondary" :disabled="state.busy" @click="api && act(() => api.openLogs())">Journaux ↗</button><button class="secondary" :disabled="disabled || needsMicrosoft || !state.release" @click="maintain">{{ state.runtimeReady ? 'Vérifier les fichiers' : 'Préparer sans lancer' }}</button></div>
        </section>
        <section class="settings-section" aria-labelledby="discord-title">
          <div class="setting-row"><div><h3 id="discord-title">Session Discord</h3><p class="muted">{{ state.discordName }}</p></div><button class="text-button" :disabled="disabled" @click="api && act(() => api.logout())">Se déconnecter</button></div>
          <p class="session-help muted">Déconnecte aussi le compte Minecraft de ce launcher.</p>
        </section>
      </div>
      <p v-if="failure" class="is-error" role="alert">{{ failure }}</p>
    </dialog>
  </div>
</template>
