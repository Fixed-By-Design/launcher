# Fixed By Design Launcher

Launcher communautaire Windows x64 et macOS Apple Silicon/Intel pour Fixed SMP. Accès par Discord, authentification Microsoft/Minecraft Java, installation isolée de Java/Fabric et synchronisation du modpack.

## Installer

Télécharger le petit installateur correspondant à son système depuis les [releases](https://github.com/Fixed-By-Design/launcher/releases/latest). Il recherche la dernière release standard compatible au moment de l’installation, puis télécharge et vérifie le launcher complet. Aucun compte GitHub ni jeton n’est nécessaire.

**Version expérimentale sans signature commerciale.** Windows peut afficher SmartScreen ou bloquer l’exécutable. Les applications macOS sont signées ad hoc pour la cohérence technique de leurs bundles, sans authentification de l’éditeur ni notarisation ; Gatekeeper peut empêcher leur ouverture. Aucun installateur ne désactive ces protections ou ne retire les marqueurs de provenance Internet. Une politique d’entreprise peut empêcher totalement l’installation.

Le bootstrap Windows nécessite Windows x64 (Intel/AMD) et .NET Framework 4.8. Il ouvre l’installateur NSIS complet, avec choix du dossier. Le bootstrap macOS universel nécessite macOS 12 ou ultérieur, choisit automatiquement le payload Apple Silicon ou Intel et installe dans `~/Applications/Fixed By Design.app`, sans droits administrateur. Le launcher lui-même peut exiger une version macOS plus récente selon Electron.

L’installation ne connecte pas de compte et ne télécharge pas Minecraft. Au premier lancement : Discord, compte Microsoft possédant Minecraft Java, puis **Installer et jouer**. Les vérifications automatisées ne remplacent pas une recette réelle avec ces comptes et le jeu.

## Interface et mémoire

Le compte Minecraft et le bouton « Jouer » sont réunis sur l’accueil, à côté des captures du serveur. Les notes de version se déplient sous la zone de lancement, avec un accès à la publication Modrinth. Les paramètres regroupent mémoire, dossier du jeu, journaux, vérification des fichiers et session Discord. Les actions restent visibles aux petites tailles ; les paramètres sont accessibles au clavier, avec restauration du focus. Le navigateur peut être rouvert pendant une connexion Discord en cours.

Les nouveaux profils utilisent **Auto** : moitié de la RAM physique, arrondie au Go inférieur (1 Go = 1 024 Mio), entre 2 et 8 Go. Exemples : 4 Go physiques donnent 2 Go alloués ; 8 donnent 4 ; 12 donnent 6 ; 16 Go et plus donnent 8. La limite manuelle réserve 2 Go au système et plafonne à 16 Go, avec un minimum de 2 Go pour le jeu. Sur une machine de moins de 4 Go, cette réserve n’est donc pas garantie et le jeu peut ne pas être utilisable.

Les choix manuels et les anciennes valeurs enregistrées restent conservés, même si elles correspondent à l’ancien défaut de 4 Go. Une préférence dépassant la capacité de la machine est plafonnée à l’exécution sans écraser la valeur enregistrée. Le mode Auto doit être choisi explicitement pour remplacer ce choix.

## Téléchargements et mises à jour

Les bootstraps interrogent uniquement la release standard courante de ce dépôt public. Son `launcher-manifest.json` associe version, plateforme, nom du fichier, taille et SHA-512. Le tag, l’origine, les redirections, l’architecture, la taille et l’empreinte sont vérifiés avant installation. Les transferts interrompus ou invalides ne remplacent pas l’application existante. Le remplacement macOS échange atomiquement les dossiers après vérification et conserve la provenance Internet.

Cette intégrité repose sur HTTPS, GitHub et le contrôle du dépôt. Un manifeste provenant du même dépôt n’est **pas** une signature cryptographique de l’éditeur et ne protège pas contre la compromission de ce dépôt.

Le feed `electron-updater` utilise les GitHub Releases du même dépôt, avec les manifestes `latest.yml` et `latest-mac.yml`, les ZIP macOS et les blockmaps. Une mise à jour impossible est signalée avec réessai. La validation native d’une mise à jour macOS ad hoc entre deux versions reste à réaliser ; si le système la refuse, utiliser à nouveau le bootstrap, sans désactiver les protections. Les mises à jour du modpack restent indépendantes, automatiques après la première installation, hors partie et hors préparation mise en pause.

Les releases standard de ce dépôt constituent le canal communautaire **expérimental**. « Standard » permet leur résolution par l’API GitHub `/releases/latest` ; cela ne signifie pas une validation production, une signature d’éditeur ou une notarisation.

## Développer et vérifier

Node.js 24 LTS et un environnement graphique Windows/macOS :

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
npm start
```

La configuration `public/launcher-config.json` contient seulement l’URL de l’API et le Client ID Microsoft public. Aucun secret n’est requis dans le launcher. Le backend lit les variables de `.env.example` ; les secrets sont à fournir séparément, jamais dans Git ou dans les artefacts.

Le harnais UI utilise des états simulés pour rendre le frontend de production ; il n’est pas embarqué dans l’application. Les tests natifs des bootstraps vérifient sélection de version, intégrité, erreurs, annulation et préservation des fichiers. Le workflow de packaging effectue aussi une installation silencieuse NSIS sous Windows et une installation/remplacement du bundle sous macOS, sans compte ni lancement du jeu.

Le workflow **Build test installers** produit les payloads et petits bootstraps sans publier. Après téléchargement de ses artefacts dans un même dossier :

```sh
node scripts/release-manifest.mjs release
```

Assembler tous les assets et sommes de contrôle dans une release draft, puis vérifier leur cohérence avant publication. Ne jamais publier une release standard incomplète : elle serait immédiatement visible des bootstraps. Aucun serveur supplémentaire n’est nécessaire pour distribuer les binaires.
