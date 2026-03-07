const crypto = require('crypto');
const fetchModule = require('node-fetch');
const fetch = fetchModule;
const { Headers, Response } = fetchModule;
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { decrypt } = require('./crypto');

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BUNKERWEB_MARKERS = [/BunkerWeb/i, /Bot Detection/i, /Please wait while we check if you are a Human/i];
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_MAX_CHALLENGE_ATTEMPTS = 2;
const agentCache = new Map();

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createFetchError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function normalizeProxyUrl(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null) return null;
  const value = String(proxyUrl).trim();
  return value || null;
}

function parseProxyUrl(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw createValidationError('代理地址格式无效，请输入完整的代理 URL');
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw createValidationError('代理协议仅支持 http、https、socks 和 socks5');
  }

  return parsed;
}

function resolveSiteProxyUrl(site) {
  if (!site) return null;

  if (typeof site === 'string') {
    const normalized = normalizeProxyUrl(site);
    parseProxyUrl(normalized);
    return normalized;
  }

  if ('proxyUrl' in site) {
    const normalized = normalizeProxyUrl(site.proxyUrl);
    parseProxyUrl(normalized);
    return normalized;
  }

  if (!site.proxyUrlEnc) return null;

  const proxyUrl = normalizeProxyUrl(decrypt(site.proxyUrlEnc));
  parseProxyUrl(proxyUrl);
  return proxyUrl;
}

function getAgentFactory(proxyUrl) {
  const parsedProxyUrl = parseProxyUrl(proxyUrl);
  if (!parsedProxyUrl) return undefined;

  const cacheKey = parsedProxyUrl.toString();
  let agentFactory = agentCache.get(cacheKey);

  if (!agentFactory) {
    const isSocksProxy = parsedProxyUrl.protocol.startsWith('socks');
    const httpAgent = isSocksProxy ? new SocksProxyAgent(cacheKey) : new HttpProxyAgent(cacheKey);
    const httpsAgent = isSocksProxy ? new SocksProxyAgent(cacheKey) : new HttpsProxyAgent(cacheKey);

    agentFactory = (parsedRequestUrl) => (parsedRequestUrl.protocol === 'http:' ? httpAgent : httpsAgent);
    agentCache.set(cacheKey, agentFactory);
  }

  return agentFactory;
}

function buildSiteFetchOptions(site, options = {}) {
  const proxyUrl = resolveSiteProxyUrl(site);
  if (!proxyUrl) return { ...options };

  return {
    ...options,
    agent: getAgentFactory(proxyUrl)
  };
}

function parseCookieHeader(cookieHeader) {
  const cookies = new Map();
  if (!cookieHeader) return cookies;

  const parts = String(cookieHeader).split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!name) continue;
    cookies.set(name, value);
  }

  return cookies;
}

function serializeCookieJar(cookieJar) {
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function seedCookieJar(headersInit) {
  const headers = new Headers(headersInit || {});
  return parseCookieHeader(headers.get('cookie'));
}

function updateCookieJar(cookieJar, response) {
  const setCookies = response?.headers?.raw?.()['set-cookie'] || [];

  for (const setCookie of setCookies) {
    const [cookiePart] = String(setCookie).split(';');
    const separatorIndex = cookiePart.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = cookiePart.slice(0, separatorIndex).trim();
    const value = cookiePart.slice(separatorIndex + 1).trim();
    if (!name) continue;

    if (!value) {
      cookieJar.delete(name);
      continue;
    }

    cookieJar.set(name, value);
  }
}

function applyCookieJar(headersInit, cookieJar) {
  const headers = new Headers(headersInit || {});
  if (cookieJar.size > 0) {
    headers.set('cookie', serializeCookieJar(cookieJar));
  }
  return headers;
}

function buildFetchRequestOptions(site, options, cookieJar) {
  return buildSiteFetchOptions(site, {
    ...options,
    headers: applyCookieJar(options.headers, cookieJar),
    redirect: 'manual'
  });
}

function isRedirectResponse(response) {
  return response && REDIRECT_STATUSES.has(response.status);
}

function getResponseUrl(response, fallbackUrl) {
  return response?.url || String(fallbackUrl);
}

function getRedirectTarget(response, currentUrl) {
  const location = response?.headers?.get?.('location');
  if (!location) return null;
  return new URL(location, getResponseUrl(response, currentUrl)).toString();
}

function getRedirectedOptions(options, response, currentUrl, nextUrl) {
  const headers = new Headers(options.headers || {});
  const method = (options.method || 'GET').toUpperCase();
  const nextMethod = method;
  let body = options.body;
  let redirectMethod = nextMethod;

  if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
    redirectMethod = 'GET';
    body = undefined;
    headers.delete('content-length');
    headers.delete('content-type');
  }

  const previousUrl = new URL(String(currentUrl));
  const redirectUrl = new URL(String(nextUrl));
  if (previousUrl.origin !== redirectUrl.origin) {
    headers.delete('authorization');
  }

  return {
    ...options,
    method: redirectMethod,
    body,
    headers
  };
}

