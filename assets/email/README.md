# Email templates — Kairos Insider

Templates HTML pour les emails transactionnels. 2 sources de vérité :

1. **Worker inline** (`worker/src/index.js > buildWelcomeEmail`, `buildFounderLetter`) —
   ce qui est envoyé en prod via l'API Brevo.
2. **Fichiers `.html` ici** — versions standalone pour preview navigateur,
   ou pour paste dans le composer Brevo si tu préfères envoyer via le
   dashboard plutôt que via l'API.

## Fichiers

| Fichier | Quand | Lang |
|---|---|---|
| `founder-letter-fr.html` | J+5 après signup (manuel pour les 5 actuels, auto via Brevo workflow ensuite) | FR |
| `founder-letter-en.html` | idem | EN |

---

## 📬 Envoi manuel du Founder Letter (mardi 20 mai)

### Méthode 1 — Via l'API worker (recommandée, rapide)

```bash
# Preview FR (browser-visible)
curl "https://kairos-insider-api.natquinson.workers.dev/api/admin/founder-letter-preview?lang=fr" \
  -H "Authorization: Bearer $(firebase auth:print-access-token)" \
  | jq -r '.html' > /tmp/founder-fr-preview.html
open /tmp/founder-fr-preview.html  # macOS
start /tmp/founder-fr-preview.html # Windows

# Preview EN
curl "https://kairos-insider-api.natquinson.workers.dev/api/admin/founder-letter-preview?lang=en" \
  -H "Authorization: Bearer $(firebase auth:print-access-token)" \
  | jq -r '.html' > /tmp/founder-en-preview.html

# Envoi batch (4 inscrits actuels)
curl -X POST "https://kairos-insider-api.natquinson.workers.dev/api/admin/send-founder-letter" \
  -H "Authorization: Bearer $(firebase auth:print-access-token)" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "recipients": [
    {"email": "jorgentheboss@gmail.com",          "lang": "en"},
    {"email": "harryhollingworth@yahoo.co.uk",    "lang": "en"},
    {"email": "zmpablito+kairosinsider@gmail.com", "lang": "fr"},
    {"email": "olksmr@gmail.com",                  "lang": "fr"}
  ]
}
EOF
```

> ⚠️ **Avant d'envoyer** : check les stats Brevo `welcome-fr` vs `welcome-en`
> pour confirmer les langues présumées de chaque user. Ajuste le payload si
> mismatch.

### Méthode 2 — Via le dashboard Brevo (manuel, perso)

Si tu préfères personnaliser chaque envoi (ex : ajouter "Bonjour Harry,"
au début), ouvre `founder-letter-fr.html` ou `founder-letter-en.html` dans
le composer Brevo, customise, envoie une fois par user.

Avantage : personnalisation max + Brevo tracking par destinataire.
Inconvénient : 4× plus long.

---

## 🔄 Automation Brevo Workflow (futurs signups)

À configurer **une fois** dans le dashboard Brevo (`Automatisations > Workflows`) :

```
Trigger    : Contact created (= au moment du welcome via /send-welcome)
           : OR Contact attribute "LANG" changes
Delay      : 5 days
Condition  : if contact.LANG == "FR" → branche FR
             else                     → branche EN
Action     : Send transactional email "Founder Letter FR" (ou EN)
```

Pré-requis :

1. **Attribut LANG existe dans Brevo** (Contacts > Attributs > Add attribute
   "LANG", type Text). Si tu ne l'as pas créé, le `pushBrevoContactLang()`
   du worker échoue silencieusement.
2. **Templates Brevo créés** : tu dois copier le contenu de `buildFounderLetter()`
   du worker dans 2 templates Brevo (FR + EN) pour que le workflow les
   référence par ID.

Alternative no-template : le worker pourrait déclencher le send via cron
ScheduledEvent — moins flexible mais 100% code, pas de dépendance Brevo
workflow. À étudier si on veut multi-langues étendu (DE, IT, ES).

---

## 📊 Tags Brevo

Pour stats post-envoi (`Brevo > Statistiques > Filtrer par tag`) :

| Tag | Utilisation |
|---|---|
| `welcome` + `welcome-fr` / `welcome-en` | Email de bienvenue (auto au signup) |
| `founder-letter` + `founder-letter-fr` / `founder-letter-en` | Lettre du fondateur J+5 |
| `weekly-digest` + `weekly-digest-fr` / `weekly-digest-en` | (Future) Newsletter dimanche |
| `premium-welcome` + lang | Email après checkout Stripe |
