# China PO approval and FA tracker (web version)

The same tracker the team used in Claude, running on Render so the China team can use it.
Each person signs in with their own username and password. Approvals, comments, FA status,
new vendors, uploads and team chat are saved in a Postgres database and update live for everyone.

Please confirm with IT (Shane) that Render and this sign-in approach are approved before loading real PO data.

---

## Part 1. Put the code on GitHub

Use GitHub Desktop: Repository > Show in Explorer, copy all files from this folder into the repository folder,
then Commit to main and Push origin. Keep the repository **Private**.

Do **not** put `claude-data-export.json` in the repository. It contains purchasing data. You load it through the website in Part 4.

## Part 2. Create the site on Render

1. In Render: **New** > **Blueprint** > pick the repository > **Connect**.
2. Render shows the database `china-po-db` and the web service `china-po-tracker`. Fill in:
   - `BASE_URL`: the web address, for example `https://china-po-tracker.onrender.com` (https, no slash at the end).
     If you don't know it yet, leave `pending`; the site uses its Render address automatically.
   - `ADMIN_USERNAME`: your username, lowercase, for example `yuping`.
   - `ADMIN_PASSWORD`: a temporary password, at least 10 characters. You must change it the first time you sign in.
3. Click **Apply** and wait until the service shows **Live**.

`SESSION_SECRET` and `DATABASE_URL` are filled in automatically.

## Part 3. First sign-in

1. Open the web address. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Choose your own password when asked.
3. Optional but recommended: in Render, open the service > **Settings** > **Environment**, delete the `ADMIN_PASSWORD` value (or replace it with a long random value), and save. It is only used to create the very first admin.

## Part 4. Add the team

1. In the tracker, click **Manage people** (top right).
2. For each person enter their name (first name first, for example "Christine Lee") and a username (for example `christine`). Click **Add person**.
3. The tracker shows a **temporary password** once. Copy it and send it to that person privately (Teams chat or in person, not a group email), together with the web address and their username.
4. They sign in and must choose their own password.

Tips:
- Use first names that match the team list (Trusty, Rosie, Wendy, Christine, Yuping, Keria, Damita) so names fill in automatically on comments and chat.
- **Reset password** makes a new temporary password and signs that person out.
- **Turn off** removes someone's access right away (for example when they leave). Their past approvals and comments stay.
- **Make admin** lets another person manage people and import data. Having two admins means someone can help if you are away.

## Part 5. Launch day

1. Click **Import data** (top right, admins only) and load `claude-data-export.json`. This brings over comments, chat, FA status and the last PO upload from the Claude version.
2. Upload the latest **Vendor-Buyer-Quality** list in Step 1 and the latest **CSI future PO** sheet in Step 2.
3. Once Christine and Yuping have accounts, open **Data and settings** > **Rules and approvers**, search for each of them, and click **Save rules**. From then on only Christine can approve in her slot and only Yuping in hers. The server enforces this.
4. Share the web address with the team.

## Security built in

- Passwords are stored hashed (scrypt), never as plain text. Nobody, including admins, can see a password.
- 5 wrong passwords pause that account for 15 minutes. Many attempts from one place are slowed down too.
- Everyone must replace their temporary password on first sign-in. Minimum 10 characters.
- Sessions last 14 days of inactivity. **Sign out** is in the top right.
- People can delete only their own comments and chat messages. Admins can delete any.

## If you get locked out

- Forgot your password? Another admin can click **Reset password** for you in Manage people.
- No other admin available? In Render, open the service > **Settings** > **Environment** and set:
  `ADMIN_USERNAME` = your username, `ADMIN_PASSWORD` = a new temporary password (10+ characters), and add `ADMIN_RESET` = `yes`.
  Save, wait for the redeploy, sign in with the temporary password and choose a new one.
  Then **delete `ADMIN_RESET`** and save again, so it doesn't reset on every deploy.

## Changing things later

- Replace a file in GitHub Desktop, Commit and Push. Render redeploys automatically in about 2 minutes. Data is not affected.
- Fonts: see `public/fonts/README.txt` (optional).
- Team name list: edit `const TEAM = [...]` near the top of the script in `public/index.html`.

## What is in this repository

- `server.js`: the website, sign-in, database, live updates and approval rules.
- `public/index.html`: the tracker page. `public/claude-shim.js` connects it to the server.
- `views/admin-users.*`: the Manage people page (admins only).
- `render.yaml`: tells Render to create the database and web service.
