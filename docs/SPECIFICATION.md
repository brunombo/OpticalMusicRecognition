# Spécification — Application Partition vers MIDI vers Audio

**Version 1.0 (définitive) — 11 novembre 2026 — Auteur : Bruno**

## 1. Synthèse

L'application web s'exécute dans un navigateur, sur ordinateur comme sur mobile. Elle permet de photographier une partition, de la convertir en fichier MIDI, puis de rendre ce MIDI en audio. L'utilisateur choisit, pour chaque portée, un instrument parmi au moins quatre options (piano, cordes, flûte, voix ou autre).

Le flux comporte deux étapes principales : (1) reconnaissance musicale optique (OMR) de l'image vers un MusicXML, puis un MIDI multipiste ; (2) synthèse audio avec attribution d'un instrument par portée, exportée en WAV ou en MP3. Tout s'exécute dans le navigateur, sans serveur. La base technique retenue est MusicOCR (moteur copista-2m), complétée par un module MIDI propre, un synthétiseur SoundFont et un encodeur MP3.

## 2. Objectifs et périmètre

**Objectifs.**

- Capturer une partition avec la caméra du navigateur ou importer une image ou un PDF.
- Produire un MIDI fidèle, avec une piste et un instrument (programme MIDI) par portée.
- Permettre la correction des erreurs de reconnaissance avant export.
- Rendre un audio où chaque portée a son instrument, choisi parmi au moins quatre.
- Exporter en MIDI et MusicXML, et rendre l'audio au choix en WAV ou en MP3.

  Fonctionner dans un navigateur récent, sans installation, avec traitement local par défaut.

**Hors périmètre de la version 1.**

- Partitions manuscrites (prévues en version 2).
- Tablatures et notation percussive complexe.
- Édition de partition complète (l'application corrige, elle n'est pas un éditeur de notation).
- Synthèse vocale chantée avec paroles.

## 3. Utilisateurs et cas d'usage

- Un musicien veut entendre une partition imprimée qu'il ne sait pas encore déchiffrer.
- Un enseignant veut générer un accompagnement audio pour ses élèves.
- Un choriste veut écouter sa propre voix isolée ou mise en avant.
- Un compositeur veut numériser rapidement une partition imprimée pour la retravailler dans un autre logiciel.

## 4. Parcours utilisateur

Premièrement, l'utilisateur photographie la partition ou l'importe. Un assistant de cadrage détecte les bords, redresse la perspective et signale le flou ou le manque de lumière.

Deuxièmement, l'application lance la reconnaissance. Elle affiche la partition reconnue, avec les mesures douteuses surlignées.

Troisièmement, l'utilisateur corrige les erreurs (hauteur, durée, armure, métrique) dans une vue simple, puis valide.

Quatrièmement, l'application génère le MIDI multipiste. L'utilisateur peut l'écouter avec un son par défaut et l'exporter.

Cinquièmement, l'utilisateur ouvre l'écran de rendu audio. Pour chaque portée, il choisit un instrument, règle le volume et le panoramique, puis lance le rendu.

Sixièmement, il écoute le résultat et exporte l'audio.

## 5. Exigences fonctionnelles

### 5.1 Capture et prétraitement de l'image

- **F1.** Capture par la caméra du navigateur (API MediaDevices, getUserMedia) avec guide de cadrage en temps réel ; repli sur l'import de fichier si la caméra est refusée ou absente.
- **F2.** Import d'images (JPEG, PNG, HEIC) et de PDF multipages.
- **F3.** Correction automatique de perspective, de rotation et de contraste.
- **F4.** Détection de la qualité : alerte si la résolution est inférieure à 200 ppp équivalents ou si l'image est floue.
- **F5.** Support de plusieurs pages, assemblées dans l'ordre choisi.

### 5.2 Reconnaissance musicale (OMR)

