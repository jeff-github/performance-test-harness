import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/**
 * Configurable API load model (portfolio edition)
 * Fix: build scenarios object without undefined keys (k6 options parsing safety)
 */

const BASE_URL = __ENV.DIARY_BASE_URL;
if (!BASE_URL) {
  throw new Error('Missing env var DIARY_BASE_URL');
}

const SPONSOR_ID = __ENV.DIARY_SPONSOR_ID || 'demo';
const DISABLE_AUTH_SCENARIO = (__ENV.DIARY_DISABLE_AUTH_SCENARIO || '') === '1';

function envInt(name, fallback, min = 0) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}; got "${raw}"`);
  }
  return value;
}

function envFloat(name, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}; got "${raw}"`);
  }
  return value;
}

const SYNC_EVENT_RATE = envFloat('DIARY_SYNC_EVENT_RATE', 0.10, 0, 1);
const SLEEP_MIN_MS = envInt('DIARY_SLEEP_MIN_MS', 200, 0);
const SLEEP_MAX_MS = envInt('DIARY_SLEEP_MAX_MS', 800, 0);
if (SLEEP_MIN_MS > SLEEP_MAX_MS) {
  throw new Error('DIARY_SLEEP_MIN_MS cannot be greater than DIARY_SLEEP_MAX_MS');
}

const BUSINESS_STAGE_1_TARGET = envInt('DIARY_BUSINESS_STAGE_1_TARGET', 10, 0);
const BUSINESS_STAGE_2_TARGET = envInt('DIARY_BUSINESS_STAGE_2_TARGET', 25, 0);
const BUSINESS_STAGE_3_TARGET = envInt('DIARY_BUSINESS_STAGE_3_TARGET', 50, 0);
const BUSINESS_STAGE_4_TARGET = envInt('DIARY_BUSINESS_STAGE_4_TARGET', 50, 0);
const AUTH_LOGIN_RATE = envInt('DIARY_AUTH_LOGIN_RATE', 5, 1);
const AUTH_PRE_ALLOCATED_VUS = envInt('DIARY_AUTH_PRE_ALLOCATED_VUS', 10, 1);
const AUTH_MAX_VUS = envInt('DIARY_AUTH_MAX_VUS', 50, AUTH_PRE_ALLOCATED_VUS);
const P95_HTTP_MS = envInt('DIARY_THRESHOLD_HTTP_P95_MS', 2000, 1);
const P95_LOGIN_MS = envInt('DIARY_THRESHOLD_LOGIN_P95_MS', 1500, 1);
const P95_RECORDS_MS = envInt('DIARY_THRESHOLD_RECORDS_P95_MS', 1500, 1);
const P95_SYNC_MS = envInt('DIARY_THRESHOLD_SYNC_P95_MS', 2000, 1);
const P95_HEALTH_MS = envInt('DIARY_THRESHOLD_HEALTH_P95_MS', 800, 1);
const P95_SPONSOR_CONFIG_MS = envInt('DIARY_THRESHOLD_SPONSOR_CONFIG_P95_MS', 1200, 1);
const HTTP_FAILED_RATE = envFloat('DIARY_THRESHOLD_HTTP_FAILED_RATE', 0.02, 0, 1);
const CHECKS_MIN_RATE = envFloat('DIARY_THRESHOLD_CHECKS_MIN_RATE', 0.98, 0, 1);

function urlJoin(base, path) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleepThinkTime() {
  sleep(randBetween(SLEEP_MIN_MS, SLEEP_MAX_MS) / 1000.0);
}

