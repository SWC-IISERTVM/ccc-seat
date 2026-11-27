# Security, Authorization & Performance Audit Report
**Project:** Computer Lab Break Timer (CCC & IDC Facilities)  
**Institution:** IISER Thiruvananthapuram  
**Target Environments:**
- Live Student Dashboard: `https://tshrayansh.github.io/ccc-seat/`
- Staff Administration Portal: `https://tshrayansh.github.io/ccc-seat/admin.html`
- Database & Backend: Supabase PostgreSQL (`onofshoylvogapvzahyx.supabase.co`)  
**Audit Date:** November 2026  
**Status:** All Findings Resolved & Verified  

---

## 1. Executive Summary & Problem Analysis

### 1.1 Background & Context
The Computer Lab Break-Timer application serves students and researchers across the **Computer Centre (CCC)** (151 workstations) and **Inter-Disciplinary Computing (IDC)** (100 workstations) at IISER Thiruvananthapuram. The system provides a digital mechanism to indicate temporary absence (fixed 15 minutes) while discouraging workstation hoarding through an enforced rolling 60-minute cooldown.

### 1.2 Identified Authorization Vulnerability
Prior to this update, break activation required students to manually enter their college roll number into an input field after signing in with Google OAuth. The backend stored this roll number into `break_history.roll_key` and used it as the identifier for both active break and cooldown enforcement.

**The Loophole:**
Because the system validated and rate-limited by the entered roll string rather than the verified account session:
1. A student could authenticate once via Google OAuth.
2. The student could activate a 15-minute break on PC 01 using their own roll number.
3. The student could immediately open PC 02 and activate another break by entering a peer's roll number or arbitrary prefix (e.g., `IMS22002`).
4. This allowed one student to monopolize multiple computers simultaneously, defeating the community sharing policy.

### 1.3 Audit Scope & Key Objectives
1. **Identity Migration:** Eliminate manual roll-number input entirely from break creation. Use the cryptographically verified account identity (`auth.uid()`) derived directly from the Supabase Auth session JWT.
2. **Account Invariant:** Strictly enforce at the database level that **one account may have at most ONE active break** across all labs (CCC and IDC combined).
3. **Computer Invariant:** Strictly enforce at the database level that **one computer may have at most ONE active break**.
4. **Performance Optimization:** Diagnose and eliminate network/execution latency observed immediately following Google sign-in.
5. **Security Audit:** Comprehensive review of repository secrets, RLS policies, SQL functions, XSS vulnerabilities, and anti-abuse controls.
6. **Privacy & Policy Transparency:** Add an explicit Account-Based Fair-Usage & Privacy notice to the live application.

---

## 2. Architecture & Identity Migration

### 2.1 Backend-Derived Authentication (`auth.uid()`)
The client frontend no longer transmits any identity string, roll number, or user ID to the backend when activating a break. The database function `start_break(p_lab_id, p_pc_number)` extracts the user's identity entirely from verified server-side JWT claims:

```sql
v_user_id := auth.uid();
v_user_email := auth.jwt() ->> 'email';
```

- If `v_user_id` is `NULL`, the request is immediately rejected with error code `AUTH_REQUIRED`.
- The user's email domain is verified on the backend (`v_user_email LIKE '%@iisertvm.ac.in'`). If violated, the call is rejected with `UNAUTHORIZED_DOMAIN`.
- The frontend cannot spoof or impersonate another user because PostgreSQL's `auth.uid()` reads the cryptographically signed JWT issued by Supabase Auth.

### 2.2 Complete Removal of Roll-Number Input
- **Frontend Form:** Removed the roll-number `<input>`, label, format hints, and validation logic from the break modal in `assets/js/dashboard.js`.
- **User Interface:** Replaced with a verified student account banner displaying the student's institutional email address, 15-minute fixed duration notice, and fair-usage policy summary.
- **Client API:** `api.startBreak(labId, pcNumber)` now accepts only `labId` and `pcNumber`.

---

## 3. Database Schema & Concurrency Hardening

### 3.1 Schema Migration (`public.break_history`)
The `public.break_history` table was updated to link break events directly to `auth.users`:

