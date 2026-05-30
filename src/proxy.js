'use strict';

/**
 * 代理转发模块 — 将 /v1/* 请求路由到上游 API
 *
 * 职责：
 *   1. 接收原始请求 Buffer
 *   2. 调用路由引擎选择 deployment
 *   3. Model Override / Header 清洗 / URL 重写
 *   4. 调用 capture 记录请求
 *   5. 原生 fetch 转发（SSE 双写 + 背压）
 *   6. Token 提取（SSE message_start / message_delta，非 SSE usage）
 *   7. 错误上报 healthChecker
 */

const express = require('express');
const { startRecord, endRecord } = require('./capture');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 请求头清洗列表（参考 node-http-proxy + LiteLLM clean_headers）
const REQ_STRIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'content-encoding',
  'accept-encoding', 'x-api-key', 'authorization',
  'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade',
  // 浏览器专用头（不应转发给 API）
  'keep-alive', 'te', 'trailers', 'upgrade-insecure-requests',
  'x-requested-with', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'cookie', 'origin', 'referer',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
]);

// 响应头清洗列表
const RES_STRIP_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection',
  'alt-svc', 'server', 'via',
]);

// 内存捕获上限（4MB）
const CAPTURE_LIMIT = 4 * 1024 * 1024;
// 超时配置（参考 LiteLLM proxy_cli.py）
const TIMEOUT_CONNECT = 30_000;    // 连接超时 30s
const TIMEOUT_STREAM_IDLE = 60_000; // SSE chunk 间隔超时 60s
const TIMEOUT_DRAIN = 30_000;       // 背压 drain 超时 30s

// ---------------------------------------------------------------------------
// Token 提取器（SSE 流）
// ---------------------------------------------------------------------------

/**
 * 从 SSE 文本行中提取 token 用量
 * 解析 message_start → input_tokens / cache_read_input_tokens / cache_creation_input_tokens
 * 解析 message_delta → output_tokens
 *
 * @param {string} line - SSE data 行内容（不含 "data: " 前缀）
 * @returns {Object|null} 提取到的 token 字段，或 null
 */
