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

1. Go to **`https://<your-username>.github.io/congress-leaderboard/sign-in`** (the only way to sign in; the public page has no sign-in link) and choose **Organiser**.
2. Sign in. The page shows your **account ID**. Copy it.
3. In Firebase go to **Firestore → Start collection**. Enter `admins` as the collection ID and paste the account ID as the document ID. Add any field (for example `name` = `Aya`) and save.
4. Click **Check again** on the site. The Admin tab appears.

After signing in once, organisers and volunteers can use the normal address: their tabs appear automatically.

Repeat step 3 for every organiser. To remove someone, delete their document in `admins`.

### Hub volunteers

Volunteers can only record hub activity: pick a team, choose the station and enter how many delegates took part. They can see each team's delegation size and the change log, but can't add teams, give bonus or fundraiser points, rename, recolour, change delegation sizes, change settings or reset anything. The Firestore rules enforce this, so it can't be bypassed from the browser.

1. The volunteer goes to the **`/sign-in`** address, chooses **Volunteer** and signs in. The page shows their account ID and which collection to add it to; **Copy access request** copies a ready-to-send message.
2. In Firebase go to **Firestore → Start collection** (or open it if it exists). Collection ID `volunteers`, document ID = their account ID, field `name` = their name. Save.
3. They click **Check again**. A **Hub points** tab appears.

Every entry in **Recent changes** shows who made it (the `name` field from `admins` or `volunteers`). The list keeps the latest 500 changes and scrolls.

## Using it

- **Public view:** the podium shows the top 3 and the list shows everyone else with rank and points. Tied groups share a rank. Use **Full screen** for a projector.
- **Admin view:** search teams; add points by type; set each team's delegation size; rename, recolour or delete groups; set the number of hub stations; edit the title; **hide scores for the reveal**; reset everything.
- Score changes are atomic increments, so two organisers tapping at the same time never lose points.

## Delegates and CSV import

**Admin → Import delegates** takes a CSV with these columns (header names can vary; without a header row they're read in this order):

| first name | last name | delegation name | delegation number | fundraiser link |
| --- | --- | --- | --- | --- |

- Teams are matched by delegation number, then by name. New delegations become new teams.
- A preview shows what will happen before anything is saved. Rows with no name or no delegation are skipped and listed.
- Anyone already on a team's list is skipped, so importing an updated file again only adds the new people.
- Nothing is locked: organisers can add or remove delegates, change the delegation number and change the delegation size on each team (**Delegates** button).
- Delegation size follows the list (adding or removing a delegate moves it by one). If an organiser sets a different size by hand it is kept, and the team shows a "· N listed" warning with a one-click fix.
- Removing a delegate also takes them off any station they were ticked at.
- Delegate names and links are private to organisers and volunteers (Firestore rules); the public board never loads them.

**Hub check-in:** pick the station and tick who came. Points = ticked ÷ delegation size × (1000 ÷ stations). Re-saving a station replaces its earlier entry. Teams without a delegate list fall back to entering a number (organisers only).

**Fundraiser:** LaunchGood blocks automated reading of its pages, so the % can't be fetched automatically. Each team shows its LaunchGood campaign link (taken from the delegates' links, without the `?src=` part); open it, type **$ raised** and **$ goal**, and the % fills in.

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