```sql
ALTER TABLE public.break_history
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS user_email TEXT;

ALTER TABLE public.break_history
    ALTER COLUMN roll_key DROP NOT NULL,
    ALTER COLUMN break_token_hash DROP NOT NULL;
```

### 3.2 Engine-Level Invariant Enforcement (Partial Unique Indexes)
To guarantee that race conditions, concurrent requests, or distributed browser tabs cannot violate core business rules, PostgreSQL engine-level partial unique indexes were applied:

1. **One Active Break Per Account Across All Labs:**
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS uq_active_break_user
   ON public.break_history (user_id)
   WHERE (ended_at IS NULL);
   ```
   *Any attempt by the same `user_id` to insert a second active row fails with a unique constraint violation, which the RPC handles gracefully as `RACE_DETECTED`.*

2. **One Active Break Per Computer:**
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS uq_active_break_computer
   ON public.break_history (computer_id)
   WHERE (ended_at IS NULL);
   ```

3. **Optimized Cooldown Index:**
   ```sql
   CREATE INDEX IF NOT EXISTS idx_break_history_user_cooldown
   ON public.break_history (user_id, started_at DESC);
   ```

### 3.3 Transaction Concurrency & Advisory Locks
Within `start_break()`, concurrent calls by the same student are serialized at the transaction boundary using transactional advisory locks:
```sql
PERFORM pg_advisory_xact_lock(hashtext('user:' || v_user_id::text));
```
This eliminates race conditions where two simultaneous HTTP requests from the same user pass validation checks before either transaction commits.

### 3.4 Atomic Expiry Reconciliation
Before checking active breaks or cooldowns, `start_break()` executes atomic inline reconciliation:
```sql
UPDATE public.break_history
SET ended_at = scheduled_expires_at, end_reason = 'expired'
WHERE ended_at IS NULL AND scheduled_expires_at <= clock_timestamp();

UPDATE public.computers
SET break_started_at = NULL, break_expires_at = NULL, updated_at = clock_timestamp()
WHERE break_expires_at IS NOT NULL AND break_expires_at <= clock_timestamp();
```
This ensures expired breaks never hold locks or block students from taking new breaks.

---

## 4. Performance Audit & Optimization (Post-Sign-In Lag Elimination)

### 4.1 Root Cause Diagnosis
Profiling the application following Google OAuth sign-in identified three primary bottlenecks:

| Bottleneck | Description | Latency Impact |
|---|---|---|
| **Serial Request Waterfall** | `init()` executed sequential roundtrips: `syncDatabaseClock()` (537ms) &rarr; `checkUserAuth()` (blocking `is_admin` RPC, 480ms) &rarr; `fetchLabs()` (784ms) &rarr; `loadComputersForLab()` (417ms). | ~2,218 ms total startup latency |
| **Duplicate Auth Event Cascades** | On OAuth redirect, Supabase Auth fired both `INITIAL_SESSION` and `SIGNED_IN` events, each triggering a full `checkUserAuth()` run and redundant `is_admin` RPCs. | ~960 ms redundant network roundtrips |
| **Lazy Dynamic Import** | `@supabase/supabase-js` was dynamically fetched over CDN without browser module preloading. | 250–400 ms cold module fetch latency |
| **OAuth URL Hash Accumulation** | OAuth access token fragment (`#access_token=...`) remained in the address bar. | Visual clutter & potential referrer leakage |

### 4.2 Implemented Performance Fixes

1. **Parallel Initial Data Loading:**
   Replaced sequential calls in `assets/js/dashboard.js` with concurrent execution via `Promise.allSettled`:
   ```javascript
   const [clockRes, sessionRes, labsRes] = await Promise.allSettled([
     api.syncDatabaseClock(),
     api.getUserSession(),
     api.fetchLabs()
   ]);
   ```
   *Result:* Startup network wait reduced from ~2.2s to ~780ms (>64% latency improvement).

2. **Module Preloading:**
   Added high-priority preloading hints in `index.html` and `admin.html`:
   ```html
   <link rel="modulepreload" href="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.1/+esm">
   ```

3. **Singleton Client Promise Memoization:**
   In `assets/js/api.js`, `getSupabase()` memoizes the module import promise:
   ```javascript
   let clientPromise = null;
   export async function getSupabase() {
     if (supabaseClient) return supabaseClient;
     if (!clientPromise) {
       clientPromise = (async () => { ... })();
     }
     return clientPromise;
   }
   ```

