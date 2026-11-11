/**
 * 传输层错误类型。
 *
 * `code` 与协议 §10 错误码总表对齐，便于上层直接透传给设备或日志。
 */

export class WireError extends Error {
  /**
   * @param {string} code 协议错误码，见 §10
   * @param {string} message 人读原因
   * @param {{cause?: unknown, detail?: object}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WireError';
    this.code = code;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export const ERR = {
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  MSGID_EXHAUSTED: 'MSGID_EXHAUSTED',
  ACK_TIMEOUT: 'ACK_TIMEOUT',
  REASSEMBLY_GAP: 'REASSEMBLY_GAP',
  REASSEMBLY_OVERFLOW: 'REASSEMBLY_OVERFLOW',
  BAD_PAYLOAD: 'BAD_PAYLOAD',
  PROTO_MISMATCH: 'PROTO_MISMATCH',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  NOT_CONNECTED: 'NOT_CONNECTED',
};
