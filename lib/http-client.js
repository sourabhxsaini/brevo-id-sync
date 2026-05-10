const axios = require('axios');

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.HTTP_MAX_RETRIES || 3);
const BASE_DELAY_MS = Number(process.env.HTTP_RETRY_BASE_MS || 500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(error, attempt) {
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }

  const jitter = Math.floor(Math.random() * 200);
  return BASE_DELAY_MS * (2 ** (attempt - 1)) + jitter;
}

function isRetryable(error) {
  const method = String(error?.config?.method || '').toUpperCase();
  const explicitlyRetryable = error?.config?.__retryable === true;
  if ((method === 'POST' || method === 'PATCH' || method === 'DELETE') && !explicitlyRetryable) {
    return false;
  }

  const status = error?.response?.status;
  if (!status) return true;
  return status === 429 || status >= 500;
}

function createHttpClient(defaultHeaders = {}) {
  const client = axios.create({
    timeout: DEFAULT_TIMEOUT_MS,
    headers: defaultHeaders
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config || {};
      config.__retryCount = config.__retryCount || 0;

      if (!isRetryable(error) || config.__retryCount >= MAX_RETRIES) {
        return Promise.reject(error);
      }

      config.__retryCount += 1;
      const delay = getRetryDelay(error, config.__retryCount);
      await sleep(delay);
      return client(config);
    }
  );

  return client;
}

function formatHttpError(context, err) {
  const status = err?.response?.status;
  const method = (err?.config?.method || '').toUpperCase();
  const url = err?.config?.url;
  const payload = err?.response?.data || err?.message || String(err);
  return `${context} | status=${status || 'NA'} method=${method || 'NA'} url=${url || 'NA'} error=${JSON.stringify(payload)}`;
}

module.exports = {
  createHttpClient,
  formatHttpError,
};
