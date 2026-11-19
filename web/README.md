# freetime web et PWA

La version PC utilise Tauri. La version web utilise la même interface et un serveur Rust qui réutilise `freetime-core` pour les recommandations, l’historique, les quiz et le carnet. Le serveur web traite les données envoyées par chaque navigateur. Les commandes Tauri de lecture des fichiers du PC, de lancement de programmes et d’installation des mises à jour restent dans l’application PC.

## Lancer les essais

Depuis la racine du dépôt, avec Node.js et Rust installés, exécuter les commandes suivantes.

```powershell
npm.cmd --prefix web ci
npm.cmd --prefix web run dev
```

Ouvrir `http://127.0.0.1:4173` sur le PC. Le premier lancement propose l’accueil. Les préférences et l’historique sont conservés dans le navigateur.

Pour un essai sur le même réseau Wi-Fi, démarrer le serveur en écoutant sur les interfaces réseau.

```powershell
$env:FREETIME_WEB_BIND = '0.0.0.0:4173'
npm.cmd --prefix web run dev
```

Sur le téléphone, ouvrir `http://<adresse-IP-locale-du-PC>:4173`. Le pare-feu Windows doit autoriser cette connexion sur le réseau privé. Le PC et le serveur doivent rester allumés pendant les essais.

Pour tester l’installation PWA et la connexion Google sur téléphone, utiliser une adresse HTTPS qui pointe vers ce serveur. Le manifeste, les icônes, le service worker et le cache de l’interface sont fournis. L’interface installée affiche une page de reconnexion lorsque le réseau ou le serveur est indisponible. Le moteur de recommandations reste exécuté sur le serveur.

## Comptes et données

La connexion Google utilise Supabase Auth avec PKCE. Ajouter l’URL HTTPS de test suivie de `/auth/callback` aux URL de redirection autorisées du projet Supabase. En développement sur le PC, ajouter `http://127.0.0.1:4173/auth/callback`. Ces URL se configurent dans Authentication → URL Configuration.

La clé Supabase publiée par `/api/config` est la clé publique déjà distribuée avec l’application PC. Les opérations de compte utilisent le jeton d’accès du navigateur. Le serveur vérifie ce jeton auprès de Supabase Auth et réutilise les opérations protégées par les règles RLS existantes.

Les profils, amis, messages, disponibilités et invitations utilisent le même projet Supabase que la version PC. L’historique, les quiz, les préférences et les imports Steam restent propres à chaque navigateur. La section des données permet d’exporter ces données locales. Les clés API personnelles sont conservées dans `sessionStorage` pendant la session de l’onglet et sont exclues de cet export.

Sur le web, l’import Steam utilise le profil public et une clé Web API fournie dans les réglages. Les liens Steam peuvent être ouverts par un appareil disposant de Steam. Les vidéos, la météo, le magasin Steam et les jeux Epic utilisent leurs sources en ligne habituelles.

## Vérifier les changements

```powershell
cargo test -p freetime-core --locked
cargo test -p freetime-web --locked
npm.cmd --prefix web run build
```

Le dossier `web/dist` est généré par la compilation du module de connexion et du cache PWA. Relancer le build après une modification des fichiers de l’interface pour renouveler la version du cache.
