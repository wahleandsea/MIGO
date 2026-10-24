/** 带 HTTP 状态码的业务错误：抛出后由 server.js 转成 JSON 返回给网页。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
