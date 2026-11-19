# MoneyManager

Application web installable sur téléphone (PWA) pour réduire la charge mentale du budget :

- **Mois** — saisie manuelle des revenus et dépenses, marquées *fixes* (récurrentes) ou *variables*.
  Un bouton reprend en un geste les lignes fixes du mois précédent. Solde, taux d'épargne, répartition par catégorie.
- **Bilan** — 12 derniers mois en graphique + tableau, moyennes sur 6 mois (revenus, charges fixes / variables,
  épargne, « reste à vivre »), dépenses moyennes par catégorie. Filtre de catégories (n'en afficher qu'une, ou en
  retirer plusieurs). Toucher une catégorie ouvre toutes ses dépenses de l'année (total, moyenne, graphique par mois,
  détail des opérations, navigation d'une année à l'autre).
- **Prédiction du mois en cours et du mois suivant** (onglet Mois) — revenus et dépenses prévus :
  lignes fixes au dernier montant connu, lignes variables en moyenne pondérée sur 6 mois (les mois récents comptent
  davantage), + charges programmées. Les 6 mois de référence s'arrêtent avant le mois précédent, ignoré car
  il peut être incomplet. Pour le mois en cours : réalisé vs prévu, solde estimé en fin de mois et charges
  fixes pas encore passées. Les catégories de dépenses et de revenus à ignorer se règlent dans Réglages › Prédictions
  (« Virement depuis épargne », pour le Livret A, est ignorée par défaut).
- **Prévisions** — projection sur 12 mois = moyenne des 6 derniers mois saisis + charges programmées
  (régularisation d'impôt, taxe foncière, assurance annuelle…, ponctuelles ou répétées).
  Calcule aussi le montant à mettre de côté chaque mois pour couvrir ces échéances.
- **Impôts** — comparaison abattement 10 % / frais réels (barème kilométrique, repas, télétravail, autres frais),
  impôt estimé (quotient familial et son plafonnement, décote), taux de prélèvement à la source adapté,
  régularisation attendue — qu'on peut ajouter d'un clic aux prévisions.
- **Import de relevés BNP Paribas (PDF)** — depuis l'onglet Mois : les opérations sont extraites du relevé,
  vérifiées avec le « Total des opérations », pré-catégorisées (les prélèvements marqués fixes, les virements
  entre vos propres comptes exclus), puis vous validez. Vos corrections sont retenues pour les imports suivants
  et les opérations déjà importées sont ignorées. **Le PDF est lu dans le navigateur et n'est jamais envoyé.**
- **Réglages** — thème, export / import JSON, données d'exemple.

Aucune API, aucun serveur : les données restent dans le navigateur du téléphone (`localStorage`).
**Pensez à exporter régulièrement** (Réglages › Exporter).

## Mise en ligne (GitHub Pages, gratuit)

1. Fusionner ce code sur la branche `main`.
2. Sur GitHub : *Settings › Pages › Build and deployment › Source : Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. Ouvrir `https://<utilisateur>.github.io/MoneyManager/` sur le téléphone, puis :
   - iPhone (Safari) : Partager › *Sur l'écran d'accueil* ;
   - Android (Chrome) : ⋮ › *Installer l'application*.

L'application fonctionne ensuite hors connexion.

## Développement

```bash
npm start   # http://localhost:8000
npm test    # tests du moteur de calcul (Node ≥ 18)
```

- `js/calc.js` : calculs purs (bilan, prévisions, impôt) — testés dans `tests/`.
- `js/bnp-import.js` : lecture et analyse des relevés BNP Paribas — testé sur un relevé fictif dans `tests/`.
- `js/vendor/pdfjs/` : [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38 (Apache-2.0), embarqué pour fonctionner hors connexion.
- `js/app.js` : interface (vanilla JS, sans dépendance ni build).

### Publier une nouvelle version

Incrémentez `APP_VERSION` (et `APP_VERSION_DATE`) dans `js/version.js` à chaque mise en ligne :
le numéro s'affiche dans Réglages, qui indique aussi si une version plus récente est disponible,
et le changement force les téléphones à renouveler le cache hors connexion.

> Ne versionnez jamais de relevé réel : `*.pdf` est exclu par `.gitignore`.

## Paramètres fiscaux

Valeurs par défaut : barème 2025 appliqué aux revenus 2024 (tranches, abattement 10 % min/max, décote,
plafond du quotient familial, barème kilométrique). Ils sont **modifiables dans l'onglet Impôts** —
à mettre à jour chaque année avec les chiffres officiels d'impots.gouv.fr. La simulation reste une estimation
(revenus salariaux principalement ; pas de réductions/crédits d'impôt ni de revenus de capitaux au PFU).