- **F6.** Détection des portées, des systèmes et des accolades.
- **F7.** Reconnaissance des clés (sol, fa, ut), armures, métriques, notes, silences, altérations, liaisons de prolongation, points, nuances de base et reprises simples.
- **F8.** Sortie en une piste par portée, avec regroupement des portées d'un même instrument (par exemple piano main droite et main gauche).
- **F9.** Indice de confiance par mesure ; les mesures sous le seuil sont surlignées.
- **F10.** Détection du tempo écrit (indication métronomique) ; à défaut, tempo par défaut modifiable.

### 5.3 Correction

- **F11.** Vue superposée : image d'origine et partition reconnue côte à côte.
- **F12.** Modification d'une note (hauteur, durée, altération), ajout, suppression.
- **F13.** Modification globale de l'armure, de la métrique, du tempo.
- **F14.** Annuler et rétablir.
- **F15.** Lecture de la mesure sélectionnée pour vérifier à l'oreille.

### 5.4 Génération MIDI

- **F16.** Export MIDI de type 1 (multipiste), une piste par portée, avec tempo, métrique et armure.
- **F17.** Export complémentaire en MusicXML.
- **F18.** Prise en compte des reprises et des da capo pour la lecture (option activable).

### 5.5 Rendu audio et choix des instruments

- **F19.** Pour chaque portée, un sélecteur d'instrument propose au moins quatre choix, issus de familles variées. Catalogue minimal de la version 1 :
  - Claviers : piano acoustique, piano électrique, clavecin, orgue.
  - Cordes : violon, alto, violoncelle, ensemble de cordes.
  - Vents : flûte, hautbois, clarinette, saxophone.
  - Voix : chœur « aah », voix soliste synthétique.
  - Autres : guitare classique, harpe, vibraphone, cuivres.
- **F20.** Pré-écoute d'un instrument sur la portée concernée avant de valider le choix.
- **F21.** Instrument par défaut proposé selon l'étendue de la portée (une portée grave propose violoncelle ou piano en premier).
- **F22.** Réglages par portée : volume, panoramique, muet, solo.
- **F23.** Avertissement si les notes dépassent l'étendue réaliste de l'instrument choisi, avec transposition d'octave proposée.
- **F24.** Réglage global : tempo, réverbération, transposition.
- **F25.** Sortie audio au choix de l'utilisateur : WAV (sans perte, fichier volumineux) ou MP3 (compressé, fichier léger). Un sélecteur de format s'affiche sur l'écran d'export, avec le débit du MP3 réglable (128, 192 ou 256 kbit/s, 192 par défaut) et une estimation de la taille du fichier. Le choix est mémorisé pour les exports suivants. L'export porte sur le mélange complet ou, au choix, sur des pistes séparées (stems) par portée, dans le même format.
- **F26.** Enregistrement des préréglages d'assignation d'instruments (par exemple « quatuor à cordes »).

### 5.6 Projets et partage

- **F27.** Sauvegarde locale des projets dans le navigateur (IndexedDB) : image, partition reconnue, choix d'instruments ; export et import d'un fichier de projet pour la sauvegarde externe.
- **F28.** Téléchargement des fichiers et partage par le menu natif (Web Share API) quand le navigateur le propose.

## 6. Exigences non fonctionnelles