function isHtmlResponse(response) {
  const contentType = response?.headers?.get?.('content-type') || '';
  return /text\/html/i.test(contentType);
}

function readAttributeMap(tag) {
  const attributes = {};
  const attributePattern = /([a-zA-Z0-9:_-]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;

  while ((match = attributePattern.exec(tag)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attributes[name] = value;
  }

  return attributes;
}

function extractHiddenInputs(html) {
  const hiddenInputs = [];
  const inputPattern = /<input\b[^>]*>/gi;
  let match;

  while ((match = inputPattern.exec(html)) !== null) {
    const attributes = readAttributeMap(match[0]);
    if ((attributes.type || '').toLowerCase() !== 'hidden') continue;
    if (!attributes.name) continue;
    hiddenInputs.push({
      name: attributes.name,
      value: attributes.value || '',
      id: attributes.id || ''
    });
  }

  return hiddenInputs;
}

function extractPostFormAction(html, responseUrl) {
  const formPattern = /<form\b[^>]*>/gi;
  let match;

  while ((match = formPattern.exec(html)) !== null) {
    const attributes = readAttributeMap(match[0]);
    const method = (attributes.method || 'get').toLowerCase();
    if (method !== 'post') continue;
    const action = attributes.action || responseUrl;
    return new URL(action, responseUrl).toString();
  }

  return new URL('/challenge', responseUrl).toString();
}

function hasBunkerWebMarkers(html) {
  return BUNKERWEB_MARKERS.some((pattern) => pattern.test(html));
}

function extractBunkerWebChallenge(html, responseUrl) {
  const responsePath = responseUrl ? new URL(responseUrl).pathname : '';
  const hiddenInputs = extractHiddenInputs(html);
  const looksLikeChallengePath = /\/challenge\/?$/i.test(responsePath);
  const looksLikeChallengeHtml = hasBunkerWebMarkers(html) || hiddenInputs.some((input) => input.name === 'challenge' || input.id === 'challenge');

  if (!looksLikeChallengePath && !looksLikeChallengeHtml) {
    return null;
  }

  const seedMatch = html.match(/digestMessage\(\s*["']([^"']+)["']\s*\+\s*[^)]*?\.toString\(\)\s*\)/i);
  const prefixMatch = html.match(/startsWith\(\s*["']([^"']+)["']\s*\)/i);
  const challengeField = hiddenInputs.find((input) => input.name === 'challenge' || input.id === 'challenge') || hiddenInputs[0];

  if (!seedMatch || !prefixMatch || !challengeField) {
    return {
      kind: 'blocked',
      responseUrl,
      html
    };
  }

  return {
    kind: 'challenge',
    responseUrl,
    actionUrl: extractPostFormAction(html, responseUrl),
    seed: seedMatch[1],
    prefix: prefixMatch[1],
    fieldName: challengeField.name,
    hiddenInputs,
    html
  };
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw createFetchError('请求已取消', { name: 'AbortError' });
  }
}

function solveHashPrefixChallenge(seed, prefix, signal) {
  for (let nonce = 0; nonce < 10_000_000; nonce += 1) {
    if (nonce % 2000 === 0) assertNotAborted(signal);
    const digest = crypto.createHash('sha256').update(`${seed}${nonce}`).digest('hex');
    if (digest.startsWith(prefix)) {
      return String(nonce);
    }
  }

  throw createFetchError('BunkerWeb 人机验证求解失败：未找到有效挑战答案');
}