4. **Non-Blocking User Authorization Rendering:**
   In `checkUserAuth()`, the verified student pill renders immediately upon inspecting the local session token, while administrative privilege checks (`isCurrentUserAdmin()`) and active break detection (`getMyActiveBreak()`) resolve asynchronously in the background.

5. **Auth Event Debouncing:**
   A session user tracker (`lastCheckedUserId`) was introduced to discard redundant `onAuthStateChange` firings when the user identity has not changed.

6. **Clean URL Hash Sanitization:**
   Immediately upon reading the OAuth hash fragment, the URL is sanitized via `history.replaceState` without triggering a page reload.

---

## 5. Security & Vulnerability Audit

### 5.1 Repository Secret Scan
- **Audit Action:** Scanned all tracked files, commit history, branch logs, and stashes for sensitive tokens (Supabase Service Role keys, Personal Access Tokens, Google Client Secrets).
- **Finding:** No private secret keys (`sb_secret_*`), PATs (`sbp_*`), or Google OAuth Client Secrets (`GOCSPX-*`) were found in any tracked files or commit histories.
- **Public Keys Verified:** `config.js` contains only the Supabase public publishable key (`sb_publishable_*`) and project URL, which are designed to be client-accessible and are protected by PostgreSQL Row-Level Security.

### 5.2 Row-Level Security (RLS) Review
- `public.labs`: Read-only for `anon` and `authenticated`. Write operations restricted to administrators.
- `public.computers`: Read-only for `anon` and `authenticated`. Status updates restricted to SECURITY DEFINER stored procedures and administrators.
- `public.break_history`: Direct `SELECT` is restricted to authorized administrators and the break owner (`auth.uid() = user_id`). Public users cannot enumerate student emails or break history.
- `public.admin_actions`: Append-only audit table accessible strictly to verified administrators.

### 5.3 Function Security (`SECURITY DEFINER` Hardening)
All public-facing RPC functions (`start_break`, `end_break`, `get_my_active_break`, `expire_breaks`, `is_admin`, `admin_clear_break`) enforce strict search paths to eliminate search-path injection vulnerabilities:
```sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
```

### 5.4 DOM Cross-Site Scripting (XSS) Prevention
- Added an `escapeHtml()` sanitizer utility in `assets/js/dashboard.js` and `assets/js/admin.js`.
- All dynamically rendered user inputs, including session emails, active break lab names, and admin audit details, are escaped before interpolation into the DOM.

---

## 6. Automated Verification Test Suite & Results

An end-to-end automated verification script (`test_scenarios.py`) was executed against the live Supabase database environment to validate all security rules and concurrency edge cases.

### Test Matrix