- **Performance.** Reconnaissance d'une page standard en moins de 15 secondes sur ordinateur (environ 4 secondes mesurées par l'auteur de MusicOCR, modèles en cache) ; cible à mesurer sur téléphone, où aucune mesure n'existe. Rendu audio d'une pièce de trois minutes en moins de 20 secondes. Reconnaissance et rendu s'exécutent dans des Web Workers pour ne pas bloquer l'interface.
- **Exactitude.** Cible : F1 sur les hauteurs d'au moins 95 % et F1 sur hauteurs et rythme d'au moins 80 % sur chaque page de test. À titre de repère, l'auteur de MusicOCR mesure 97,9 % et 94,7 % avec copista-2m sur trois photos d'une même pièce. L'échantillon est mince : la cible est à mesurer sur nos partitions, pas une garantie.
- **Hors ligne.** Après le premier chargement, l'application fonctionne sans connexion grâce à un Service Worker qui met en cache le code, les modèles de reconnaissance (environ 16 Mo par défaut) et les banques de sons. Le Service Worker ajoute aussi les en-têtes COOP et COEP, ce qui permet un hébergement statique de type GitHub Pages ; la toute première visite se recharge une fois.
- **Confidentialité.** Aucune image ni partition ne quitte le navigateur sans consentement explicite ; tout le traitement est local par défaut.
- **Accessibilité.** Taille de texte ajustable, contraste élevé, étiquettes pour lecteurs d'écran.
- **Langues.** Français en version 1, interface prête pour la traduction.
- **Droits d'auteur.** Rappel à l'utilisateur de respecter les droits sur les partitions numérisées ; l'application ne les diffuse pas.

  **Compatibilité.** Versions récentes de Chrome, Edge, Firefox et Safari (ordinateur, Android, iOS). Les fonctions indisponibles sur un navigateur donné se dégradent proprement, avec un message clair.

## 7. Architecture technique proposée

**Hypothèse de travail** : application web monopage (PWA) qui exécute tout le traitement dans le navigateur, sans serveur obligatoire. Elle est installable sur l'écran d'accueil et fonctionne hors ligne.

- **Interface.** Application web responsive (ordinateur, tablette, mobile) en TypeScript, avec un framework d'interface léger à choisir (React, Svelte ou équivalent). Installable comme PWA.
- **Prétraitement d'image.** Vision par ordinateur dans le navigateur : OpenCV compilé en WebAssembly (OpenCV.js) ou traitement Canvas pour la détection des bords, le redressement et la binarisation. Exécution dans un Web Worker.
- **OMR.** Base retenue : MusicOCR, application web open source qui fait déjà photo, MusicXML et MIDI dans le navigateur. Son moteur est un portage JavaScript de copisteria (licence Apache-2.0) : un détecteur de symboles, une analyse géométrique des portées, un petit transformeur de contexte, puis un écrivain qui produit le MusicXML. Les trois réseaux tournent dans ONNX Runtime Web (WebGPU si disponible, sinon WebAssembly) dans un Web Worker. Deux tailles de modèle : copista-2m par défaut (environ 16 Mo) et copista-28m en option (environ 124 Mo). Repli écarté de la version 1 : homr-rs (AGPL-3.0, environ 157 Mo de modèles, lent sur iPhone), réévalué seulement si le banc d'essai montre que copista n'atteint pas les seuils d'exactitude. La sortie normalisée est un MusicXML interne.
- **Génération MIDI.** Un module d'écriture MIDI propre à l'application convertit le MusicXML interne en fichier MIDI de type 1, avec une piste et un changement de programme (instrument) par portée, et écrit tempo, métrique et armure. Ce choix est ferme : la documentation de Verovio ne décrit aucun choix d'instrument MIDI, et la présence d'un programme par piste dans sa sortie n'a pas pu être vérifiée. Verovio (WebAssembly, déjà intégré à MusicOCR) reste utilisé pour l'affichage de la partition lue. Encodage de la sortie audio : le WAV s'écrit directement à partir du rendu hors ligne (en-tête WAV et échantillons PCM 16 bits). Le MP3 passe par l'encodeur retenu, @mediabunny/mp3-encoder, car les navigateurs n'encodent pas le MP3 nativement. C'est une extension de la bibliothèque Mediabunny (licence MPL-2.0) qui embarque une compilation WebAssembly de LAME (LGPL). Choisi sur la mise à jour récente, l'adoption et la fiabilité, contre lamejs et mp3-lame-encoder-js. Mediabunny sert aussi à produire le fichier audio et à enregistrer l'encodeur seulement si le navigateur ne sait pas encoder le MP3. L'encodage tourne dans un Web Worker.
- **Synthèse audio.** Synthétiseur SoundFont (SF2) exécuté dans le navigateur, soit en WebAssembly (type FluidSynth compilé), soit via un lecteur JavaScript de SoundFont, avec Web Audio API pour la lecture et AudioWorklet pour le traitement. Le rendu en fichier utilise un contexte audio hors ligne (OfflineAudioContext). Une banque légère couvre le catalogue minimal ; des banques de meilleure qualité sont téléchargeables à la demande.
- **Stockage.** IndexedDB pour les projets, les images et les banques de sons ; Cache Storage via le Service Worker pour le code et les modèles. Quota variable selon le navigateur : l'application affiche l'espace utilisé.
- **Modules.** Capture, prétraitement, OMR, correction, MIDI, rendu audio, export. Chaque module expose une interface claire pour être testé seul ; les modules lourds (prétraitement, OMR, synthèse) tournent dans des Web Workers.
- **Licence.** L'application est publiée en open source. Les composants de base sont permissifs : MusicOCR (MIT), copisteria et ses poids (Apache-2.0), ONNX Runtime Web (MIT), Verovio (LGPL-3.0), Mediabunny (MPL-2.0) avec LAME (LGPL). L'auteur accepte de publier le code source. Licence recommandée pour l'application : MIT ou Apache-2.0, à confirmer ; elle doit rester compatible avec chaque composant et conserver les mentions de droits d'auteur. homr-rs (AGPL-3.0) est exclu de la version 1 ; l'ajouter imposerait l'AGPL-3.0 à l'ensemble.

