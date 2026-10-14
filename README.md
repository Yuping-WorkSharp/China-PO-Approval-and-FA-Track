# China PO approval and FA tracker (web version)

The same tracker the team used in Claude, running on Render so the China team can use it.
Everyone signs in with their Work Sharp Microsoft account. Approvals, comments, FA status,
new vendors, uploads and team chat are saved in a Postgres database and update live for everyone.

Before going live, confirm IT has approved Render as a vendor and the Microsoft sign-in setup in Part 2.

---

## Part 1. Put the code on GitHub (about 5 minutes)

1. In GitHub, click **New repository**. Name it `china-po-tracker` and choose **Private**. Click **Create repository**.
2. On the new repository page, click **uploading an existing file**.
3. Unzip `china-po-tracker-render.zip` on your computer. Drag **everything inside the folder** (not the folder itself) into the GitHub page:
   `server.js`, `package.json`, `render.yaml`, `README.md`, `.env.example`, `.gitignore`, and the `public` folder.
   Tip: files starting with a dot can be hidden on Mac. Press Cmd+Shift+. in Finder to show them.
4. Click **Commit changes**.

Do **not** upload `claude-data-export.json` to GitHub. It contains company purchasing data. You will load it through the website in Part 5.

## Part 2. Microsoft sign-in (IT admin, about 15 minutes)

Send this part to IT. They need a Microsoft Entra ID admin role.

1. Go to **entra.microsoft.com** > **Identity** > **Applications** > **App registrations** > **New registration**.
2. Name: `China PO Tracker`. Supported account types: **Accounts in this organizational directory only (single tenant)**.
3. Redirect URI: platform **Web**, value `https://YOUR-DOMAIN/auth/callback`
   (for example `https://po.worksharptools.com/auth/callback`). Click **Register**.
4. On the app's **Overview** page, copy:
   - **Application (client) ID**, which becomes `AZURE_CLIENT_ID`
   - **Directory (tenant) ID**, which becomes `AZURE_TENANT_ID`
5. Go to **Certificates & secrets** > **New client secret**. Choose 24 months. Copy the **Value** right away, which becomes `AZURE_CLIENT_SECRET`. Note the expiry date; the secret must be renewed before then.
6. Optional but recommended: in **Enterprise applications** > China PO Tracker > **Properties**, set **Assignment required** to Yes, then under **Users and groups** add only the people who should use the tracker.

The app only asks for the person's name and email (`openid profile email`). No admin consent or extra permissions are needed.

## Part 3. Create the site on Render (about 10 minutes)

1. In Render, click **New** > **Blueprint**. Connect GitHub if asked and pick the `china-po-tracker` repository.
2. Render reads `render.yaml` and shows two things to create: the database `china-po-db` and the web service `china-po-tracker`, both in the Singapore region (closest to the China team).
3. Render asks for these values:
   - `BASE_URL`: your web address with https and no slash at the end, for example `https://po.worksharptools.com`
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: from Part 2
   - `ADMIN_EMAILS`: your work email (comma-separate if more than one admin). Admins can use the one-time data import.
4. Click **Apply**. The first deploy takes a few minutes. When the service shows **Live**, continue.

## Part 4. Connect your domain (about 10 minutes, plus DNS wait)

1. In Render, open the `china-po-tracker` service > **Settings** > **Custom Domains** > **Add Custom Domain**. Enter the same address used in `BASE_URL`, for example `po.worksharptools.com`.
2. Render shows a DNS record to add (usually a **CNAME** pointing to `china-po-tracker.onrender.com`). Add it where your domain's DNS is managed.
3. Wait until Render shows the domain as **Verified** and the certificate as issued. This can take a few minutes up to an hour.
4. Open `https://YOUR-DOMAIN`. You should be sent to the Microsoft sign-in page, then into the tracker.

The tracker always redirects to `BASE_URL`, so everyone ends up on the same address.

## Part 5. Launch day

1. Sign in yourself first.
2. Click **Import data** in the top right (only shown to emails in `ADMIN_EMAILS`). Choose `claude-data-export.json` and click **Import**. This brings over the comments, team chat, FA status and the last PO upload from the Claude version.
3. Upload the latest **Vendor-Buyer-Quality** list in Step 1. This loads buyers and the New vendor list.
4. Upload the latest **CSI future PO** sheet in Step 2.
5. Ask Christine and Yuping to sign in once. Then open **Data and settings** > **Rules and approvers**, search for each of them, and click **Save rules**. From then on only Christine can approve in her slot and only Yuping in hers. This is enforced by the server, not just the page.
6. Share the web address with the team.

## Everyday use

- You upload new sheets from the US whenever MRP runs; the China team sees them immediately.
- Everyone else approves, comments, updates FA status and new vendors, and chats from wherever they are.
- Comment and chat names are filled in automatically from each person's Microsoft account when their first name matches the team list (Trusty, Rosie, Wendy, Christine, Yuping, Keria, Damita).
- People can delete only their own comments and chat messages. Admins can delete any.

## Changing things later

- Edit a file on GitHub (or upload a new version) and commit. Render redeploys automatically in about 2 minutes. Data in the database is not affected.
- To use the same Barlow font as the Claude version, follow `public/fonts/README.txt`. Without it, standard system fonts are used.
- To change the team name list, edit `const TEAM = [...]` near the top of the script in `public/index.html`.

## If something goes wrong

| What you see | What to check |
| --- | --- |
| Sign-in error mentioning redirect URI | The redirect URI in Part 2 must exactly match `BASE_URL` + `/auth/callback`. |
| "This account is not part of the Work Sharp organization" | The person signed in with a personal Microsoft account. Use the work account. |
| Page loads but says sync stopped | Render service may be restarting. Wait a minute and reload. Check **Logs** in Render. |
| "Only Christine can approve..." | Approver slots are assigned in Data and settings. That message means the slot belongs to someone else. |
| Everyone logged out after a while | Sessions last 14 days of inactivity, then sign in again. |
| Client secret expired | IT creates a new secret (Part 2 step 5) and you paste it into Render > Environment > `AZURE_CLIENT_SECRET`. |

## What is in this repository

- `server.js` runs the website: Microsoft sign-in, the database, live updates, and the rules for approvals and comments.
- `public/index.html` is the tracker page itself.
- `public/claude-shim.js` connects the page to the server (the page was first built inside Claude).
- `render.yaml` tells Render to create the database and web service.

Data is stored in the Render Postgres database `china-po-db`. Check the database's backup or recovery settings in Render to confirm what your plan includes, and use **Export CSV** in the tracker for an extra copy whenever you like.
