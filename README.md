# Performance Test Harness

k6 workload model with ramping business traffic, a separate authentication arrival
rate, per-endpoint latency metrics, error counters and configurable thresholds.

## Run
Install k6 and configure an authorized disposable backend with synthetic credentials.
```powershell
$env:DIARY_BASE_URL="http://localhost:3000"
$env:DIARY_USERNAME="demo-user"
$env:DIARY_PASSWORD_HASH="YOUR_TEST_ACCOUNT_PASSWORD_HASH"
$env:DIARY_SPONSOR_ID="demo"
k6 run load-test.js
```
Alternatively set `DIARY_USERS_FILE` to a local JSON array with `username` and
`passwordHash` fields. Credentials and captured results are not included.
Target routes: `/health`, `/api/v1/auth/login` (returns `jwt`),
`/api/v1/sponsor/config`, `/api/v1/user/records`, `/api/v1/user/sync`.
Adapt routes/payloads to your application. No backend is bundled.

Default business stages target 10, 25, 50 and 50 virtual users over seven minutes.
A separate three-minute auth scenario targets five logins/sec; disable it with
`DIARY_DISABLE_AUTH_SCENARIO=1`. Review the load before execution; sync can write events.
See `DIARY_BUSINESS_STAGE_*`, `DIARY_THRESHOLD_*` and pacing settings in the source.
Thresholds are test criteria, not claims of production SLO ownership.
CI validates syntax only and generates no external load.

## Status
Public portfolio edition of existing project code. Original credentials, captured
run data, and environment defaults are excluded. See the limitations above.
