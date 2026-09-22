// middleware/asyncErrors.js — DB-M1.
// Database access is asynchronous now, so route handlers and middleware are
// async functions. Express 4 only catches SYNCHRONOUS throws; a rejected promise
// would otherwise never reach the error handler. This forwards rejections to
// next(err), giving async handlers exactly the error behaviour sync ones had.
// (Express 5 does this natively; remove this file when upgrading.)
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__kaheAsyncPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) { next(err); }
    return undefined;
  };
  Layer.prototype.__kaheAsyncPatched = true;
}
