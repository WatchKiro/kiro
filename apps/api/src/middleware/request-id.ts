import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

const HEADER = 'X-Request-Id';
// Accept upstream ids (e.g. from a reverse proxy) only if they are short and log-safe.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(HEADER);
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(HEADER, req.id);
    next();
  };
}