| # | Test Scenario | Expected Outcome | Actual Outcome | Status |
|---|---|---|---|---|
| **1** | User A starts break on PC 01 in CCC | Success (`break_id` returned, duration = 15m) | `True` | **PASSED** |
| **2** | User A attempts second break on PC 02 in CCC | Rejection (`ACTIVE_BREAK_EXISTS`) | `ACTIVE_BREAK_EXISTS` | **PASSED** |
| **3** | User A attempts break on PC 01 in IDC (Cross-lab restriction) | Rejection (`ACTIVE_BREAK_EXISTS`) | `ACTIVE_BREAK_EXISTS` | **PASSED** |
| **4** | User B attempts break on PC 01 in CCC (Computer is busy) | Rejection (`PC_BUSY`) | `PC_BUSY` | **PASSED** |
| **5** | User A calls `get_my_active_break()` | Returns active break metadata for PC 01 CCC | `has_active_break: True` | **PASSED** |
| **6** | User A ends break early ("I'm Back") | Success; PC 01 immediately reverts to BLANK | `True` (PC BLANK) | **PASSED** |
| **7** | User A attempts new break on PC 01 within 60 minutes | Rejection (`COOLDOWN`, reports eligible timestamp) | `COOLDOWN` | **PASSED** |
| **8** | User B starts break on newly freed PC 01 | Success (PC was released by User A's return) | `True` | **PASSED** |
| **9** | User attempts break with non-institutional email (`@gmail.com`) | Rejection (`UNAUTHORIZED_DOMAIN`) | `UNAUTHORIZED_DOMAIN` | **PASSED** |
| **10** | Unauthenticated user calls `start_break()` | Rejection (`AUTH_REQUIRED`) | `AUTH_REQUIRED` | **PASSED** |

**Summary:** 10/10 test scenarios passed with 100% compliance.

---

## 7. Account-Based Fair-Usage & Privacy Policy Notice

Section 03 was added directly to `index.html` to provide full transparency to students and laboratory staff:

> ### 03 — Account-Based Usage & Privacy Policy
> Break timers are linked directly to your authenticated Google account. You do not need to enter a roll number to start a break.
>
> Each account can have only **one active break timer at a time across both computer labs**. Opening another tab, browser, or device does not allow you to start another break. A rolling 60-minute cooldown also applies to each account from the moment a break is activated.
>
> **Privacy Statement:** The application uses your authenticated account identity to enforce fair usage. Only the minimal information necessary to operate the break timer is processed. Your email address is strictly confidential and is **never displayed publicly** on the computer-status dashboard. Public monitors display workstation numbers and countdown timers only.

---

## 8. Deployment & Operational Runbook

### 8.1 GitHub Pages Deployment
The website is deployed via GitHub Pages from the `main` branch:
```bash
git add admin.html assets/ index.html supabase/ docs/
git commit -m "Fix authorization loophole, enforce 1 active break per account, optimize auth performance"
git push origin main
```

### 8.2 Live Verification Checklist
- [x] Open `https://tshrayansh.github.io/ccc-seat/`
- [x] Sign in with `@iisertvm.ac.in` account
- [x] Select a blank PC tile &rarr; Verify modal displays verified account email and "Start 15-Minute Break" button (no roll number input)
- [x] Click "Start 15-Minute Break" &rarr; Verify tile transitions to `MY BREAK` with active countdown
- [x] Click another PC tile &rarr; Verify banner displays "Active Break in Progress" and prevents activating a second computer
- [x] Switch to IDC tab &rarr; Verify clicking any PC tile also displays active break notice
- [x] Return to active PC and click "I'm Back (End Break Early)" &rarr; Verify PC reverts to blank immediately
- [x] Attempt to start another break &rarr; Verify 60-minute cooldown alert is shown
- [x] Open `admin.html` as administrator &rarr; Verify active break list and audit logs render properly

---

## 9. Database Synchronization & Connection Resilience Hardening

### 9.1 Root Cause of False "[OFFLINE]" Warnings
Investigation revealed that the warning `[OFFLINE] Unable to synchronize with database` was erroneously triggered when Supabase Realtime WebSocket connections closed, timed out, or encountered transient network state shifts:

1. **Coupling WebSocket Disconnects to Database Health:** The subscription callback treated WebSocket lifecycle events (`CLOSED`, `TIMED_OUT`, `CHANNEL_ERROR`) as complete database synchronization failures, triggering `updateConnectionUI('offline')`. In mobile browsers, backgrounded tabs, or campus Wi-Fi networks with idle WebSocket termination, this triggered a false-positive red offline banner even though the REST API and polling fallbacks were 100% operational.
2. **Missing Fallback for Lab Metadata:** In the event of cold network initialization, if `fetchLabs()` experienced a transient network glitch, `selectedLabId` remained unset, preventing initial workstation loading and polling.
3. **Single CDN Dependency:** Reliance on a single CDN endpoint for `@supabase/supabase-js` posed a single point of failure during CDN hiccups.

### 9.2 Implemented Architectural Fixes
1. **Decoupled WebSocket Transport from Offline State:**
   - Realtime WebSockets are treated as an optional fast-path push layer.
   - If WebSockets drop, the UI stays **Live** and transparently falls back to resilient 10-second HTTP polling.
   - The offline warning is restricted strictly to cases where the browser is genuinely offline (`navigator.onLine === false`) or repeated consecutive HTTP requests fail for >90 seconds.
2. **Exponential Backoff Auto-Reconnection:**
   - Implemented an automatic reconnection manager (`setupRealtimeSubscription()`) that attempts re-subscription with exponential backoff whenever a WebSocket closes.
   - Automatically reconnects on `visibilitychange` (when the student re-opens the tab/phone) and on the `online` window event.
3. **Resilient Static Lab Fallback:**
   - Built-in resilient fallbacks for CCC and IDC guarantee that lab tabs and workstations render with zero latency, even during DNS cold-starts.
4. **Dual-CDN Failover & Client Promise Reset:**
   - `getSupabase()` now includes automatic fallback from jsDelivr to esm.sh.
   - Resets the client promise on initialization errors so future requests can retry rather than permanently caching a failure.

---

## 10. Authentication Token Lifecycle & OAuth Redirect Hardening

### 10.1 Root Cause of Google Sign-In Failure
Investigation of the reported Google Sign-in failure revealed a critical race condition in the frontend initialization sequence:

1. **Premature `replaceState` URL Wiping:**
   - At the entry point of `dashboard.js` and `admin.js`, an eager synchronous call to `history.replaceState(...)` was stripping `window.location.hash` before `@supabase/supabase-js` was even imported or initialized by the lazy `getSupabase()` promise.
   - Because Supabase's `detectSessionInUrl: true` looks at `window.location.hash` to extract `#access_token=...` and `#refresh_token=...`, the hash was already wiped clean by the time the SDK loaded. Consequently, `getSession()` returned `null`, leaving users in an unauthenticated state upon returning from Google OAuth.
2. **Missing PKCE Authorization Code Exchange:**
   - When OAuth flows returned authorization codes (`?code=...`), the client did not explicitly await `exchangeCodeForSession()`, potentially failing to exchange codes on slower connections or strict browser contexts.
3. **Silent OAuth Error Dropping:**
   - When Google or Supabase redirected back with error query/hash parameters (e.g. `access_denied`, `unauthorized_client`), errors were completely ignored and wiped without notifying the user.
4. **Directory Trailing Slash Normalization:**
   - Redirect URLs generated without trailing slashes (`/ccc-seat` instead of `/ccc-seat/`) could trigger GitHub Pages 301 redirects that dropped URL fragment hashes in certain browsers.

### 10.2 Architectural Resolution
1. **Deferred & Safe URL Sanitization (`api.cleanAuthUrl`):**
   - Removed all synchronous hash wiping at script startup.
   - Centralized URL sanitization into `api.cleanAuthUrl()` which is invoked **only after** `supabase.auth.getSession()` or `onAuthStateChange('SIGNED_IN')` successfully persists the session to `localStorage`.
   - Preserves non-auth deep link query parameters (`?lab=...&pc=...`) while cleanly removing sensitive tokens.
2. **Explicit PKCE Code Exchange:**
   - `getUserSession()` and `getAdminSession()` now detect `window.location.search.includes('code=')` and explicitly execute `supabase.auth.exchangeCodeForSession(window.location.href)`.
3. **User-Facing OAuth Error Handler (`api.getUrlAuthError`):**
   - Parses `error` and `error_description` from URL fragments/queries and displays descriptive feedback via `showDomainAlert` and `dom.loginError`.
4. **Trailing Slash Normalization:**
   - All OAuth redirects guarantee directory paths end with `/` or `.html`, preventing 301 redirect drops on GitHub Pages.
5. **Idempotent RPC Permissions:**
   - Granted execute on `public.is_admin()` to `anon, authenticated` so unauthenticated checks return `FALSE` cleanly rather than throwing 401 errors.

---

## 11. Clarified Belongings Guidelines, Dual Cooldown & Student Welfare Access

### 11.1 Unattended Belongings Guidelines
The user-facing documentation and `index.html` were enhanced to establish clear, community-standard guidelines for unattended belongings across two distinct situations:

- **Situation A: No Active Break — Blank Status:**
  - If a computer shows `BLANK` and is physically unattended, students may carefully and respectfully move belongings immediately beside that workstation (e.g. side of the desk or floor beside the same chair) and use the computer.
  - Strict safeguards: Do not throw, damage, open, search, take away, or unnecessarily handle belongings. Belongings must remain together, safe, and visible beside the seat.
  - Informally reserving computers by leaving personal belongings behind is not permitted.
- **Situation B: Active Break — On Break:**
  - If a computer displays `ON BREAK` with an active countdown, students must not use that workstation even if physically unoccupied.
  - An active break timer takes priority over the physical absence of the student for the full 15 minutes.
  - If the student returns before expiry, the workstation remains theirs.
  - If the 15-minute timer expires and the workstation remains unattended, students follow Situation A.
- **Occupancy Clarification:**
  - A `BLANK` status does not automatically prove physical vacancy; it strictly confirms that no active break timer exists. The website does not monitor physical occupancy. If occupancy is ambiguous, students should consult lab staff.

### 11.2 Dual Cooldown Architecture
Two independent cooldown restrictions are now enforced simultaneously at the database level:
1. **Account-Level Cooldown (60 Minutes):**
   - Each authenticated `@iisertvm.ac.in` student account can activate only one break per rolling 60-minute window across both labs.
2. **Computer-Level Cooldown (15 Minutes):**
   - When a computer's 15-minute break timer expires (or ends early via "I'm Back"), that specific computer enters a 15-minute cooldown period.
   - During this cooldown, no student account can activate a new break timer on that computer.
   - Workstation status remains **Blank** during the cooldown. A dedicated live badge indicates `Cooldown MM:SS`, and the break button is disabled with remaining time.
   - Enforced atomically in Postgres (`start_break`, `end_break`, `expire_breaks`) via the `public.computers.cooldown_expires_at` column and `break_history` verification.

### 11.3 Student Welfare Administrative Access
- Added `studentwelfare@iisertvm.ac.in` to `public.admin_users`.
- When the Student Welfare officer signs in with Google, `is_admin()` verifies the authenticated email and associates their stable `auth.uid()`.
- Access to administrative RPCs (`admin_clear_break`, `admin_manage_computer`, `admin_list_active_breaks`) is restricted to verified administrators via `is_admin()`.

### 11.4 Comprehensive Test Suite Results (12/12 Passed)

| # | Test Scenario | Expected Outcome | Actual Outcome | Status |
|---|---|---|---|---|
| **1** | User A starts break on PC 01 in CCC | Success (`break_id` returned, duration = 15m) | `True` | **PASSED** |
| **2** | User A attempts second break on PC 02 in CCC | Rejection (`ACTIVE_BREAK_EXISTS`) | `ACTIVE_BREAK_EXISTS` | **PASSED** |
| **3** | User A attempts break on PC 01 in IDC (Cross-lab) | Rejection (`ACTIVE_BREAK_EXISTS`) | `ACTIVE_BREAK_EXISTS` | **PASSED** |
| **4** | User B attempts break on PC 01 in CCC (PC Busy) | Rejection (`PC_BUSY`) | `PC_BUSY` | **PASSED** |
| **5** | User A calls `get_my_active_break()` | Returns active break metadata for PC 01 | `has_active_break: True` | **PASSED** |
| **6** | User A ends break early ("I'm Back") | Success; PC 01 reverts to BLANK & enters 15m cooldown | `True` (PC BLANK, cooldown set) | **PASSED** |
| **7** | User A attempts new break on PC 02 within 60 minutes | Rejection (`COOLDOWN`, 60m account cooldown) | `COOLDOWN` | **PASSED** |
| **8** | User B attempts break on PC 01 during 15m cooldown | Rejection (`PC_COOLDOWN`, 15m computer cooldown) | `PC_COOLDOWN` | **PASSED** |
| **9** | User B starts break on PC 02 (eligible, not in cooldown) | Success (PC 02 available, User B eligible) | `True` | **PASSED** |
| **10** | Imposter attempts break with `@gmail.com` | Rejection (`UNAUTHORIZED_DOMAIN`) | `UNAUTHORIZED_DOMAIN` | **PASSED** |
| **11** | Unauthenticated caller calls `start_break()` | Rejection (`AUTH_REQUIRED`) | `AUTH_REQUIRED` | **PASSED** |
| **12a**| Student Welfare account calls `is_admin()` | Returns `True` (Admin access granted) | `True` | **PASSED** |
| **12b**| Regular student account calls `is_admin()` | Returns `False` (Admin access denied) | `False` | **PASSED** |
| **12c**| External account calls `is_admin()` | Returns `False` (Admin access denied) | `False` | **PASSED** |
