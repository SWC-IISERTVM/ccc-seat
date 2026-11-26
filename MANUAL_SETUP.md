# Manual Setup Guide: Computer Lab Break-Timer

This step-by-step checklist outlines all administrative tasks required to deploy the Computer Lab Break-Timer system.

---

## 1. Create Supabase Project
1. Navigate to [Supabase](https://supabase.com/) and create a new organization/project.
2. Note your **Project URL** and **anon public key** under **Project Settings > API**.
3. **DO NOT** copy or commit the `service_role` secret key. Only the `anon` key is used by client code.

---

## 2. Execute SQL Migrations in Supabase SQL Editor
Open the **SQL Editor** in your Supabase dashboard and execute the SQL files located in `/supabase/` strictly in the following sequential order:

1. `01_schema.sql` (Creates tables, crypto extension, constraints, and indexes)
2. `02_rls.sql` (Enables Row Level Security on all tables and defines read permissions)
3. `03_functions.sql` (Installs atomic RPC stored procedures with security definer search path)
4. `04_cron.sql` (Configures pg_cron cleanup jobs and adds public.computers to Realtime publication)
5. `05_seed.sql` (Populates default labs, 60 computers, and system settings)

---

## 3. Generate and Configure the HMAC Roll-Number Pepper
The secret pepper ensures that student roll numbers are transformed into protected HMAC-SHA256 digests. Raw roll numbers are never stored in the database.

### Step 3A: Generate a 64-character random hex string in your local terminal:
```bash
openssl rand -hex 32
```

### Step 3B: Set the pepper in Supabase SQL Editor:
Run this query replacing `PASTE_YOUR_64_CHAR_HEX_HERE` with the generated value:
```sql
UPDATE public.app_config
SET value = 'PASTE_YOUR_64_CHAR_HEX_HERE',
    updated_at = now()
WHERE key = 'roll_pepper';
```

---

## 4. Customize College Settings in `app_config`
Run the following SQL snippet in the SQL Editor to customize your college's roll number format and policy notices:

```sql
-- Set college roll number regex (e.g. 2 digits + 2-4 uppercase letters + 3-5 digits)
UPDATE public.app_config
SET value = '^[0-9]{2}[A-Z]{2,4}[0-9]{3,5}$',
    updated_at = now()
WHERE key = 'roll_regex';

-- Set lab belongings policy notice
UPDATE public.app_config
SET value = 'Unattended belongings may be cleared by staff after the 15-minute break period has expired.',
    updated_at = now()
WHERE key = 'belongings_policy';

-- Verify current configuration
SELECT key, value, description FROM public.app_config;
```

---

## 5. Enable Realtime & Verify `pg_cron`
1. Go to **Database > Replication** in Supabase.
2. Verify that the table `public.computers` is included in the `supabase_realtime` publication.
3. Go to **Database > Extensions** and confirm `pg_cron` is enabled.
4. Run this query in the SQL Editor to verify the scheduled jobs:
```sql
SELECT jobid, schedule, command, nodename, jobname FROM cron.job;
```

---

## 6. Configure Authentication & Create Staff Admin User
1. Go to **Authentication > Providers > Email**.
2. **Disable public sign-ups**: Under **User Signups**, switch toggle **"Allow new users to sign up" to OFF**.
3. Go to **Authentication > Users** and click **"Add user" > "Create user"**.
   - Enter admin email and a secure password.
   - Mark email as confirmed.
4. Copy the newly created user's **User UID** (UUID).
5. In the **SQL Editor**, link the Auth UID to the administrative table:
```sql
INSERT INTO public.admin_users (user_id, email)
VALUES ('PASTE_USER_UUID_HERE', 'admin@yourcollege.edu')
ON CONFLICT (user_id) DO NOTHING;
```

---

## 7. Configure Frontend Credentials in `assets/js/config.js`
Open `assets/js/config.js` in your repository and update the placeholders:
```javascript
export const CONFIG = {
  SUPABASE_URL: 'https://your-project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...', // Your public anon key
  ...
};
```
*Note: Never commit the service-role key.*

---

## 8. Configure Supabase Redirect URLs
1. In the Supabase Dashboard, go to **Authentication > URL Configuration**.
2. In **Site URL**, enter your GitHub Pages URL:
   `https://<your-github-username>.github.io/<repo-name>/`
3. Under **Redirect URLs**, add:
   `https://<your-github-username>.github.io/<repo-name>/admin.html`
   `http://localhost:8000/admin.html` (for local development testing)

---

## 9. Create GitHub Repository & Deploy to Pages
1. Initialize git and commit:
```bash
git init
git add .
git commit -m "feat: initial release of break-timer"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```
2. In GitHub, go to **Settings > Pages**.
3. Under **Build and deployment > Source**, select **GitHub Actions**.
4. The `.github/workflows/pages.yml` workflow will automatically build and publish your static website.

---

## 10. Print Physical QR Code Sheets
1. Visit `https://<your-username>.github.io/<repo-name>/admin.html` and sign in with your admin credentials.
2. Click on the **"Print QR Sheets"** tab.
3. Select **Lab 1** and click **"Print Sheet"**.
4. Select **Lab 2** and click **"Print Sheet"**.
5. Laminate or tape each QR card to the corresponding physical desk.
6. Note the disclaimer on the card: *Scanning is not proof of presence. Blank means no break timer is active.*

---

## 11. Run Verification Test Suite
In the Supabase SQL Editor, run `supabase/99_tests.sql`. Ensure all 7 automated test cases pass with the message:
`ALL MANDATORY DATABASE TESTS PASSED SUCCESSFULLY!`
