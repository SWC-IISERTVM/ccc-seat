# Computer Lab Break-Timer (Version 1.0)

A lightweight, privacy-first web application designed for college computer labs. Provides real-time 15-minute break countdowns for students temporarily stepping away from their desks.

---

## 1. Product Summary & Philosophy

Each computer in the lab has exactly two displayed states:
- **BLANK**: No active break timer is running.
- **ON BREAK**: A 15-minute countdown is actively in progress.

> **Key Rule**: The system is NOT a seat-booking, reservation, or occupancy system. A BLANK status simply indicates that no break timer is active. It never guarantees that a computer is physically vacant. Students must check in person and adhere to the lab's belongings policy.

---

## 2. Technical Stack

- **Frontend**: Vanilla HTML5, CSS3, Modern JavaScript (ES Modules). No build tools, no bundlers, no external frameworks.
- **Backend**: Supabase (PostgreSQL 15+, pg_cron, pgcrypto, Row Level Security, Supabase Realtime, Supabase Auth).
- **Libraries**: Pinned `@supabase/supabase-js` (v2.48.1) and pinned `qrcode` (v1.5.4) loaded directly via CDN.
- **Hosting**: GitHub Pages (Static hosting with relative asset paths).

---

## 3. Core Business Rules (Enforced in PostgreSQL)

All business rules are strictly enforced within atomic PostgreSQL transactions (`03_functions.sql`):

1. **Fixed Duration**: Break duration is immutable and set to exactly 15 minutes (`interval '15 minutes'`). Clients cannot specify or extend duration.
2. **Rolling 60-Minute Cooldown**: A roll number is restricted to one break per rolling 60 minutes, calculated from the start timestamp of their previous break.
3. **No Overlaps**: A computer with an active unexpired break cannot accept a new break timer (`PC_BUSY`).
4. **Early Return ("I'm Back")**: A student can return early using their one-time break token or roll number. Early return blanks the computer immediately, but does **not** refund the 60-minute cooldown.
5. **Database Time Authority**: All duration and expiry checks rely on PostgreSQL database time (`clock_timestamp()`). Device clock skew has zero effect on countdowns.
6. **Graceful Expired Handling**: The frontend automatically displays any past expiry timestamp as BLANK immediately, even if the database cleanup worker experiences latency.
7. **Audit Logging**: Administrators can clear any timer; all staff actions are permanently recorded in `admin_actions`.

---

## 4. Privacy & Security Model

- **Public-Safe Schema**: The `computers` table exposed to the public dashboard contains only `id`, `lab_id`, `pc_number`, `break_started_at`, and `break_expires_at`.
- **Peppered HMAC Roll Keys**: Raw student roll numbers are never saved to persistent storage. The database stores only HMAC-SHA256 digests generated with a secret high-entropy pepper stored in a private `app_config` table.
- **Hashed Break Tokens**: The client receives a random 24-byte break token in memory and local storage. Only its SHA-256 digest is stored in `break_history`.
- **Zero Direct Writes**: Anonymous users have zero direct INSERT, UPDATE, or DELETE privileges on any table. All actions occur through `SECURITY DEFINER` stored procedures with explicit `search_path = public, pg_temp`.

---

## 5. Concurrency & Race Condition Defense

- **Row Locks**: The `start_break` RPC acquires an exclusive row lock (`FOR UPDATE`) on the target computer.
- **Advisory Locks**: The system acquires a transactional advisory lock (`pg_advisory_xact_lock(hashtext('roll:' || v_roll_key))`) on the student's roll key. This guarantees that concurrent requests from the same roll number cannot race past the 60-minute cooldown check.

---

## 6. Realtime Scalability & Free-Tier Considerations

### Capacity for ~100 Concurrent Viewers
- Supabase Free Tier allows up to **200 concurrent Realtime WebSocket connections**.
- 100 simultaneous lab viewers consume approximately 100 Realtime connections.
- During typical lab hours (15-minute breaks across 60 PCs), state change events occur approximately 2 to 8 times per minute, producing minimal payload bandwidth (~1 KB per event).
- If Realtime disconnects, the frontend automatically falls back to a 30-second polling cycle and dims tiles with an offline notice.

### Free-Tier Project Inactivity Notice
- Supabase projects on the Free Tier may pause after 7 consecutive days of complete database inactivity.
- **Operational Guidelines**: Do NOT employ keep-alive ping bots that violate provider terms of service. If a lab semester break causes the project to pause, simply click **"Resume Project"** in the Supabase dashboard before classes resume.

---

## 7. Manual QA Checklist

The following 9 test scenarios must be verified before production rollout:

| # | Test Scenario | Expected Outcome | Verification Steps |
|---|---|---|---|
| 1 | **Concurrent Requests on Same PC** | Only one request succeeds; second returns `PC_BUSY` | Open two tabs for PC 01; submit break simultaneously. |
| 2 | **Rolling 60-Minute Cooldown** | Rejected with `COOLDOWN` showing exact eligible time | Start break on PC 01 with Roll A. Attempt break on PC 02 with Roll A. |
| 3 | **Browser Refresh / Device Reconnect** | Countdown continues uninterrupted | Start break, refresh tab, check timer continues matching server time. |
| 4 | **Timer Expiry** | PC tile reverts to BLANK automatically | Allow timer to run to 00:00; tile flips to BLANK without refresh. |
| 5 | **Duration Tampering Prevention** | Client cannot alter 15m duration | Inspect RPC calls; confirm client cannot provide custom duration. |
| 6 | **Unauthorized End Break** | Rejected with `UNAUTHORIZED_OWNER` | Attempt to end another student's break using a different roll number. |
| 7 | **Network Drop / Offline Warning** | Offline banner displays, stale tiles dim | Disconnect Wi-Fi; check UI shows "Offline: data may be out of date". |
| 8 | **Privacy Leak Verification** | Zero roll numbers, hashes, or tokens exposed | Inspect Network tab responses for `computers`; verify no private fields. |
| 9 | **QR Code Deep Links** | Direct access to computer modal | Scan desk QR or open `index.html?lab=lab-1&pc=5`; verify modal opens for PC 05. |

---

## 8. Automated Database Tests

Automated test cases covering concurrency, cooldown enforcement, owner validation, and schema security are packaged in `/supabase/99_tests.sql`. Execute the file in the Supabase SQL Editor to run the test suite.