## 8. Modèle de données (résumé)

- **Projet** : pages (images), partition reconnue, réglages de rendu.
- **Partition** : liste de portées ; chaque portée contient des mesures ; chaque mesure contient des événements (note, silence, altération).
- **Portée** : clé, étendue, instrument assigné, volume, panoramique, état muet ou solo.
- **Préréglage d'instruments** : nom et liste d'assignations.

## 9. Écrans principaux

1. Accueil et liste des projets.
2. Capture par la caméra du navigateur, avec guide de cadrage et demande d'autorisation.
3. Recadrage et qualité de l'image.
4. Résultat de la reconnaissance et correction.
5. Lecture MIDI et export.
6. Rendu audio : une ligne par portée avec sélecteur d'instrument (au moins quatre choix), volume, panoramique, muet, solo.
7. Export audio et partage : choix du format (WAV ou MP3), du débit MP3, mélange complet ou pistes séparées, estimation de la taille, téléchargement.

## 10. Critères d'acceptation

- Une partition imprimée d'une page, bien éclairée, produit un MIDI lisible en moins de 15 secondes.
- Chaque portée détectée dispose d'un sélecteur proposant au moins quatre instruments.
- Changer l'instrument d'une portée ne modifie pas les autres portées.
- Le MIDI exporté contient une piste par portée, avec le programme MIDI de l'instrument choisi. Le WAV exporté reflète exactement les instruments, volumes et panoramiques choisis.
- Les stems exportés correspondent un pour un aux portées.
- Les mesures douteuses sont signalées et corrigeables avant export.
- Le WAV et le MP3 exportés sont lisibles dans un lecteur courant, avec le même contenu musical, les mêmes instruments, volumes et panoramiques.
- Le sélecteur de format propose WAV et MP3 ; le fichier produit porte l'extension correspondante et sa taille est proche de l'estimation affichée.

## 11. Risques et points ouverts

