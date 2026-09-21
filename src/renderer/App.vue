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
const title = computed(() => denied.value ? 'Accès non autorisé.' : unavailable.value ? 'Un instant, voyageur.' : pending.value ? 'À tout de suite.' : 'L’aventure commence ici.')
const description = computed(() => denied.value ? 'Utilise le compte Discord avec lequel tu es membre de Fixed SMP.' : unavailable.value ? 'Nous devons vérifier ton accès avant de continuer. Ta session est conservée.' : pending.value ? 'Termine la connexion Discord dans la fenêtre de ton navigateur.' : 'Connecte ton compte Discord, puis ton compte Minecraft Java pour préparer ton aventure.')
const disabled = computed(() => state.value.busy || state.value.running)
const needsMicrosoft = computed(() => state.value.minecraftNeedsLogin || !state.value.minecraftName)
const launchTitle = computed(() => state.value.running ? 'Bonne exploration.' : needsMicrosoft.value ? 'Prépare ton aventure.' : 'Le monde t’attend.')
const launchDescription = computed(() => state.value.running ? 'Profite de Fixed SMP. Ton launcher reste ici pour ton retour.'
  : needsMicrosoft.value ? 'Connecte ton compte Minecraft Java. Le launcher s’occupe du reste.'
  : 'Retrouve tes constructions, les autres joueurs et de nouveaux horizons.')
