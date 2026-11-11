# Plan du banc d'essai

Ce banc d'essai mesure, sur 10 à 20 de vos partitions, si copista-2m atteint les seuils d'exactitude, et valide les chaînes MIDI et audio. Il tranche trois questions : l'exactitude de copista-2m et de copista-28m, la tenue sur ordinateur, Android et iPhone, et la qualité de notre module MIDI et de la sortie audio. homr-rs n'est comparé que si copista-2m échoue aux seuils.

## 1. Corpus de test

On rassemble 10 à 20 pages que vous connaissez bien, en évitant un corpus d'une seule pièce comme celui de l'auteur de MusicOCR.

- **Variété.** Piano à deux portées, voix seule, chœur à quatre voix, quatuor à cordes, partition à une portée. Au moins trois éditeurs ou éditions différents.
- **Qualité de prise de vue.** Pour 5 pages au moins, deux versions : un scan ou un PDF propre, et une photo de téléphone prise normalement, page légèrement courbée.
- **Cas difficiles.** Au moins 2 pages avec doigtés ou annotations au crayon, 2 pages denses, 1 page avec reprises, 1 page avec clé d'ut ou de fa.
- **Vérité terrain.** Pour chaque page, une référence fiable : un fichier MusicXML ou MIDI de la même édition, ou une saisie manuelle des 8 premières mesures. Pages sans référence : lecture à l'oreille et à l'œil, notée à part.
- **Droits.** Utiliser des partitions du domaine public ou personnelles, sans les diffuser avec le dépôt.

## 2. Moteurs comparés

| Moteur | Rôle | Modèles | Licence |
| --- | --- | --- | --- |
| MusicOCR avec copista-2m | Candidat principal | environ 16 Mo | MIT, Apache-2.0 |
| MusicOCR avec copista-28m | Option précision | environ 124 Mo | MIT, Apache-2.0 |
| Partsong avec homr-rs | Repli conditionnel, seulement si copista-2m échoue | environ 157 Mo | AGPL-3.0 |

Chaque page passe dans les trois moteurs, avec les mêmes images, sans réglage propre à une page. Toute règle ajoutée doit s'appuyer sur un fait général de notation, comme le fait déjà MusicOCR.

## 3. Mesures d'exactitude

On reprend le banc d'évaluation fourni avec MusicOCR (`scripts/eval/score.mjs`, lecteur MIDI et comparaison de MusicXML), pour comparer des chiffres produits par le même outil.

- **F1 sur les hauteurs.** Part de notes correctes, par page et par main ou portée.
- **F1 sur hauteurs et rythme.** Même mesure, en comptant la durée.
- **Distance d'édition normalisée.** Nombre de corrections à faire, rapporté à la taille de la page.
- **Erreurs par catégorie.** Clé et armure, altérations, durées, silences, notes en trop ou manquantes, mesures sautées. On les note à la main sur 5 pages pour savoir quoi corriger en priorité.

Seuils d'acceptation pour le moteur retenu : F1 hauteurs d'au moins 95 % et F1 hauteurs et rythme d'au moins 80 % sur chaque page de test, hors cas difficiles qui sont reportés à part. Ces seuils reprennent la cible de la spécification ; ils sont à confirmer avec vous.

## 4. Vitesse, mémoire et appareils

Aucune mesure sur téléphone n'existe pour MusicOCR. On la produit.

| Appareil | Navigateur | À relever |
| --- | --- | --- |
| Ordinateur récent | Chrome et Firefox | temps par page, mémoire |
| Téléphone Android | Chrome | temps par page, mémoire, chaleur |
| iPhone | Safari | temps par page, mémoire, plantages |

- Relever deux temps : premier lancement (téléchargement des modèles compris) et lancement suivant (modèles en cache).
- Tester avec et sans WebGPU, car Partsong a dû désactiver WebGPU sur iPhone pour la segmentation, à cause de la mémoire.
- Noter les échecs : page non lue, onglet rechargé par le navigateur, message d'erreur.
- Cible de la spécification : moins de 15 secondes par page ; à confirmer par la mesure.

## 5. Test du MIDI et du rendu par portée

C'est le point qui conditionne votre besoin de timbres par portée.

1. Générer le MIDI par notre module pour un piano, un quatuor et un chœur.
2. Ouvrir le fichier et compter les pistes : une par portée, chacune avec son programme MIDI.
3. Vérifier que l'instrument de chaque piste peut être changé (numéro de programme MIDI).
4. Vérifier la lecture des reprises, du tempo écrit et des nuances.
5. Comparer le fichier à l'original sur les reprises, le tempo et les nuances, et noter les écarts à corriger dans le module.

On teste aussi un synthétiseur SoundFont dans le navigateur avec quatre timbres sur quatre portées : temps de rendu d'une pièce de trois minutes, poids de la banque de sons, licence de la banque. Pour la sortie audio, on exporte la même pièce en WAV et en MP3 (128, 192 et 256 kbit/s) avec @mediabunny/mp3-encoder, et on relève, sur ordinateur, Android et iPhone : le temps d'encodage, la taille du fichier, le poids du module, et la lecture correcte du fichier dans un lecteur courant. On vérifie aussi que l'encodeur ne s'enregistre que si le navigateur ne sait pas encoder le MP3.

## 6. Vérifications juridiques

- **Licence de MusicOCR.** Aucun fichier de licence à la racine du dépôt, seulement une mention MIT. Demander à l'auteur d'en ajouter un avant le fork.
- **Poids de homr.** La revue de MusicOCR affirme qu'ils héritent de données non commerciales. À vérifier dans le dépôt de homr avant tout usage de homr-rs.
- **Banques de sons.** Choisir des banques dont la licence autorise la redistribution dans une application publiée.

## 7. Calendrier et livrables

| Étape | Contenu | Livrable |
| --- | --- | --- |
| 1 | Constituer le corpus et la vérité terrain | Dossier de pages et références |
| 2 | Lancer les trois moteurs sur ordinateur | Tableau d'exactitude par page |
| 3 | Mesurer Android et iPhone | Tableau temps et mémoire |
| 4 | Tester notre module MIDI et un synthétiseur SoundFont | Note de faisabilité |
| 5 | Décision | Moteur retenu, ou plan B, avec les chiffres |

Le calendrier est à fixer avec vous. Un volume de 10 à 20 pages se traite en quelques jours de travail, hors constitution de la vérité terrain, qui dépend de vous.

## 8. Critères de décision

Ponderation proposée, à ajuster avec vous.

| Critère | Poids | Mesure |
| --- | --- | --- |
| Exactitude hauteurs et rythme | 35 % | F1 sur le corpus |
| Robustesse sur photos et iPhone | 25 % | pages lues sans échec |
| Vitesse et poids | 20 % | secondes par page, mégaoctets |
| MIDI par portée | 10 % | pistes séparées et instrument modifiable |
| Licence | 10 % | obligations de publication |

Règle : si copista-2m atteint les seuils, on le garde pour sa légèreté. Si seul copista-28m ou homr-rs les atteint, on l'ajoute en option sur demande, et on l'écarte du chemin par défaut s'il est trop lent sur téléphone.