function parseUsersJson(raw, source) {
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${source} as JSON: ${err.message}`);
  }

  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`${source} must be a non-empty array`);
  }

  for (const [idx, user] of arr.entries()) {
    if (!user || typeof user.username !== 'string' || user.username.length === 0) {
      throw new Error(`${source}[${idx}].username must be a non-empty string`);
    }
    if (!user.passwordHash || typeof user.passwordHash !== 'string') {
      throw new Error(`${source}[${idx}].passwordHash must be a non-empty string`);
    }
  }

  return arr;
}

// metrics
const tHealth = new Trend('diary_health_ms');
const tLogin = new Trend('diary_login_ms');
const tRecords = new Trend('diary_records_ms');
const tSync = new Trend('diary_sync_ms');
const tSponsorConfig = new Trend('diary_sponsor_config_ms');

const diaryChecksOk = new Rate('diary_checks_ok');
const authFailures = new Counter('auth_failures');

// scenarios
const scenarios = {
  business: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: BUSINESS_STAGE_1_TARGET },
      { duration: '2m', target: BUSINESS_STAGE_2_TARGET },
      { duration: '2m', target: BUSINESS_STAGE_3_TARGET },
      { duration: '2m', target: BUSINESS_STAGE_4_TARGET },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
    exec: 'businessFlow',
  },
};

if (!DISABLE_AUTH_SCENARIO) {
  scenarios.auth = {
    executor: 'constant-arrival-rate',
    rate: AUTH_LOGIN_RATE,
    timeUnit: '1s',
    duration: '3m',
    preAllocatedVUs: AUTH_PRE_ALLOCATED_VUS,
    maxVUs: AUTH_MAX_VUS,
    exec: 'authFlow',
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: [`rate<${HTTP_FAILED_RATE}`],
    http_req_duration: [`p(95)<${P95_HTTP_MS}`],

    'http_req_duration{endpoint:health}': [`p(95)<${P95_HEALTH_MS}`],
    'http_req_duration{endpoint:login}': [`p(95)<${P95_LOGIN_MS}`],
    'http_req_duration{endpoint:records}': [`p(95)<${P95_RECORDS_MS}`],
    'http_req_duration{endpoint:sync}': [`p(95)<${P95_SYNC_MS}`],
    'http_req_duration{endpoint:sponsor_config}': [`p(95)<${P95_SPONSOR_CONFIG_MS}`],

    diary_checks_ok: [`rate>${CHECKS_MIN_RATE}`],
  },
};

// ----- users pool -----
function parseUsersFromEnv() {
  const raw = __ENV.DIARY_USERS_JSON;
  if (!raw) return null;
  return parseUsersJson(raw, 'DIARY_USERS_JSON');
}

function parseUsersFromFile() {
  const f = __ENV.DIARY_USERS_FILE;
  if (!f) return null;
  const raw = open(f);
  return parseUsersJson(raw, `DIARY_USERS_FILE ${f}`);
}

function defaultUserFallback() {
  if (!__ENV.DIARY_USERNAME || !__ENV.DIARY_PASSWORD_HASH) {
    throw new Error('Configure DIARY_USERS_FILE, DIARY_USERS_JSON, or DIARY_USERNAME and DIARY_PASSWORD_HASH');
  }
  return [{ username: __ENV.DIARY_USERNAME, passwordHash: __ENV.DIARY_PASSWORD_HASH }];
}

export function setup() {
  const users = parseUsersFromEnv() || parseUsersFromFile() || defaultUserFallback();

  const tokens = [];
  for (const u of users) {
    const res = http.post(
      urlJoin(BASE_URL, '/api/v1/auth/login'),
      JSON.stringify({ username: u.username, passwordHash: u.passwordHash }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login', phase: 'setup' } }
    );

    tLogin.add(res.timings.duration, { phase: 'setup' });

    const ok = (check(res, {
      'setup login status 200': (r) => r.status === 200,
      'setup login returns jwt': (r) => !!r.json('jwt'),
    }) || false);

    diaryChecksOk.add(ok);

    if (!ok) {
      authFailures.add(1);
      throw new Error(`setup login failed status=${res.status}`);
    }

    tokens.push({ username: u.username, jwt: res.json('jwt'), passwordHash: u.passwordHash });
  }

  return { tokens };
}

function pickToken(data) {
  const idx = (__VU - 1) % data.tokens.length;
  return data.tokens[idx];
}

function authHeaders(jwt) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
  };
}

export function businessFlow(data) {
  const tok = pickToken(data);
  const headers = authHeaders(tok.jwt);

  // health
  {
    const res = http.get(urlJoin(BASE_URL, '/health'), {
      headers: { Accept: 'application/json' },
      tags: { endpoint: 'health', flow: 'business' },
    });
    tHealth.add(res.timings.duration);
    const ok = (check(res, { 'health status 200': (r) => r.status === 200 }) || false);
    diaryChecksOk.add(ok);
  }

  sleepThinkTime();

  // sponsor config
  {
    const res = http.get(
      urlJoin(BASE_URL, `/api/v1/sponsor/config?sponsorId=${encodeURIComponent(SPONSOR_ID)}`),
      { headers: { Accept: 'application/json' }, tags: { endpoint: 'sponsor_config', flow: 'business' } }
    );
    tSponsorConfig.add(res.timings.duration);
    const ok = (check(res, { 'sponsor config status 200': (r) => r.status === 200 }) || false);
    diaryChecksOk.add(ok);
  }

  sleepThinkTime();

  // records
  {
    const res = http.post(urlJoin(BASE_URL, '/api/v1/user/records'), '{}', {
      headers,
      tags: { endpoint: 'records', flow: 'business' },
    });
    tRecords.add(res.timings.duration);
    const ok = (check(res, { 'records status 200': (r) => r.status === 200 }) || false);
    diaryChecksOk.add(ok);
  }

  sleepThinkTime();

  // sync
  {
    let payload = { events: [] };
    if (Math.random() < SYNC_EVENT_RATE) {
      payload = { events: [{ type: 'NOOP', ts: Date.now(), metadata: { vu: __VU, iter: __ITER } }] };
    }

    const res = http.post(urlJoin(BASE_URL, '/api/v1/user/sync'), JSON.stringify(payload), {
      headers,
      tags: { endpoint: 'sync', flow: 'business' },
    });
    tSync.add(res.timings.duration);
    const ok = (check(res, { 'sync status 200': (r) => r.status === 200 }) || false);
    diaryChecksOk.add(ok);
  }

  sleepThinkTime();
}

export function authFlow(data) {
  const idx = (__VU - 1) % data.tokens.length;
  const u = data.tokens[idx];

  const res = http.post(
    urlJoin(BASE_URL, '/api/v1/auth/login'),
    JSON.stringify({ username: u.username, passwordHash: u.passwordHash }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login', flow: 'auth' } }
  );

  tLogin.add(res.timings.duration, { flow: 'auth' });

  const ok = (check(res, {
    'auth login status 200': (r) => r.status === 200,
    'auth login returns jwt': (r) => !!r.json('jwt'),
  }) || false);

  diaryChecksOk.add(ok);
  if (!ok) authFailures.add(1);

  sleep(0.1);
}