const playLabel = computed(() => state.value.running ? 'Minecraft est lancé'
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
  settingsButton.value?.focus()
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
      <div class="identity"><img src="/icon.png" width="36" height="36" alt=""><span>FIXED BY DESIGN<span class="identity-sub">LAUNCHER</span></span></div>
      <span class="top-note">Une autre façon de jouer.</span>
      <button v-if="allowed" ref="settingsButton" class="icon-button" aria-label="Paramètres" aria-haspopup="dialog" :aria-expanded="settings" @click="openSettings">⚙</button>
      <span v-else class="edition">ÉDITION COMMUNAUTAIRE</span>
    </header>
    <aside v-if="state.update === 'error' || state.update === 'available' || state.update === 'ready'" class="update-banner" :class="{ 'is-error': state.update === 'error' }" aria-label="Mise à jour du launcher">
      <p role="status">{{ state.update === 'error' ? state.updateMessage || 'La mise à jour du launcher est indisponible.' : state.update === 'ready' ? (disabled ? 'Mise à jour prête. Termine l’opération et ferme Minecraft pour redémarrer.' : 'Une mise à jour du launcher est prête.') : 'Téléchargement de la mise à jour du launcher…' }}</p>
      <button v-if="state.update === 'error'" class="text-button" :disabled="!api" @click="api && act(() => api.checkUpdate())">Réessayer</button>
      <button v-if="state.update === 'ready'" class="secondary" :disabled="!api || disabled" @click="api && act(() => api.applyUpdate())">Redémarrer pour mettre à jour</button>
    </aside>

    <main class="gate" :class="{ dashboard: allowed, 'has-device-code': !!state.deviceCode }">
      <div v-if="!allowed" class="gate-copy">
        <span class="eyebrow"><span class="tiny-square"></span> FIXED SMP</span>
        <h1>{{ title }}</h1>
        <p class="intro">{{ description }}</p>
        <button v-if="!denied && !unavailable" class="primary discord" :disabled="!api || state.busy" @click="api && act(() => api.discordLogin())">
          <svg width="23" height="18" viewBox="0 0 24 20" fill="currentColor" aria-hidden="true"><path d="M20 2a19 19 0 0 0-5-1l-.6 1.3a18 18 0 0 0-5 0L9 1a19 19 0 0 0-5 1C1 6 0 10 1 15a19 19 0 0 0 6 3l1-2-2-1 .5-.4a16 16 0 0 0 11 0l.5.4-2 1 1 2a19 19 0 0 0 6-3c1-5 0-9-3-13ZM8 12c-1 0-1.6-1-1.6-2S7 8 8 8s1.6 1 1.6 2S9 12 8 12Zm8 0c-1 0-1.6-1-1.6-2S15 8 16 8s1.6 1 1.6 2S17 12 16 12Z"/></svg>
          {{ pending ? 'Connexion en cours…' : 'Se connecter avec Discord' }} <span class="arrow">↗</span>
        </button>
        <div v-else class="gate-actions">
          <button class="primary" :disabled="!api || state.busy" @click="api && act(() => api.refresh())">Réessayer <span>↗</span></button>
          <button class="text-button" :disabled="!api || state.busy" @click="api && act(async () => { await api.logout(); await api.discordLogin() })">Changer de compte</button>
        </div>
        <p v-if="!denied && !unavailable" class="privacy">La connexion sera mémorisée sur cet appareil.</p>
        <button v-if="state.cancellable" class="text-button" @click="api && act(() => api.cancelOperation())">{{ pending ? 'Annuler la connexion' : 'Annuler l’opération' }}</button>
        <p class="status-message" :class="{ 'is-error': failure || state.messageType === 'error' }" :role="failure || state.messageType === 'error' ? 'alert' : 'status'">{{ failure || state.message }}</p>
      </div>
      <div v-else class="gate-copy launch-copy">
        <span class="eyebrow"><span class="tiny-square"></span> TON PROCHAIN CHAPITRE</span>
        <h1 :class="{ 'visually-hidden': state.deviceCode }">{{ launchTitle }}</h1>
        <p v-if="!state.deviceCode" class="intro">{{ launchDescription }}</p>
        <ol v-if="!state.runtimeReady || needsMicrosoft" class="setup-steps" aria-label="Préparer le jeu">
          <li class="complete">1. Discord</li><li :class="{ complete: !needsMicrosoft }" :aria-current="needsMicrosoft ? 'step' : undefined">2. Minecraft Java</li><li :aria-current="!needsMicrosoft ? 'step' : undefined">3. Installation</li>
        </ol>
        <section v-if="state.deviceCode" ref="codePanel" class="device-code" tabindex="-1" aria-labelledby="code-title">
          <h2 id="code-title">Connecte ton compte Minecraft Java</h2>
          <p>Ouvre microsoft.com/link et saisis ce code<span v-if="expiry"> avant {{ expiry }}</span>.</p>
          <strong>{{ state.deviceCode }}</strong>
          <div class="device-actions">
            <button class="secondary" :disabled="!state.cancellable" @click="copyCode">{{ copied ? 'Code copié' : 'Copier le code' }}</button>
            <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.openMicrosoftLogin())">Ouvrir la page Microsoft ↗</button>
            <button class="text-button" :disabled="!state.cancellable" @click="api && act(() => api.cancelOperation())">Annuler</button>
          </div>
          <span v-if="copied" role="status">Le code est dans le presse-papiers.</span>
        </section>
        <div v-else class="launch-context"><span>FIXED SMP<span v-if="state.release"> · {{ state.release.version }}</span></span><span>RAM {{ state.memoryMode === 'auto' ? 'Auto · ' : '' }}{{ memoryLabel(state.memoryMb) }}</span></div>
        <section class="launch-panel" aria-label="Lancement du jeu">
          <button v-if="!state.deviceCode" class="primary play" :disabled="!api || disabled || !state.microsoftConfigured" @click="play"><span aria-hidden="true">{{ needsMicrosoft ? '↗' : '▶' }}</span>{{ playLabel }}</button>
          <div class="launch-info">
            <p :class="{ 'is-error': failure || state.messageType === 'error' }" :role="failure || state.messageType === 'error' ? 'alert' : 'status'">{{ failure || state.message }}</p>
            <div v-if="state.busy" class="progress" role="progressbar" aria-label="Progression de l’étape en cours" :aria-valuenow="state.progress" aria-valuemin="0" aria-valuemax="100"><span :class="{ indeterminate: state.progress === undefined }" :style="{ width: state.progress === undefined ? '30%' : state.progress + '%' }"></span></div>
            <span v-if="state.busy && state.progress !== undefined" class="muted">{{ Math.round(state.progress) }} % de cette étape</span>
            <button v-if="state.cancellable && !state.deviceCode" class="text-button cancel-operation" @click="api && act(() => api.cancelOperation())">Annuler l’opération</button>
          </div>
        </section>
        <p v-if="!needsMicrosoft && !state.installedVersion && !state.busy" class="notice">Le premier lancement télécharge Minecraft, Java et le modpack dans une instance séparée. Prévois une connexion internet et de l’espace disque. Les mises à jour suivantes restent automatiques.</p>
        <p v-if="!state.microsoftConfigured" class="notice">La connexion Minecraft sera disponible dès que l’application Microsoft du launcher sera configurée.</p>
        <div class="account"><span class="presence"></span><span>{{ state.discordName }}</span><button class="text-button small" :disabled="disabled" @click="api && act(() => api.logout())">Déconnexion</button></div>
      </div>
      <div class="landscape photo-gallery">
        <img class="scene-photo" :src="scenes[scene].src" :alt="scenes[scene].alt" :style="{ objectPosition: scenes[scene].position }">
        <div class="scene-shade"></div>
        <div class="scene-heading"><span>INSTANTS DE FIXED SMP</span><span>0{{ scene + 1 }} / 03</span></div>
        <div class="scene-bottom"><p>{{ scenes[scene].label }}.</p><div class="scene-picker" role="group" aria-label="Captures du serveur"><button v-for="(image, index) in scenes" :key="image.src" :aria-label="image.label" :aria-pressed="scene === index" :class="{ selected: scene === index }" @click="scene = index"><img :src="image.src" alt=""></button></div></div>
      </div>
      <div v-if="allowed" class="dashboard-support">
        <section class="details" aria-label="Ton installation">
          <div><span class="eyebrow">COMPTE MINECRAFT</span><p>{{ state.minecraftName || 'Pas encore connecté' }}<span v-if="state.minecraftName && needsMicrosoft" class="muted"> · À reconnecter</span></p><button class="text-button small" :disabled="disabled || !state.microsoftConfigured" @click="api && act(() => api.microsoftLogin())">Choisir un autre compte</button></div>
          <div><span class="eyebrow">MODPACK</span><p>{{ state.installedVersion ? 'Version ' + state.installedVersion : 'Pas encore installé' }}</p><span class="muted">{{ state.runtimeReady ? 'Jeu et Java prêts' : 'Préparation du jeu nécessaire' }}</span></div>
          <div><span class="eyebrow">FICHIERS DU JEU</span><p>{{ state.busy ? 'Opération en cours' : state.running ? 'Minecraft est ouvert' : state.runtimeReady ? 'Installation prête' : 'À préparer' }}</p><button class="text-button small" :disabled="disabled || needsMicrosoft" @click="api && act(() => api.install())">{{ state.runtimeReady ? 'Vérifier les fichiers' : 'Préparer sans lancer' }} ↗</button></div>
        </section>
        <details v-if="notes" class="release-notes"><summary class="eyebrow">DANS CETTE VERSION <span>{{ state.release?.version }}</span></summary><p tabindex="0" aria-label="Notes de version">{{ notes }}</p></details>
      </div>
    </main>
    <footer>
      <span>FIXED BY DESIGN <span class="muted">/ {{ state.launcherVersion }}</span></span>
      <span role="status" :title="lastUpdateCheck ? 'Dernière vérification : ' + lastUpdateCheck : undefined">{{ state.update === 'checking' ? 'Vérification des mises à jour…' : state.update === 'current' ? 'Launcher à jour · ' + lastUpdateCheck : 'Pensé pour prendre le temps.' }}</span>
      <button v-if="state.update === 'idle' || state.update === 'current'" class="text-button" :disabled="!api" @click="api && act(() => api.checkUpdate())">Vérifier les mises à jour</button>
    </footer>
    <dialog ref="settingsDialog" class="settings-dialog" aria-labelledby="settings-title" @close="closeSettings">
      <div class="dialog-heading"><h2 id="settings-title">Paramètres</h2><button class="text-button" @click="settingsDialog?.close()">Fermer</button></div>
      <div class="settings">
        <div><label for="memory" class="eyebrow">MÉMOIRE ALLOUÉE</label><select id="memory" ref="memorySelect" :value="memoryValue" :disabled="disabled" aria-describedby="memory-help" @change="changeMemory"><option value="auto">Auto · {{ memoryLabel(state.recommendedMemoryMb) }} conseillés</option><option v-for="memory in memories" :key="memory" :value="memory">{{ memoryLabel(memory) }}</option></select><p id="memory-help" class="muted">Auto adapte la mémoire à cet appareil : la moitié de la RAM, jusqu’à 8 Go. Maximum manuel : {{ memoryLabel(state.maxMemoryMb) }}.</p><p v-if="state.memoryMode === 'manual'" class="muted">Ton choix manuel est conservé jusqu’à ce que tu sélectionnes Auto.</p><p v-if="state.preferredMemoryMb && state.preferredMemoryMb > state.memoryMb && state.memoryMode === 'manual'" class="notice">Ton choix de {{ memoryLabel(state.preferredMemoryMb) }} reste enregistré. Il est limité à {{ memoryLabel(state.memoryMb) }} sur cet appareil pour garder de la mémoire au système.</p></div>
        <button class="secondary" :disabled="state.busy" @click="api && act(() => api.openFolder())">Ouvrir le dossier du jeu ↗</button>
      </div>
      <p v-if="disabled" class="notice">Ferme Minecraft et termine l’opération en cours pour modifier la mémoire.</p>
      <p v-if="failure" class="is-error" role="alert">{{ failure }}</p>
    </dialog>
  </div>
</template>
