const fetch = require('node-fetch');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { decrypt } = require('./crypto');

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
const agentCache = new Map();

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
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

async function siteFetch(site, url, options = {}, extra = {}) {
  const fetchImpl = extra.fetchImpl || fetch;
  return fetchImpl(url, buildSiteFetchOptions(site, options));
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