function extractTokensFromSSELine(line) {
  if (!line || line === '[DONE]') return null;

  try {
    const evt = JSON.parse(line);

    // message_start 事件包含 input token 信息
    if (evt.type === 'message_start' && evt.message?.usage) {
      const u = evt.message.usage;
      return {
        inputTokens: u.input_tokens ?? null,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
        cacheCreationTokens: u.cache_creation_input_tokens ?? null,
      };
    }

    // message_delta 事件包含 output token 信息
    if (evt.type === 'message_delta' && evt.usage) {
      return {
        outputTokens: evt.usage.output_tokens ?? null,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 从非 SSE JSON 响应体提取 token 用量
 * @param {Buffer|string} body
 * @returns {Object|null}
 */
function extractTokensFromJSON(body) {
  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString('utf8'));
    const u = obj?.usage;
    if (!u) return null;
    return {
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      cacheReadTokens: u.cache_read_input_tokens ?? null,
      cacheCreationTokens: u.cache_creation_input_tokens ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Header 清洗
// ---------------------------------------------------------------------------

/**
 * 清洗请求头，移除不应转发的头
 * @param {Object} headers - Express req.headers
 * @returns {Object} 清洗后的头
 */
function cleanRequestHeaders(headers) {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!REQ_STRIP_HEADERS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * 清洗响应头
 * @param {Headers} upstreamHeaders - fetch Response headers
 * @returns {Object} 清洗后的头键值对
 */
function cleanResponseHeaders(upstreamHeaders) {
  const cleaned = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    if (!RES_STRIP_HEADERS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// SSE 双写流
// ---------------------------------------------------------------------------

/**
 * SSE 流处理：同时写入客户端响应 + 内存捕获缓冲区
 * 带背压处理（res.write 返回 false 时等 drain）
 *
 * @param {ReadableStreamDefaultReader} reader - 上游 body reader
 * @param {import('http').ServerResponse} res - 客户端响应
 * @param {Function} onChunk - 每个 chunk 的回调 (chunk: Uint8Array) => void
 * @returns {Promise<{ captured: Buffer }>}
 */
async function pipeSSE(reader, res, onChunk) {
  const chunks = [];
  let capturedSize = 0;
  let captureOverflow = false;

  // chunk 空闲超时检查
  let lastChunkTime = Date.now();
  const idleChecker = setInterval(() => {
    if (Date.now() - lastChunkTime > TIMEOUT_STREAM_IDLE) {
      // 空闲超时，中断流
      try { reader.cancel(); } catch { /* ignore */ }
    }
  }, 5000);

  try {
    while (true) {
      // 检查客户端是否已断开（参考 node-http-proxy）
      if (res.destroyed || res.writableEnded) break;

      const { done, value } = await reader.read();
      if (done) break;

      lastChunkTime = Date.now();

      // 内存捕获（4MB 上限）
      if (!captureOverflow) {
        if (capturedSize + value.length <= CAPTURE_LIMIT) {
          chunks.push(value);
          capturedSize += value.length;
        } else {
          captureOverflow = true;
        }
      }

      // 回调（SSE 行解析 / token 提取）
      if (onChunk) onChunk(value);

      // 检查连接是否仍然存活（参考 Anthropic SDK finally 模式）
      if (res.destroyed || res.writableEnded) break;

      // 写入客户端 + 背压（带 drain 超时保护）
      const ok = res.write(value);
      if (!ok) {
        await Promise.race([
          new Promise((resolve) => res.once('drain', resolve)),
          new Promise((resolve) => setTimeout(resolve, TIMEOUT_DRAIN)),
        ]);
        if (res.destroyed) break;
      }
    }
  } finally {
    clearInterval(idleChecker);
    if (!res.writableEnded && !res.destroyed) res.end();
  }

  const captured = chunks.length > 0 ? Buffer.concat(chunks) : null;
  return { captured };
}

// ---------------------------------------------------------------------------
// 创建代理 Router
// ---------------------------------------------------------------------------

/**
 * 创建代理转发 Express Router
 *
 * @param {Object} config - 配置模块 (require('./config'))
 * @param {Object} routerEngine - 路由引擎实例，需提供 selectDeployment() 方法
 * @param {Object} [healthChecker] - 健康检查器，需提供 reportFailure() 方法
 * @returns {import('express').Router}
 */
function createProxy(config, routerEngine, healthChecker) {
  const router = express.Router({ mergeParams: true });

  // 所有 /v1/* 路径走这个中间件
  router.use(
    '/v1',
    express.raw({ type: '*/*', limit: '25mb' }),
    async (req, res) => {
      // ------------------------------------------------------------------
      // 1. 解析请求体中的 model
      // ------------------------------------------------------------------
      let bodyBuf = req.body; // express.raw 解析后的 Buffer
      let bodyObj = null;

      if (bodyBuf && Buffer.isBuffer(bodyBuf) && bodyBuf.length > 0) {
        try {
          bodyObj = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          // 非 JSON 请求体，保持原样转发
        }
      }

      const model = bodyObj?.model || null;

      // ------------------------------------------------------------------
      // 2. 路由选择
      // ------------------------------------------------------------------
      const deployment = routerEngine.selectDeployment(model);

      if (!deployment) {
        return res.status(503).json({
          type: 'error',
          error: {
            type: 'no_available_deployment',
            message: '没有可用的 deployment',
          },
        });
      }

      // ------------------------------------------------------------------
      // 3. 解析 API Key
      // ------------------------------------------------------------------
      const apiKey = config.resolveApiKey(deployment.apiKey);

      // ------------------------------------------------------------------
      // 4. Model Override
      // ------------------------------------------------------------------
      let modelOverride = null;
      if (deployment.model && bodyObj && model && deployment.model !== model) {
        modelOverride = deployment.model;
        bodyObj.model = deployment.model;
        bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
      }

      // ------------------------------------------------------------------
      // 5. 开始记录
      // ------------------------------------------------------------------
      const record = startRecord({
        deploymentId: deployment.id,
        deploymentName: deployment.name,
        method: req.method,
        path: req.originalUrl || req.url,
        modelRequested: model,
        modelOverride,
        reqHeaders: cleanRequestHeaders(req.headers),
        reqBody: bodyBuf,
      });

      // ------------------------------------------------------------------
      // 6. Header 清洗 + 注入 x-api-key
      // ------------------------------------------------------------------
      const upstreamHeaders = cleanRequestHeaders(req.headers);
      upstreamHeaders['x-api-key'] = apiKey;
      // 确保有正确的 content-type
      if (bodyBuf && bodyBuf.length > 0 && !upstreamHeaders['content-type']) {
        upstreamHeaders['content-type'] = 'application/json';
      }

      // ------------------------------------------------------------------
      // 7. URL 重写：/v1/* → deployment.baseUrl + 原路径
      // ------------------------------------------------------------------
      const baseUrl = deployment.baseUrl.replace(/\/+$/, '');
      // req.originalUrl 形如 "/v1/messages"，保留 "/v1/..." 部分
      const upstreamUrl = baseUrl + (req.originalUrl || req.url);

      // ------------------------------------------------------------------
      // 8. AbortController（客户端断开时中止上游请求）
      //    参考 node-http-proxy：监听 aborted 事件 + close 兜底
      // ------------------------------------------------------------------
      const controller = new AbortController();

      // P0：连接超时保护（参考 LiteLLM 两级超时）
      const connectTimeout = setTimeout(() => controller.abort(), TIMEOUT_CONNECT);

      // P0：监听 aborted（客户端主动中断）+ close 兜底
      req.on('aborted', () => {
        clearTimeout(connectTimeout);
        controller.abort();
      });
      req.on('close', () => {
        clearTimeout(connectTimeout);
        if (!res.writableEnded && !res.finished) {
          controller.abort();
        }
      });

      // ------------------------------------------------------------------
      // 9. 发送到上游
      // ------------------------------------------------------------------
      let upstreamRes = null;
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: upstreamHeaders,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
          signal: controller.signal,
        });
      } catch (err) {
        // 网络错误 / abort
        const errMsg = err instanceof Error ? err.message : String(err);
        if (healthChecker) healthChecker.reportFailure(deployment.id, errMsg);
        endRecord(record.id, { status: 502, error: errMsg });
        if (!res.headersSent) {
          return res.status(502).json({
            type: 'error',
            error: { type: 'upstream_error', message: errMsg },
          });
        }
        return;
      }

      // ------------------------------------------------------------------
      // 10. 响应处理
      // ------------------------------------------------------------------

      // 上游返回非 2xx → 视为失败
      if (!upstreamRes.ok) {
        let errBody = null;
        try {
          errBody = await upstreamRes.text();
        } catch { /* ignore */ }

        const errMsg = `上游返回 ${upstreamRes.status}`;
        if (healthChecker) healthChecker.reportFailure(deployment.id, errMsg);
        endRecord(record.id, {
          status: upstreamRes.status,
          resHeaders: cleanResponseHeaders(upstreamRes.headers),
          resBody: errBody,
          error: errMsg,
        });

        if (!res.headersSent) {
          // 转发上游的错误响应
          res.status(upstreamRes.status);
          const resHeaders = cleanResponseHeaders(upstreamRes.headers);
          for (const [key, value] of Object.entries(resHeaders)) {
            res.setHeader(key, value);
          }
          if (errBody) res.write(errBody);
          res.end();
        }
        return;
      }

      // 清洗响应头
      const resHeaders = cleanResponseHeaders(upstreamRes.headers);
      const isSSE = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

      // 写状态码和头
      res.status(upstreamRes.status);
      for (const [key, value] of Object.entries(resHeaders)) {
        res.setHeader(key, value);
      }

      if (isSSE) {
        // --------------------------------------------------------------
        // SSE 流式处理
        // --------------------------------------------------------------
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // SSE 行缓冲：逐块拼接文本，按 \n 拆行，提取 token
        let lineBuf = '';
        let tokens = {};

        let sseError = null; // P1：捕获上游 SSE error 事件

        function processChunk(chunk) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : new TextDecoder().decode(chunk);
          lineBuf += text;

          // 按行拆分
          let idx;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);

            // 跳过 SSE 注释行（ping）
            if (line.startsWith(':')) continue;

            if (line.startsWith('event: ')) {
              const eventType = line.slice(7).trim();
              if (eventType === 'error') {
                // P1：标记 SSE error 事件（参考 Anthropic SDK）
                sseError = { type: 'sse_error', pending: true };
              }
              continue;
            }

            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              // 处理 SSE error 事件的 data
              if (sseError && sseError.pending) {
                sseError.pending = false;
                sseError.data = data;
                continue;
              }

              if (data === '[DONE]') continue; // P1：跳过 [DONE] 之后的尾部

              const extracted = extractTokensFromSSELine(data);
              if (extracted) {
                Object.assign(tokens, extracted);
              }
            }
          }
        }

        const reader = upstreamRes.body.getReader();
        let captured = null;

        try {
          const result = await pipeSSE(reader, res, processChunk);
          captured = result.captured;

          // P1：处理 SSE error 事件（参考 Anthropic SDK）
          if (sseError && !sseError.pending) {
            const errMsg = `SSE error: ${sseError.data}`;
            if (healthChecker) healthChecker.reportFailure(deployment.id, errMsg);
            endRecord(record.id, {
              status: upstreamRes.status,
              isStream: true,
              resBody: captured,
              error: errMsg,
              ...tokens,
            });
            return;
          }
        } catch (err) {
          // 流传输中途出错
          const errMsg = err instanceof Error ? err.message : String(err);
          if (healthChecker) healthChecker.reportFailure(deployment.id, errMsg);
          endRecord(record.id, {
            status: upstreamRes.status,
            isStream: true,
            resBody: captured,
            error: errMsg,
            ...tokens,
          });
          return;
        } finally {
          reader.releaseLock();
        }

        // 成功完成
        endRecord(record.id, {
          status: upstreamRes.status,
          resHeaders,
          resBody: captured,
          isStream: true,
          ...tokens,
        });
      } else {
        // --------------------------------------------------------------
        // 非 SSE：读取完整响应体
        // --------------------------------------------------------------
        let resBody = null;
        try {
          const buf = await upstreamRes.arrayBuffer();
          resBody = Buffer.from(buf);
        } catch { /* ignore */ }

        // 设置 content-length（如果有的话，让客户端知道长度）
        if (resBody) {
          res.setHeader('Content-Length', resBody.length);
        }
        res.end(resBody);

        // Token 提取
        const tokens = extractTokensFromJSON(resBody) || {};

        endRecord(record.id, {
          status: upstreamRes.status,
          resHeaders,
          resBody: resBody
            ? (resBody.length <= CAPTURE_LIMIT ? resBody : null)
            : null,
          isStream: false,
          ...tokens,
        });
      }
    }
  );

  return router;
}

module.exports = { createProxy };
