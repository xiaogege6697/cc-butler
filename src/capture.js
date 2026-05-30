const { EventEmitter } = require('events');

// 全局事件总线
const bus = new EventEmitter();
bus.setMaxListeners(100);

// 环形缓冲区
const MAX_RECORDS = 500;
const records = [];
let writeIndex = 0;

// O(1) 按 ID 查找
const byId = new Map();

let nextId = 1;

function startRecord({ deploymentId, deploymentName, method, path, modelRequested, modelOverride, reqHeaders, reqBody }) {
  const id = nextId++;
  const record = {
    id,
    startedAt: Date.now(),
    endedAt: null,
    deploymentId: deploymentId ?? null,
    deploymentName: deploymentName ?? null,
    method: method ?? null,
    path: path ?? null,
    modelRequested: modelRequested ?? null,
    modelServed: null,
    modelOverride: modelOverride ?? null,
    reqHeaders: reqHeaders ?? null,
    reqBody: reqBody ?? null,
    status: null,
    resHeaders: null,
    resBody: null,
    isStream: false,
    error: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };

  // 写入环形缓冲区
  if (records.length < MAX_RECORDS) {
    records.push(record);
    writeIndex = records.length;
  } else {
    // 覆盖最旧的记录，先清理 byId
    const old = records[writeIndex];
    if (old) byId.delete(old.id);
    records[writeIndex] = record;
    writeIndex = (writeIndex + 1) % MAX_RECORDS;
  }

  byId.set(id, record);
  bus.emit('request.start', record);

  return record;
}

function endRecord(id, { status, resHeaders, resBody, isStream, error, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = {}) {
  const record = byId.get(id);
  if (!record) return;

  record.endedAt = Date.now();
  if (status !== undefined) record.status = status;
  if (resHeaders !== undefined) record.resHeaders = resHeaders;
  if (resBody !== undefined) record.resBody = resBody;
  if (isStream !== undefined) record.isStream = isStream;
  if (error !== undefined) record.error = error;
  if (inputTokens !== undefined) record.inputTokens = inputTokens;
  if (outputTokens !== undefined) record.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) record.cacheCreationTokens = cacheCreationTokens;

  // 从响应体提取 modelServed（如果尚未设置）
  if (!record.modelServed && record.resBody) {
    try {
      const body = typeof record.resBody === 'string' ? JSON.parse(record.resBody) : record.resBody;
      record.modelServed = body.model ?? null;
    } catch {
      // 非 JSON 响应，忽略
    }
  }

  bus.emit('request.end', record);

  return record;
}

function getRecords(limit) {
  // 按时间倒序返回，最新的在前
  const sorted = records.slice().sort((a, b) => b.startedAt - a.startedAt);
  if (limit !== undefined) return sorted.slice(0, limit);
  return sorted;
}

function getRecord(id) {
  return byId.get(id) ?? null;
}

function clearRecords() {
  records.length = 0;
  writeIndex = 0;
  byId.clear();
  bus.emit('records.cleared');
}

module.exports = {
  bus,
  startRecord,
  endRecord,
  getRecords,
  getRecord,
  clearRecords,
};
