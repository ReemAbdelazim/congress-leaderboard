# Seeds Congress Leaderboard

A live leaderboard for Seeds Congress 2026. Anyone with the link sees the standings update in real time; signed-in organisers add groups and change scores.

- **Hosting:** GitHub Pages (free)
- **Live database:** Firebase Cloud Firestore, free Spark plan (50,000 reads and 20,000 writes per day)
- **Organiser sign-in:** Firebase Authentication (Google, or email and password)

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `styles.css` | Congress 2026 branding |
| `app.js` | Leaderboard, admin tools and live sync |
| `firebase-config.js` | **You paste your Firebase settings here** |
| `firestore.rules` | Who can read and write (paste into Firebase) |

## 1. Create the Firebase project (about 10 minutes)

1. Go to <https://console.firebase.google.com> → **Add project**. Name it (for example `seeds-congress-leaderboard`). Google Analytics is optional.
2. **Build → Firestore Database → Create database**. Pick a location near you (for example `northamerica-northeast1`, Montréal) and start in **production mode**.
3. On the **Rules** tab, replace everything with the contents of `firestore.rules` and click **Publish**.
4. **Build → Authentication → Get started → Sign-in method**. Turn on **Google**, and optionally **Email/Password**.
5. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register an app (no hosting needed) and copy the `firebaseConfig` values into `firebase-config.js`.

## 2. Publish on GitHub Pages

1. Create a new repository on GitHub (for example `congress-leaderboard`) and push these files to it.
2. Repository **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → **Save**.
3. After a minute the site is live at `https://<your-username>.github.io/congress-leaderboard/`.
4. In Firebase, go to **Authentication → Settings → Authorized domains → Add domain** and add `<your-username>.github.io`. Without this step Google sign-in is refused.

## 3. Make yourself (and others) organisers

1. Open the site and click **Organiser sign in** at the bottom (or add `#admin` to the address).
2. Sign in. The page shows your **account ID**. Copy it.
3. In Firebase go to **Firestore → Start collection**. Enter `admins` as the collection ID and paste the account ID as the document ID. Add any field (for example `name` = `Aya`) and save.
4. Click **Check again** on the site. The Admin tab appears.

Repeat step 3 for every organiser. To remove someone, delete their document in `admins`.

## Using it

- **Public view:** the podium shows the top 3 and the list shows everyone else with rank and points. Tied groups share a rank. Use **Full screen** for a projector.
- **Admin view:** add groups; change scores with quick buttons, a custom amount or an exact score; rename, recolour or delete groups; edit the title; **hide scores for the reveal**; reset everything.
- Score changes are atomic increments, so two organisers tapping at the same time never lose points.

## Limits on the free plan

Each score change costs one read for every open screen. For example, 300 screens × 150 changes = 45,000 reads, just under the daily limit. For a bigger event, switch Firebase to the pay-as-you-go Blaze plan (cents per day at this scale) or use fewer, larger changes.
