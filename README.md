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

1. Open the site and click **Organiser & volunteer sign in** at the bottom (or add `#admin` to the address), then choose **Organiser**.
2. Sign in. The page shows your **account ID**. Copy it.
3. In Firebase go to **Firestore → Start collection**. Enter `admins` as the collection ID and paste the account ID as the document ID. Add any field (for example `name` = `Aya`) and save.
4. Click **Check again** on the site. The Admin tab appears.

Repeat step 3 for every organiser. To remove someone, delete their document in `admins`.

### Hub volunteers

Volunteers can only record hub activity: pick a team, choose the station and enter how many delegates took part. They can see each team's delegation size and the change log, but can't add teams, give bonus or fundraiser points, rename, recolour, change delegation sizes, change settings or reset anything. The Firestore rules enforce this, so it can't be bypassed from the browser.

1. The volunteer opens the site, clicks **Organiser & volunteer sign in**, chooses **Volunteer** and signs in. The page shows their account ID and which collection to add it to; **Copy access request** copies a ready-to-send message.
2. In Firebase go to **Firestore → Start collection** (or open it if it exists). Collection ID `volunteers`, document ID = their account ID, field `name` = their name. Save.
3. They click **Check again**. A **Hub points** tab appears.

Every entry in **Recent changes** shows who made it (the `name` field from `admins` or `volunteers`). The list keeps the latest 500 changes and scrolls.

## Using it

- **Public view:** the podium shows the top 3 and the list shows everyone else with rank and points. Tied groups share a rank. Use **Full screen** for a projector.
- **Admin view:** search teams; add points by type; set each team's delegation size; rename, recolour or delete groups; set the number of hub stations; edit the title; **hide scores for the reveal**; reset everything.
- Score changes are atomic increments, so two organisers tapping at the same time never lose points.

## Point types

Organisers pick the type before entering points:

| Type | What you enter | Points |
| --- | --- | --- |
| **Bonus** | A number of points | Added as entered (negative numbers take points away) |
| **Hub activity** | Station + how many delegates took part | participants ÷ delegation size × (1000 ÷ stations). With 8 stations a full team earns 125 per station and 1,000 for all 8. Re-recording a station replaces its earlier entry. |
| **Fundraiser** | Total % raised so far | 1,000 × %. Only the change is awarded: 20% gives 200, then updating to 45% adds 250. Going past 100% keeps earning: 150% = 1,500. |

Changing a team's delegation size, or the number of stations (Stations tab), recalculates hub points automatically.

## Limits on the free plan

Each score change costs one read for every open screen. For example, 300 screens × 150 changes = 45,000 reads, just under the daily limit. For a bigger event, switch Firebase to the pay-as-you-go Blaze plan (cents per day at this scale) or use fewer, larger changes.