- **Qualité de l'OMR.** C'est le principal risque : les partitions denses, les photos obliques ou les polyphonies complexes dégradent la reconnaissance. Mitigation : correction guidée et mesure de confiance.
- **Licences.** Le socle MusicOCR est permissif, sans obligation de publication. Les banques de sons et les bibliothèques de synthèse ont des licences variables ; à vérifier avant de les embarquer, en choisissant des banques dont la licence autorise la redistribution. Le dépôt de MusicOCR n'a pas de fichier de licence à la racine, seulement une mention MIT dans son README : à faire clarifier auprès de l'auteur avant tout fork. La revue de MusicOCR affirme que les poids de homr héritent de données non commerciales ; non vérifié, à contrôler avant d'embarquer homr.
- **Voix chantée.** Le rendu vocal réaliste est limité avec des échantillons ; la version 1 se contente de voix « aah ».
- **Poids du téléchargement.** Avec copista-2m, les modèles pèsent environ 16 Mo ; le modèle précis copista-28m, environ 124 Mo, et les banques d'échantillons s'y ajoutent. Prévoir un chargement à la demande, une barre de progression, une reprise après coupure et la mise en cache. Avec homr-rs, les modèles pèseraient environ 157 Mo.
- **Manuscrit.** Reporté à la version 2, car la reconnaissance est nettement moins fiable.
- **Encodage MP3.** Les navigateurs ne proposent pas d'encodeur MP3 natif : l'encodeur retenu (@mediabunny/mp3-encoder, licence MPL-2.0, avec LAME sous LGPL en WebAssembly) alourdit l'application. Obligations à respecter : mentionner LAME avec un lien vers son site, et garder l'encodeur comme bibliothèque séparée et remplaçable. Mitigation : chargement de l'encodeur à la demande, au premier export MP3 seulement, et WAV disponible en permanence comme repli. Point à vérifier : le poids exact du module et son comportement sur iPhone.
- **Points non vérifiés à la rédaction.** Le MIDI de Verovio (pistes et programmes) n'a pas pu être testé faute d'accès à Internet dans l'environnement de travail ; le choix d'un module MIDI propre rend ce test sans conséquence sur l'architecture. Les chiffres sur l'encodeur MP3 (mise à jour, adoption) viennent d'extraits de recherche, sans ouverture des pages sources. Aucune mesure sur téléphone n'existe pour MusicOCR : la vitesse sur Android et iPhone est une hypothèse à mesurer.
- **Jeunesse du moteur.** copisteria date d'octobre 2026 et MusicOCR est un dépôt récent ; l'exactitude mesurée repose sur trois pages d'une seule pièce, avec un filtre contre les doigtés réglé sur ces pages. Mitigation : banc d'essai sur vos partitions avant de figer le moteur, et comparaison avec homr-rs.
- **Contraintes du navigateur.** La caméra et le Service Worker exigent HTTPS. Le quota de stockage varie selon les navigateurs, et Safari sur iOS est plus restrictif. La mémoire disponible limite la taille des images et des modèles sur mobile. Mitigation : réduction de résolution, traitement page par page, tests sur navigateurs et appareils cibles.

**Questions à trancher.** Décisions prises : traitement strictement local, sans service distant ; fork de MusicOCR, en reprenant de Partsong la reprise après interruption, la gestion de la mémoire sur iPhone et le mode hors ligne ; module MIDI propre ; encodeur MP3 @mediabunny/mp3-encoder. Restent à trancher par vous : navigateurs et appareils cibles prioritaires, et licence finale de l'application (MIT ou Apache-2.0 recommandées). Restent à mesurer : l'exactitude de copista-2m et de copista-28m sur vos partitions réelles, les temps et la mémoire sur Android et iPhone, le poids du module MP3.

## 12. Feuille de route

- **Phase 1 — Prototype.** Fork de MusicOCR après clarification de sa licence ; banc d'essai sur 10 à 20 de vos partitions (exactitude des hauteurs et du rythme, temps et mémoire sur ordinateur, Android et iPhone), décrit dans l'onglet « Banc d'essai ». Décision de garder copista-2m ou de réévaluer homr-rs selon les seuils.
- **Phase 2 — Multiportée et correction.** Systèmes à plusieurs portées, interface de correction.
- **Phase 3 — Rendu audio.** Module d'écriture MIDI (une piste et un programme par portée), synthétiseur SoundFont, catalogue d'au moins quatre instruments par portée, pré-écoute, réglages par portée, export WAV, MP3 et pistes séparées.
- **Phase 4 — Finitions.** Préréglages, stems, mode hors ligne (PWA), accessibilité, performances, tests sur navigateurs, tests utilisateurs.
- **Version 2.** Partitions manuscrites, voix chantée, paroles.