async function completeBunkerWebChallenge(site, fetchImpl, challengeInfo, cookieJar, options) {
  const challengeValue = solveHashPrefixChallenge(challengeInfo.seed, challengeInfo.prefix, options.signal);
  const formData = new URLSearchParams();

  for (const input of challengeInfo.hiddenInputs) {
    formData.set(input.name, input.value || '');
  }
  formData.set(challengeInfo.fieldName, challengeValue);

  const headers = new Headers(options.headers || {});
  headers.set('content-type', 'application/x-www-form-urlencoded');
  headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  headers.set('referer', challengeInfo.responseUrl);
  headers.delete('content-length');

  const response = await fetchImpl(
    challengeInfo.actionUrl,
    buildFetchRequestOptions(site, {
      ...options,
      method: 'POST',
      body: formData.toString(),
      headers
    }, cookieJar)
  );

  updateCookieJar(cookieJar, response);

  if (isRedirectResponse(response)) {
    return;
  }

  if (!isHtmlResponse(response) && response.ok) {
    return;
  }

  const rawResponse = await response.text();
  throw createFetchError('BunkerWeb 人机验证提交失败，代理未能通过验证', {
    statusCode: response.status,
    rawResponse
  });
}

async function inspectHtmlResponse(response, currentUrl) {
  const rawResponse = await response.text();
  const responseUrl = getResponseUrl(response, currentUrl);
  const bunkerWebInfo = extractBunkerWebChallenge(rawResponse, responseUrl);

  if (!bunkerWebInfo) {
    return {
      kind: 'response',
      response: new Response(rawResponse, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    };
  }

  if (bunkerWebInfo.kind === 'challenge') {
    return {
      kind: 'challenge',
      challengeInfo: bunkerWebInfo
    };
  }

  throw createFetchError('站点启用了 BunkerWeb 人机验证，当前代理未通过验证', {
    statusCode: response.status,
    rawResponse
  });
}

async function siteFetch(site, url, options = {}, extra = {}) {
  const fetchImpl = extra.fetchImpl || fetch;
  const maxRedirects = extra.maxRedirects || DEFAULT_MAX_REDIRECTS;
  const maxChallengeAttempts = extra.maxChallengeAttempts || DEFAULT_MAX_CHALLENGE_ATTEMPTS;
  const originalUrl = String(url);
  const originalOptions = { ...options };
  const cookieJar = seedCookieJar(originalOptions.headers);

  let currentUrl = originalUrl;
  let currentOptions = { ...originalOptions };
  let redirectCount = 0;
  let challengeCount = 0;

  while (true) {
    assertNotAborted(currentOptions.signal);

    const response = await fetchImpl(currentUrl, buildFetchRequestOptions(site, currentOptions, cookieJar));
    updateCookieJar(cookieJar, response);

    if (isRedirectResponse(response)) {
      if (redirectCount >= maxRedirects) {
        throw createFetchError('请求重定向次数过多，已停止访问', { statusCode: response.status });
      }

      const nextUrl = getRedirectTarget(response, currentUrl);
      if (!nextUrl) {
        return response;
      }

      redirectCount += 1;
      currentOptions = getRedirectedOptions(currentOptions, response, currentUrl, nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (isHtmlResponse(response) || response.status >= 400) {
      const inspected = await inspectHtmlResponse(response, currentUrl);

      if (inspected.kind === 'response') {
        return inspected.response;
      }

      if (challengeCount >= maxChallengeAttempts) {
        throw createFetchError('BunkerWeb 人机验证次数过多，代理未能完成校验', {
          statusCode: response.status,
          rawResponse: inspected.challengeInfo.html
        });
      }

      challengeCount += 1;
      await completeBunkerWebChallenge(site, fetchImpl, inspected.challengeInfo, cookieJar, currentOptions);
      currentUrl = originalUrl;
      currentOptions = { ...originalOptions };
      redirectCount = 0;
      continue;
    }

    return response;
  }
}

module.exports = {
  SUPPORTED_PROXY_PROTOCOLS,
  normalizeProxyUrl,
  parseProxyUrl,
  resolveSiteProxyUrl,
  buildSiteFetchOptions,
  siteFetch,
  createValidationError
};
